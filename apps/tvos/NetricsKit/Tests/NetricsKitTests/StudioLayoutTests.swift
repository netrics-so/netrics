import Foundation
import Testing

@testable import NetricsKit

// Runs the vectors the TypeScript generates
// (packages/domain/test-vectors/studio-layout.json, `pnpm vectors:studio`),
// read straight from the repository, so web and tvOS lay out slides alike.

enum StudioVectors {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // NetricsKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // NetricsKit
        .deletingLastPathComponent()  // tvos
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("packages/domain/test-vectors/studio-layout.json")

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
private func int(_ any: Any?) -> Int { (any as! NSNumber).intValue }
private func bool(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }

private func placement(_ any: Any?) -> StudioPlacement {
    let p = any as! [String: Any]
    return StudioPlacement(x: int(p["x"]), y: int(p["y"]), w: int(p["w"]), h: int(p["h"]))
}

private func canvas(_ any: Any?) -> StudioCanvas {
    let c = any as! [String: Any]
    return StudioCanvas(width: double(c["width"]), height: double(c["height"]))
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

private func spans(_ any: Any?) -> [StudioTextSpan] {
    (any as! [[String: Any]]).map {
        StudioTextSpan(text: $0["text"] as! String, bold: bool($0["bold"]), italic: bool($0["italic"]))
    }
}

private func weight(_ any: Any?) -> StudioFontWeight {
    StudioFontWeight(rawValue: any as! String)!
}

@Suite struct StudioLayoutVectorTests {
    @Test func vectorsAreThere() {
        #expect(FileManager.default.fileExists(atPath: StudioVectors.url.path))
        #expect(!StudioVectors.cases("rects").isEmpty)
    }

    @Test func minimumWidgetSizes() {
        let sizes = StudioVectors.root["minimumWidgetSizes"] as! [String: [String: Any]]
        #expect(sizes.count == StudioWidgetType.allCases.count)
        for type in StudioWidgetType.allCases {
            let expected = sizes[type.rawValue]!
            #expect(StudioLayout.minimumSize(type).w == int(expected["w"]))
            #expect(StudioLayout.minimumSize(type).h == int(expected["h"]))
        }
    }

    @Test func frames() {
        for c in StudioVectors.cases("frames") {
            let frame = StudioLayout.frame(canvas: canvas(c["canvas"]), showHeader: bool(c["showHeader"]))
            #expect(close(frame.unit, double(c["unit"])))
            if c["header"] is NSNull {
                #expect(frame.header == nil)
            } else {
                expectRect(frame.header!, c["header"], "header")
            }
            expectRect(frame.grid, c["grid"], "grid")
        }
    }

    @Test func rects() {
        for c in StudioVectors.cases("rects") {
            let rect = StudioLayout.widgetRect(
                placement(c["placement"]), canvas: canvas(c["canvas"]), showHeader: bool(c["showHeader"]))
            expectRect(rect, c["rect"], "\(c)")
        }
    }

    @Test func insideGrid() {
        for c in StudioVectors.cases("insideGrid") {
            let p = c["placement"] as! [String: Any]
            let values = ["x", "y", "w", "h"].map { double(p[$0]) }
            let expected = bool(c["inside"])
            if values.allSatisfy({ $0.rounded() == $0 }) {
                #expect(StudioLayout.isInsideGrid(placement(p)) == expected, "\(p)")
            } else {
                // Placements are whole cells in Swift; fractions are never inside.
                #expect(expected == false)
            }
        }
    }

    @Test func minimumSize() {
        for c in StudioVectors.cases("minimumSize") {
            let type = StudioWidgetType(rawValue: c["type"] as! String)!
            let p = StudioPlacement(x: 0, y: 0, w: int(c["w"]), h: int(c["h"]))
            #expect(StudioLayout.meetsMinimumSize(type, p) == bool(c["meets"]), "\(c)")
        }
    }

    @Test func overlaps() {
        for c in StudioVectors.cases("overlaps") {
            let placements = (c["placements"] as! [Any]).map(placement)
            let pairs = (c["pairs"] as! [[NSNumber]]).map { $0.map(\.intValue) }
            #expect(StudioLayout.findOverlaps(placements) == pairs)
        }
    }

    @Test func typeScales() {
        for c in StudioVectors.cases("typeScales") {
            let type = StudioWidgetType(rawValue: c["type"] as! String)!
            let sizes = StudioLayout.typeScale(
                type, placement: StudioPlacement(x: 0, y: 0, w: int(c["w"]), h: int(c["h"])),
                fontScale: double(c["fontScale"]), showHeader: bool(c["showHeader"]))
            let expected = c["sizes"] as! [String: Any]
            #expect(Set(sizes.keys.map(\.rawValue)) == Set(expected.keys), "\(c)")
            for (role, value) in sizes {
                #expect(close(value, double(expected[role.rawValue])), "\(c) \(role)")
            }
        }
    }

    @Test func textSizes() {
        for c in StudioVectors.cases("textSizes") {
            let sizes = StudioLayout.textWidgetSizes(
                StudioTextSize(rawValue: c["size"] as! String)!, fontScale: double(c["fontScale"]))
            #expect(close(sizes.paragraph, double(c["paragraph"])))
            #expect(close(sizes.heading1, double(c["heading1"])))
            #expect(close(sizes.heading2, double(c["heading2"])))
        }
    }

    @Test func textWidths() {
        for c in StudioVectors.cases("textWidths") {
            let width = StudioLayout.estimateTextWidth(
                c["text"] as! String, fontSize: double(c["fontSize"]), weight: weight(c["weight"]))
            #expect(close(width, double(c["width"])), "\(c)")
        }
    }

    @Test func wrapping() {
        for c in StudioVectors.cases("wrapping") {
            let lines = StudioLayout.wrappedLineCount(
                c["text"] as! String, maxWidth: double(c["maxWidth"]), fontSize: double(c["fontSize"]),
                weight: weight(c["weight"]))
            #expect(lines == int(c["lines"]), "\(c)")
        }
    }

    @Test func fitSizes() {
        for c in StudioVectors.cases("fitSizes") {
            let size = StudioLayout.fitTextSize(
                c["text"] as! String, maxWidth: double(c["maxWidth"]), min: double(c["min"]),
                max: double(c["max"]), weight: weight(c["weight"]))
            if c["size"] is NSNull {
                #expect(size == nil, "\(c)")
            } else {
                #expect(size.map { close($0, double(c["size"])) } == true, "\(c)")
            }
        }
    }

    @Test func labelFits() {
        for c in StudioVectors.cases("labelFits") {
            let fit = StudioLayout.labelFit(
                c["label"] as! String, type: StudioWidgetType(rawValue: c["type"] as! String)!,
                w: int(c["w"]), h: int(c["h"]), fontScale: double(c["fontScale"]))
            #expect(fit.fits == bool(c["fits"]), "\(c)")
            #expect(fit.titleLines == int(c["titleLines"]), "\(c)")
            #expect(fit.resourceLines == int(c["resourceLines"]), "\(c)")
        }
    }

    @Test func legacy() {
        for c in StudioVectors.cases("legacy") {
            let tiles = int(c["tiles"])
            let grid = c["grid"] as! [String: Any]
            #expect(StudioLayout.legacyGrid(tiles).columns == int(grid["columns"]), "\(tiles)")
            #expect(StudioLayout.legacyGrid(tiles).rows == int(grid["rows"]), "\(tiles)")
            let slides = (c["slides"] as! [[Any]]).map { $0.map(placement) }
            #expect(StudioLayout.legacyLayout(tiles) == slides, "\(tiles)")
        }
    }

    @Test func markdown() {
        for c in StudioVectors.cases("markdown") {
            let expected: [StudioTextBlock] = (c["blocks"] as! [[String: Any]]).map { block in
                if block["kind"] as! String == "heading" {
                    return .heading(level: int(block["level"]), spans: spans(block["spans"]))
                }
                return .paragraph(lines: (block["lines"] as! [Any]).map(spans))
            }
            #expect(StudioLayout.parseText(c["source"] as! String) == expected, "\(c["source"]!)")
        }
    }

    @Test func compact() {
        for c in StudioVectors.cases("compact") {
            let value = c["value"] is NSNull ? Double.nan : double(c["value"])
            #expect(StudioLayout.compactNumber(value) == c["text"] as! String, "\(value)")
        }
    }
}

@Suite struct StudioLayoutTests {
    @Test func compactAgreesWithTileFormattingFromTenThousand() {
        for value in [12_345.0, 99_950, 4_200_000, 1_234_567, 1.5e9] {
            #expect(StudioLayout.compactNumber(value) == MetricFormat.value(value, unit: "count"))
        }
    }

    @Test func fitsFlagsLongResourceNames() {
        #expect(StudioLayout.fits("Downloads · Wurfel", type: .metric, w: 3, h: 2))
        #expect(
            !StudioLayout.fits(
                "Visitors · my-very-long-vercel-project-name-for-the-marketing-site-and-blog",
                type: .metric, w: 3, h: 2))
    }
}
