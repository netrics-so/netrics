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
        // 1 rem (16 points) is 32 units.
        #expect(ScrollGeometry.unit(rem: 16) == 0.5)
    }

    @Test func cardUnitsFollowTheTextSize() {
        // web cardUnits: (width − 2 × 16 − 2) × 32 / root px.
        #expect(ScrollGeometry.cardUnits(width: 366, rem: 16) == 664)
        // Dynamic Type at twice the size halves the room in units, so values fit smaller sooner.
        #expect(ScrollGeometry.cardUnits(width: 366, rem: 32) == 332)
        #expect(ScrollGeometry.cardUnits(width: 20, rem: 16) == 0)
    }

    @Test func valuesShrinkThenGoCompactAsOnTheWeb() {
        let wide = ScrollGeometry.value(full: "1,234", compact: "1.2K", units: 664)
        #expect(wide == StudioRender.FittedValue(text: "1,234", size: ScrollGeometry.TypeSize.valueMax))
        let long = "€1,234,567,890.12"
        let narrow = ScrollGeometry.value(full: long, compact: "€1.2B", units: 300)
        #expect(narrow.text == "€1.2B")
        #expect(narrow.size >= ScrollGeometry.TypeSize.valueMin)
        #expect(narrow.size <= ScrollGeometry.TypeSize.valueMax)
        // Between the bounds, the full text at the size that fits.
        let width = StudioLayout.estimateTextWidth(long, fontSize: 1, weight: .semibold)
        let fitted = ScrollGeometry.value(full: long, compact: "€1.2B", units: width * 60)
        #expect(fitted.text == long)
        #expect(abs(fitted.size - 60) < 1e-9)
    }

    @Test func clockAndCountdownSizes() {
        #expect(ScrollGeometry.clockSize(time: "14:05", units: 664) == ScrollGeometry.TypeSize.clock)
        #expect(ScrollGeometry.clockSize(time: "2:05 PM", units: 50) == ScrollGeometry.TypeSize.valueMin)
        // The size does not change with the digits.
        #expect(
            ScrollGeometry.clockSize(time: "11:11", units: 150) == ScrollGeometry.clockSize(time: "00:00", units: 150))
        let groups = [CountdownShownGroup(value: "12", unit: "d"), CountdownShownGroup(value: "04", unit: "h")]
        let roomy = ScrollGeometry.countdownSizes(groups, units: 664)
        #expect(roomy.value == ScrollGeometry.TypeSize.valueMax)
        // A third of 72 is below the change size: the letters stay at 26.
        #expect(roomy.unit == ScrollGeometry.TypeSize.change)
        let tight = ScrollGeometry.countdownSizes(groups, units: 10)
        #expect(tight.value == ScrollGeometry.TypeSize.valueMin)
        #expect(tight.unit == ScrollGeometry.TypeSize.change)
    }

    @Test func goalRingAsTheWeb() {
        // At most 240 units, at least the ring minimum; the stroke a tenth, at least 16.
        let ring = ScrollGeometry.ring(units: 664, suffix: nil)
        #expect(ring.diameter == 240)
        #expect(ring.stroke == 24)
        #expect(abs(ring.room - (240 - 48) * StudioLayout.GaugeSpacing.valueWidthShare) < 1e-9)
        let small = ScrollGeometry.ring(units: 100, suffix: "%")
        #expect(small.diameter == StudioLayout.GaugeSpacing.ringMin)
        #expect(small.stroke == 16)
        #expect(small.room < (160 - 32) * StudioLayout.GaugeSpacing.valueWidthShare)
        // The full value while it fits at the value minimum, else the compact one.
        let roomy = ScrollGeometry.ringValue(full: "1,500", compact: "1.5K", room: ring.room)
        #expect(roomy.text == "1,500")
        let tight = ScrollGeometry.ringValue(full: "€1,234,567", compact: "€1.2M", room: 100)
        #expect(tight.text == "€1.2M")
        #expect(tight.size >= ScrollGeometry.TypeSize.small)
    }

    @Test func tablesStackOnlyAtTheLargestTextSizes() {
        let values = ["8,120", "512", "2,015"]
        let changes = ["+12%", "−15%", "new"]
        // An iPhone card (378 points) at the default size keeps the columns…
        #expect(!ScrollGeometry.tableStacks(values: values, changes: changes, units: ScrollGeometry.cardUnits(width: 378, rem: 16)))
        // …and at the largest accessibility size (about 53 points per rem) stacks the rows.
        #expect(ScrollGeometry.tableStacks(values: values, changes: changes, units: ScrollGeometry.cardUnits(width: 378, rem: 53)))
    }
}
