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

    @Test func tableLayouts() {
        let cases = StudioVectors.cases("tableLayouts")
        #expect(!cases.isEmpty)
        for c in cases {
            let values = (c["values"] as! [[String: Any]]).map {
                StudioLayout.TableValueText(full: $0["full"] as! String, compact: $0["compact"] as! String)
            }
            let layout = StudioLayout.tableLayout(
                label: c["label"] as! String, width: double(c["width"]), height: double(c["height"]),
                fontScale: double(c["fontScale"]), values: values, showChange: bool(c["showChange"]))
            let e = c["layout"] as! [String: Any]
            let sizes = e["sizes"] as! [String: Any]
            #expect(close(layout.sizes.title, double(sizes["title"])), "\(c)")
            #expect(close(layout.sizes.resource, double(sizes["resource"])), "\(c)")
            #expect(close(layout.sizes.subtitle, double(sizes["subtitle"])), "\(c)")
            #expect(close(layout.sizes.columnHead, double(sizes["columnHead"])), "\(c)")
            #expect(close(layout.sizes.cell, double(sizes["cell"])), "\(c)")
            #expect(close(layout.sizes.cellMin, double(sizes["cellMin"])), "\(c)")
            #expect(layout.titleLines == int(e["titleLines"]), "\(c)")
            #expect(layout.resourceLines == int(e["resourceLines"]), "\(c)")
            #expect(close(layout.headHeight, double(e["headHeight"])), "\(c)")
            #expect(close(layout.footerHeight, double(e["footerHeight"])), "\(c)")
            #expect(close(layout.rowPitch, double(e["rowPitch"])), "\(c)")
            #expect(layout.rowCapacity == int(e["rowCapacity"]), "\(c)")
            let columns = e["columns"] as! [String: Any]
            #expect(close(layout.columns.label, double(columns["label"])), "\(c)")
            #expect(close(layout.columns.value, double(columns["value"])), "\(c)")
            #expect(close(layout.columns.change, double(columns["change"])), "\(c)")
            #expect(close(layout.columns.gap, double(columns["gap"])), "\(c)")
            #expect(layout.compact == bool(e["compact"]), "\(c)")
        }
    }

    @Test func tableRowsShown() {
        for c in StudioVectors.cases("tableRowsShown") {
            #expect(
                StudioLayout.tableRowsShown(limit: int(c["limit"]), rows: int(c["rows"]), rowCapacity: int(c["capacity"]))
                    == int(c["shown"]), "\(c)")
        }
    }

    @Test func tableRowLabels() {
        for c in StudioVectors.cases("tableRowLabels") {
            let label = StudioLayout.tableRowLabel(
                c["text"] as! String, labelWidth: double(c["labelWidth"]), cell: double(c["cell"]),
                cellMin: double(c["cellMin"]))
            #expect(close(label.size, double(c["size"])), "\(c)")
            #expect(label.truncated == bool(c["truncated"]), "\(c)")
        }
    }

    @Test func tableChanges() {
        func optional(_ any: Any?) -> Double? { any is NSNull ? nil : double(any) }
        for c in StudioVectors.cases("tableChanges") {
            let kind = StudioLayout.tableChangeKind(
                value: optional(c["value"]), previousValue: optional(c["previousValue"]), ratio: optional(c["ratio"]))
            #expect(kind.rawValue == c["kind"] as! String, "\(c)")
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

    @Test func clockDateSamples() {
        let samples = StudioVectors.root["clockDateSamples"] as! [String: String]
        #expect(StudioLayout.clockDateSample(.short) == samples["short"])
        #expect(StudioLayout.clockDateSample(.long) == samples["long"])
    }

    @Test func zoneLabels() {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for c in StudioVectors.cases("zoneLabels") {
            let zone = c["timeZone"] as! String
            let date = iso.date(from: c["at"] as! String)!
            #expect(StudioLayout.zoneLabel(zone, at: date) == c["label"] as! String, "\(c)")
            #expect(StudioLayout.zoneLabelSample(zone) == c["sample"] as! String, "\(c)")
        }
    }

    @Test func clockLayouts() {
        for c in StudioVectors.cases("clockLayouts") {
            let box = c["box"] as! [String: Any]
            let layout = StudioLayout.clockLayout(
                placement: StudioPlacement(x: 0, y: 0, w: int(c["w"]), h: int(c["h"])),
                box: (double(box["width"]), double(box["height"])), fontScale: double(c["fontScale"]),
                showHeader: true, time: c["time"] as! String, showDate: bool(c["showDate"]),
                dateStyle: ClockDateStyle(rawValue: c["dateStyle"] as! String)!,
                zone: c["zone"] is NSNull ? nil : c["zone"] as? String)
            let e = c["layout"] as! [String: Any]
            #expect(close(layout.time, double(e["time"])), "\(c)")
            #expect(layout.hidden == bool(e["hidden"]), "\(c)")
            for (value, key) in [(layout.date, "date"), (layout.zone, "zone")] {
                if e[key] is NSNull {
                    #expect(value == nil, "\(c) \(key)")
                } else {
                    #expect(value.map { close($0, double(e[key])) } == true, "\(c) \(key)")
                }
            }
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
