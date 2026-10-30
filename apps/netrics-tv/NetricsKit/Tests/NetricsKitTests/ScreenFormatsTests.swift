import Foundation
import Testing

@testable import NetricsKit

// Runs the vectors the TypeScript generates
// (packages/domain/test-vectors/screen-formats.json, `pnpm vectors:formats`),
// read straight from the repository, so web and tvOS reflow slides alike.

enum FormatVectors {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // NetricsKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // NetricsKit
        .deletingLastPathComponent()  // tvos
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("packages/domain/test-vectors/screen-formats.json")

    /** Read on each use: [String: Any] is not Sendable, so it is not cached. */
    static var root: [String: Any] {
        let data = try! Data(contentsOf: url)
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func cases(_ key: String) -> [[String: Any]] {
        root[key] as! [[String: Any]]
    }
}

private func double(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }
private func bool(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }

/** A whole number from the vectors; fails the test on a fraction. */
private func int(_ any: Any?) -> Int {
    let value = (any as! NSNumber).doubleValue
    #expect(value.rounded() == value, "not a whole number: \(value)")
    return Int(value)
}

private func string(_ any: Any?) -> String { any as! String }
private func format(_ any: Any?) -> ScreenFormat { ScreenFormat(rawValue: string(any))! }

private func canvas(_ any: Any?) -> StudioCanvas {
    let c = any as! [String: Any]
    return StudioCanvas(width: double(c["width"]), height: double(c["height"]))
}

private func placement(_ any: Any?) -> StudioPlacement {
    let p = any as! [String: Any]
    return StudioPlacement(x: int(p["x"]), y: int(p["y"]), w: int(p["w"]), h: int(p["h"]))
}

private func widgets(_ any: Any?) -> [LayoutWidget] {
    (any as! [[String: Any]]).map {
        let minimum = ($0["min"] as? [String: Any]).map { StudioMinimum(w: int($0["w"]), h: int($0["h"])) }
        return LayoutWidget(
            id: string($0["id"]), type: StudioWidgetType(rawValue: string($0["type"]))!,
            x: int($0["x"]), y: int($0["y"]), w: int($0["w"]), h: int($0["h"]), minimum: minimum)
    }
}

private func layoutPlacements(_ any: Any?) -> [LayoutPlacement] {
    (any as! [[String: Any]]).map {
        LayoutPlacement(id: string($0["id"]), x: int($0["x"]), y: int($0["y"]), w: int($0["w"]), h: int($0["h"]))
    }
}

private func customLayout(_ any: Any?) -> CustomLayout {
    let c = any as! [String: Any]
    return CustomLayout(
        pages: int(c["pages"]),
        placements: (c["placements"] as! [[String: Any]]).map {
            CustomPlacement(
                id: string($0["id"]), page: int($0["page"]), x: int($0["x"]), y: int($0["y"]),
                w: int($0["w"]), h: int($0["h"]), hidden: bool($0["hidden"]), autoPlaced: bool($0["autoPlaced"]))
        })
}

private func problems(_ any: Any?) -> [CustomLayoutProblem] {
    (any as! [[String: Any]]).map {
        CustomLayoutProblem(
            code: CustomLayoutProblemCode(rawValue: string($0["code"]))!,
            widgetId: $0["widgetId"] is NSNull ? nil : string($0["widgetId"]))
    }
}

private func close(_ a: Double, _ b: Double) -> Bool {
    abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
}

private func expectRect(_ rect: StudioRect, _ expected: Any?, _ context: String) {
    let e = expected as! [String: Any]
    #expect(close(rect.x, double(e["x"])), "\(context) x")
    #expect(close(rect.y, double(e["y"])), "\(context) y")
    #expect(close(rect.width, double(e["width"])), "\(context) width")
    #expect(close(rect.height, double(e["height"])), "\(context) height")
}

@Suite struct ScreenFormatVectorTests {
    @Test func vectorsAreThere() {
        #expect(FileManager.default.fileExists(atPath: FormatVectors.url.path))
        #expect(FormatVectors.cases("slides").count >= 10)
        #expect(FormatVectors.cases("sync").count >= 12)
    }

    @Test func formatTable() {
        let formats = FormatVectors.cases("formats")
        #expect(formats.map { string($0["key"]) } == ScreenFormat.allCases.map(\.rawValue))
        for c in formats {
            let spec = format(c["key"]).spec
            #expect(spec.columns == int(c["columns"]))
            #expect(spec.rows == int(c["rows"]))
            #expect(spec.reference == canvas(c["reference"]))
        }
    }

