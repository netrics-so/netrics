import Foundation
import Testing

@testable import NetricsKit

// The table widget (ADR 0019 section 6) and the schema 3 `min` every widget
// carries (section 2): decoding, and the reflow of a type this build does
// not know.

private func table(_ id: String, data: String? = nil, min: String = #"{"w": 4, "h": 4}"#) -> String {
    let rows = """
        {"period": "last_30_days", "aggregation": "sum", "unit": "count", "conversion": null,
         "kind": "delta", "granularity": "day", "better": "higher", "status": "ok",
         "updatedAt": "2026-10-04T08:00:00.000Z", "groupBy": "route",
         "columns": {"label": "Route", "value": "Page views"},
         "rows": [
           {"key": "/pricing", "label": "/pricing", "value": 8120, "previousValue": 7250, "ratio": 0.12},
           {"key": "/blog", "label": "/blog", "value": 512, "previousValue": null, "ratio": null},
           {"broken": true}
         ],
         "others": {"label": "Others", "value": 2015, "groups": 14}}
        """
    return """
        {"id": "\(id)", "type": "table", "x": 0, "y": 0, "w": 6, "h": 5, "min": \(min),
         "label": "Page views · netrics.so",
         "options": {"groupBy": "route", "limit": 8, "showChange": true, "showOthers": true},
         "data": \(data ?? rows)}
        """
}

private func later(_ id: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int, min: String?) -> String {
    let minimum = min.map { #", "min": \#($0)"# } ?? ""
    return """
        {"id": "\(id)", "type": "gauge", "x": \(x), "y": \(y), "w": \(w), "h": \(h)\(minimum),
         "label": "Goal", "options": {}, "data": {"value": 1}}
        """
}

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

@Suite struct TableWidgetDecodingTests {
    @Test func decodesATable() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(table("t")))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.minimum == StudioMinimum(w: 4, h: 4))
        guard case .table(let options, let data) = widget.content else {
            Issue.record("table")
            return
        }
        #expect(options == TableWidgetOptions(groupBy: "route", limit: 8, showChange: true, showOthers: true))
        #expect(data.columns == TableColumnHeads(label: "Route", value: "Page views"))
        // The damaged row is dropped, not the widget.
        #expect(data.rows == [
            TableRow(key: "/pricing", label: "/pricing", value: 8120, previousValue: 7250, ratio: 0.12),
            TableRow(key: "/blog", label: "/blog", value: 512, previousValue: nil, ratio: nil),
        ])
        #expect(data.others == BarOthers(label: "Others", value: 2015, groups: 14))
        #expect(data.period == .last30Days)
        #expect(data.better == .higher)
    }

    @Test func optionsFallBackToTheirDefaults() throws {
        let json = table("t").replacingOccurrences(
            of: #""options": {"groupBy": "route", "limit": 8, "showChange": true, "showOthers": true}"#,
            with: #""options": {"groupBy": "route"}"#)
        let widget = try #require(v3Payload(primaryFormat: "16x9", slides: slides(json)).slides.first?.widgets.first)
        guard case .table(let options, _) = widget.content else {
            Issue.record("table")
            return
        }
        #expect(options == TableWidgetOptions(groupBy: "route", limit: 5, showChange: true, showOthers: false))
    }

    @Test func aTableWithUnreadableDataIsAnEmptyCell() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(table("t", data: #""not data""#)))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.type == "table")
        #expect(widget.content == .unsupported)
    }

    @Test func tablesAndMinimumsSurviveTheCache() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(table("t")))
        let again = try JSONDecoder().decode(DeviceDashboardV2.self, from: JSONEncoder().encode(payload))
        #expect(again.slides == payload.slides)
    }

    @Test func aMalformedMinimumIsIgnored() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(later("g", 0, 0, 6, 4, min: #"{"w": 0}"#)))
        #expect(payload.slides.first?.widgets.first?.minimum == nil)
    }
}

@Suite struct LaterTypeReflowTests {
    /** A 16:9 slide with a later type 6 wide, reflowed into 9:16 (6 columns). */
    private func width(min: String?) -> Int? {
        let payload = v3Payload(
            primaryFormat: "16x9", slides: slides(later("g", 0, 0, 6, 4, min: min)))
        #expect(payload.slides.first?.widgets.first?.content == .unsupported)
        return ScreenView.pages(payload, format: .tall).first?.placements.first?.w
    }

    @Test func anUnknownTypeReflowsWithTheMinimumItCarries() {
        // Half the 12 columns is 3 of 6; the type's minimum keeps it 5 wide.
        #expect(width(min: #"{"w": 5, "h": 4}"#) == 5)
        // Without a minimum (schema 2, older servers) it is the smallest widget.
        #expect(width(min: nil) == 3)
    }

    @Test func aKnownTypeKeepsItsOwnMinimum() {
        // A table 4 × 4 at least, whatever it carries.
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(table("t", min: #"{"w": 1, "h": 1}"#)))
        let placement = ScreenView.pages(payload, format: .tall).first?.placements.first
        #expect(placement.map { $0.w >= 4 && $0.h >= 4 } == true)
    }
}
