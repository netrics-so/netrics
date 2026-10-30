import Foundation
import NetricsKit
import Testing

@testable import NetricsUI

// The scroll view renderer (ADR 0017 section 5) on the shared vectors
// (packages/domain/test-vectors/screen-formats.json, `pnpm vectors:formats`):
// payload slides become sections in the web's order, rows and columns, and
// the sizes follow apps/web/src/lib/scroll-view.ts.

private enum Vectors {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // NetricsUITests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // NetricsKit
        .deletingLastPathComponent()  // netrics-tv
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("packages/domain/test-vectors/screen-formats.json")

    static var slides: [[String: Any]] {
        let data = try! Data(contentsOf: url)
        return (try! JSONSerialization.jsonObject(with: data) as! [String: Any])["slides"] as! [[String: Any]]
    }
}

/** A vector slide as a payload slide: its widgets with their primary placements, no data. */
private func payloadSlide(_ vector: [String: Any]) throws -> DeviceSlide {
    let widgets = (vector["widgets"] as! [[String: Any]]).map { widget -> [String: Any] in
        var widget = widget
        widget["label"] = NSNull()
        return widget
    }
    let slide: [String: Any] = [
        "id": vector["name"] as! String, "name": NSNull(), "durationSec": 20, "background": NSNull(),
        "widgets": widgets, "layouts": [],
    ]
    return try JSONDecoder().decode(DeviceSlide.self, from: JSONSerialization.data(withJSONObject: slide))
}

private func number(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }

@Suite struct ScrollViewRendererTests {
    @Test func sectionsFollowTheWebsOrderAndColumns() throws {
        let vectors = Vectors.slides
        #expect(vectors.count > 10)
        for vector in vectors {
            let slide = try payloadSlide(vector)
            #expect(slide.widgets.count == (vector["widgets"] as! [Any]).count)
            for expected in vector["scroll"] as! [[String: Any]] {
                let width = number(expected["width"])
                let context = "\(vector["name"]!) at \(width)"
                let sections = ScrollGeometry.sections([slide], width: width)
                let layout = try #require(sections.first?.layout)
                #expect(layout.columns == Int(number(expected["columns"])), "\(context)")
                let contentWidth = number(expected["contentWidth"])
                #expect(abs(layout.contentWidth - contentWidth) < 1e-9, "\(context)")
                let items = expected["items"] as! [[String: Any]]
                #expect(layout.items.map(\.id) == items.map { $0["id"] as! String }, "\(context): order")
                #expect(layout.items.map(\.row) == items.map { Int(number($0["row"])) }, "\(context): rows")
                #expect(layout.items.map(\.column) == items.map { Int(number($0["column"])) }, "\(context): columns")
                #expect(layout.items.map(\.span) == items.map { Int(number($0["span"])) }, "\(context): spans")
                #expect(
                    layout.items.map(\.height.rawValue) == items.map { $0["height"] as! String }, "\(context): heights")

                // The rows the view stacks keep the reading order, left to right.
                let rows = ScrollGeometry.rows(layout)
                #expect(rows.flatMap { $0 } == layout.items, "\(context): rows in order")
                let grid: Double = layout.contentWidth - 2 * ScrollGeometry.sectionPadding
                for row in rows {
                    #expect(Set(row.map(\.row)).count == 1, "\(context)")
                    #expect(row.map(\.column) == row.map(\.column).sorted(), "\(context)")
                    for item in row {
                        // Inside the grid; a full-width item takes the whole grid.
                        let x: Double = ScrollGeometry.itemX(layout, column: item.column)
                        let width: Double = ScrollGeometry.itemWidth(layout, span: item.span)
                        let right = x + width
                        #expect(right <= grid + 1e-9, "\(context): \(item.id)")
                        if item.span == layout.columns {
                            #expect(abs(width - grid) < 1e-9)
                        }
                    }
                }
            }
        }
    }

    @Test func sectionsKeepTheSlidesAndTheirPositions() throws {
        let vectors = Vectors.slides
        let slides = try vectors.prefix(3).map(payloadSlide)
        let sections = ScrollGeometry.sections(slides, width: 390)
        #expect(sections.map(\.slide.id) == slides.map(\.id))
        #expect(sections.map(\.index) == [0, 1, 2])
    }

    @Test func itemWidthsAsTheWeb() {
        // scrollItemWidth: (content − 2 × 12 − 12 × (columns − 1)) / columns per column.
        let layout = ScreenLayout.scrollLayout([], width: 1024)
        #expect(layout.columns == 3)
        let column: Double = (1024 - 24 - 24) / 3
        #expect(ScrollGeometry.columnWidth(layout) == column)
        #expect(ScrollGeometry.itemWidth(layout, span: 3) == 1000)
        let third: Double = 2 * (column + 12)
        #expect(ScrollGeometry.itemX(layout, column: 2) == third)
        let phone = ScreenLayout.scrollLayout([], width: 390)
        #expect(ScrollGeometry.itemWidth(phone, span: 1) == 366)
    }

    @Test func heightRules() {
        // scrollChartHeight: 16:9, at least 200, at most 360 (#298).
        #expect(ScrollGeometry.chartHeight(width: 300) == 200)
        #expect(ScrollGeometry.chartHeight(width: 480) == 270)
        #expect(ScrollGeometry.chartHeight(width: 481) == 271)
        #expect(ScrollGeometry.chartHeight(width: 1000) == 360)
        // Images keep their aspect, at most half the viewport.
        #expect(ScrollGeometry.imageHeight(width: 400, aspect: 2, viewportHeight: 800) == 200)
        #expect(ScrollGeometry.imageHeight(width: 400, aspect: 0.5, viewportHeight: 800) == 400)
        #expect(ScrollGeometry.imageHeight(width: 400, aspect: 0.25, viewportHeight: 800) == 400)
        // Other cards are as many units high as their primary box: 3 of 8 rows at 16:9.
        let frame = StudioLayout.screenFrame(
            screen: ScreenFormat.widescreen.spec.reference, format: .widescreen, showHeader: true)
        let rows = StudioLayout.placementRect(StudioPlacement(x: 0, y: 0, w: 4, h: 3), frame: frame).height
        let metric = ScrollGeometry.contentHeight(
            placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), primaryFormat: .widescreen, showHeader: true, unit: 0.5)
        #expect(abs(metric - rows / 2) < 1e-9)
        #expect(metric > 150)
        #expect(metric < 200)
        // 1 rem (16 points) is 32 units.
        #expect(ScrollGeometry.unit(rem: 16) == 0.5)
    }
}