    @Test func formatAndSizeClass() {
        for c in FormatVectors.cases("formatFor") {
            let width = double(c["width"])
            let height = double(c["height"])
            #expect(StudioLayout.formatFor(width: width, height: height) == format(c["format"]), "\(c)")
            #expect(
                StudioLayout.sizeClassFor(width: width, height: height).rawValue == string(c["sizeClass"]), "\(c)")
        }
    }

    @Test func frames() {
        for c in FormatVectors.cases("frames") {
            let frame = StudioLayout.screenFrame(
                screen: canvas(c["screen"]), format: format(c["format"]), showHeader: bool(c["showHeader"]))
            let e = c["frame"] as! [String: Any]
            #expect(frame.format == format(e["format"]))
            #expect(frame.columns == int(e["columns"]))
            #expect(frame.rows == int(e["rows"]))
            #expect(close(frame.unit, double(e["unit"])), "\(c) unit")
            expectRect(frame.canvas, e["canvas"], "\(c) canvas")
            if e["header"] is NSNull {
                #expect(frame.header == nil)
            } else {
                expectRect(frame.header!, e["header"], "\(c) header")
            }
            expectRect(frame.grid, e["grid"], "\(c) grid")
        }
    }

    @Test func rects() {
        for c in FormatVectors.cases("rects") {
            let frame = StudioLayout.screenFrame(
                screen: canvas(c["screen"]), format: format(c["format"]), showHeader: bool(c["showHeader"]))
            expectRect(StudioLayout.placementRect(placement(c["placement"]), frame: frame), c["rect"], "\(c)")
        }
    }

    @Test func labelFits() {
        for c in FormatVectors.cases("labelFits") {
            let fit = StudioLayout.labelFit(
                string(c["label"]), type: StudioWidgetType(rawValue: string(c["type"]))!, w: int(c["w"]),
                h: int(c["h"]), fontScale: double(c["fontScale"]), format: format(c["format"]))
            #expect(fit.fits == bool(c["fits"]), "\(c)")
            #expect(fit.titleLines == int(c["titleLines"]), "\(c)")
            #expect(fit.resourceLines == int(c["resourceLines"]), "\(c)")
        }
    }

    @Test func displayModes() {
        for c in FormatVectors.cases("displayModes") {
            let mode = ScreenLayout.defaultDisplayMode(
                kind: ScreenKind(rawValue: string(c["kind"]))!,
                sizeClass: ScreenSizeClass(rawValue: string(c["sizeClass"]))!,
                coarsePointer: bool(c["coarsePointer"]),
                deviceMode: c["deviceMode"] is NSNull ? nil : DisplayMode(rawValue: string(c["deviceMode"]))!)
            #expect(mode.rawValue == string(c["mode"]), "\(c)")
        }
    }

    @Test func readingOrder() {
        for c in FormatVectors.cases("slides") {
            let order = ScreenLayout.studioReadingOrder(widgets(c["widgets"])).map(\.id)
            #expect(order == (c["readingOrder"] as! [String]), "\(c["name"]!)")
        }
    }

    @Test func reflow() {
        for c in FormatVectors.cases("slides") {
            let slide = widgets(c["widgets"])
            let from = format(c["format"])
            let expected = c["reflow"] as! [String: Any]
            #expect(expected.count == ScreenFormat.allCases.count)
            for to in ScreenFormat.allCases {
                let pages = ScreenLayout.reflowSlide(slide, from: from, to: to)
                let want = (expected[to.rawValue] as! [Any]).map(layoutPlacements)
                #expect(pages == want, "\(c["name"]!) \(from.rawValue) → \(to.rawValue)")
                // Without a custom layout, a format shows the reflow.
                #expect(
                    ScreenLayout.slideLayoutFor(widgets: slide, primaryFormat: from, format: to, custom: nil) == want)
            }
        }
    }

    @Test func scroll() {
        for c in FormatVectors.cases("slides") {
            let slide = widgets(c["widgets"])
            for s in c["scroll"] as! [[String: Any]] {
                let layout = ScreenLayout.scrollLayout(slide, width: double(s["width"]))
                let context = "\(c["name"]!) at \(s["width"]!)"
                #expect(layout.columns == int(s["columns"]), "\(context)")
                #expect(ScreenLayout.scrollColumns(double(s["width"])) == int(s["columns"]))
                #expect(close(layout.contentWidth, double(s["contentWidth"])), "\(context)")
                let items = (s["items"] as! [[String: Any]]).map {
                    ScrollItem(
                        id: string($0["id"]), type: StudioWidgetType(rawValue: string($0["type"]))!,
                        row: int($0["row"]), column: int($0["column"]), span: int($0["span"]),
                        height: ScrollItemHeight(rawValue: string($0["height"]))!)
                }
                #expect(layout.items == items, "\(context)")
            }
        }
    }

    @Test func sync() {
        for c in FormatVectors.cases("sync") {
            let slide = widgets(c["widgets"])
            let custom = customLayout(c["custom"])
            let target = format(c["format"])
            let name = string(c["name"])
            #expect(
                ScreenLayout.validateCustomLayout(custom, widgets: slide, format: target) == problems(c["problems"]),
                "\(name)")
            let completed = ScreenLayout.completeCustomLayout(
                custom, primaryFormat: format(c["primaryFormat"]), primaryWidgets: slide, format: target)
            #expect(completed == customLayout(c["completed"]), "\(name)")
            // A completed layout is always valid for the primary's widgets.
            #expect(ScreenLayout.validateCustomLayout(completed, widgets: slide, format: target).isEmpty, "\(name)")
        }
    }

    @Test func validation() {
        for c in FormatVectors.cases("validation") {
            let problemsFound = ScreenLayout.validateCustomLayout(
                customLayout(c["custom"]), widgets: widgets(c["widgets"]), format: format(c["format"]))
            #expect(problemsFound == problems(c["problems"]), "\(string(c["name"]))")
        }
    }
}

@Suite struct ScreenLayoutTests {
    @Test func widescreenFrameIsTheStudioFrame() {
        let screen = StudioCanvas(width: 1920, height: 1080)
        for showHeader in [true, false] {
            let frame = StudioLayout.screenFrame(screen: screen, format: .widescreen, showHeader: showHeader)
            let studio = StudioLayout.frame(canvas: screen, showHeader: showHeader)
            #expect(frame.grid == studio.grid)
            #expect(frame.header == studio.header)
            let p = StudioPlacement(x: 3, y: 2, w: 4, h: 3)
            #expect(
                StudioLayout.placementRect(p, frame: frame)
                    == StudioLayout.widgetRect(p, canvas: screen, showHeader: showHeader))
        }
    }

    @Test func slideLayoutForUsesTheCustomLayout() {
        let slide = [
            LayoutWidget(id: "a", type: .metric, x: 0, y: 0, w: 6, h: 4),
            LayoutWidget(id: "b", type: .text, x: 6, y: 0, w: 6, h: 4),
            LayoutWidget(id: "c", type: .clock, x: 0, y: 4, w: 12, h: 4),
        ]
        let custom = CustomLayout(
            pages: 3,
            placements: [
                CustomPlacement(id: "b", page: 0, x: 0, y: 5, w: 6, h: 2, hidden: false, autoPlaced: false),
                CustomPlacement(id: "a", page: 0, x: 0, y: 0, w: 6, h: 4, hidden: false, autoPlaced: false),
                CustomPlacement(id: "c", page: 1, x: 0, y: 0, w: 6, h: 2, hidden: true, autoPlaced: false),
            ])
        let pages = ScreenLayout.slideLayoutFor(widgets: slide, primaryFormat: .widescreen, format: .portrait, custom: custom)
        // Reading order within a page, hidden widgets left out, empty pages kept.
        #expect(pages.map { $0.map(\.id) } == [["a", "b"], [], []])
        // The primary format ignores a custom layout.
        #expect(
            ScreenLayout.slideLayoutFor(widgets: slide, primaryFormat: .widescreen, format: .widescreen, custom: custom)
                == ScreenLayout.reflowSlide(slide, from: .widescreen, to: .widescreen))
    }

    @Test func roundingIsHalfUp() {
        #expect(ScreenLayout.roundHalfUp(2.5) == 3)
        #expect(ScreenLayout.roundHalfUp(-2.5) == -2)
        // 3 of 12 columns at 6 is 1.5 → 2; 9 of 12 at 6 is 4.5 → 5.
        #expect(ScreenLayout.scaleEdge(3, from: 12, to: 6) == 2)
        #expect(ScreenLayout.scaleEdge(9, from: 12, to: 6) == 5)
    }
}
