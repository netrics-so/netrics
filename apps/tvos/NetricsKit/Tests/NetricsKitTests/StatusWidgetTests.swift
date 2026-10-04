import Foundation
import Testing

@testable import NetricsKit

// The status board (ADR 0019 section 7): decoding, the rows a board lists
// with "+N more", ages and the footer, as the web shows them.

private let items = """
    [
      {"connectionId": "c1", "name": "Stripe", "status": "auth_failed", "lastSuccessAt": "2026-10-04T09:00:00.000Z"},
      {"connectionId": "c2", "name": "App Store Connect", "status": "stale", "lastSuccessAt": "2026-10-03T08:00:00.000Z"},
      {"connectionId": "c3", "name": "Plausible", "status": "backfilling", "lastSuccessAt": null},
      {"connectionId": "c4", "name": "Vercel", "status": "ok", "lastSuccessAt": "2026-10-04T11:46:00.000Z"},
      {"connectionId": "c5", "name": "Later", "status": "paused", "lastSuccessAt": null},
      {"broken": true}
    ]
    """

private func status(_ id: String) -> String {
    """
    {"id": "\(id)", "type": "status", "x": 0, "y": 0, "w": 3, "h": 3, "min": {"w": 3, "h": 3},
     "label": "Sources", "options": {"connectionIds": null, "showAge": true},
     "data": {"status": "ok", "items": \(items)}}
    """
}

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

private let now = ISO8601DateFormatter().date(from: "2026-10-04T12:00:00Z")!

private func item(_ id: String, _ status: StatusItemStatus) -> StatusItem {
    StatusItem(connectionId: id, name: id, status: status, lastSuccessAt: nil)
}

@Suite struct StatusWidgetTests {
    @Test func decodesAStatusBoard() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(status("s")))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.minimum == StudioMinimum(w: 3, h: 3))
        #expect(widget.label == "Sources")
        guard case .status(let options, let data) = widget.content else {
            Issue.record("status")
            return
        }
        #expect(options == StatusWidgetOptions(connectionIds: nil, showAge: true))
        #expect(data.status == .ok)
        // The damaged item is dropped; an unknown status shows a muted dot.
        #expect(data.items.map(\.name) == ["Stripe", "App Store Connect", "Plausible", "Vercel", "Later"])
        #expect(data.items.map(\.status) == [.authFailed, .stale, .backfilling, .ok, .backfilling])
        #expect(data.items[2].lastSuccessAt == nil)
    }

    @Test func roundTripsAndChosenSources() throws {
        let json = """
            {"id": "s", "type": "status", "x": 0, "y": 0, "w": 3, "h": 3, "label": "Feeds",
             "options": {"connectionIds": ["c1", "c2"], "showAge": false},
             "data": {"status": "ok", "items": []}}
            """
        let widget = try JSONDecoder().decode(DeviceWidget.self, from: Data(json.utf8))
        guard case .status(let options, let data) = widget.content else {
            Issue.record("status")
            return
        }
        #expect(options == StatusWidgetOptions(connectionIds: ["c1", "c2"], showAge: false))
        #expect(data.items.isEmpty)
        let again = try JSONDecoder().decode(DeviceWidget.self, from: JSONEncoder().encode(widget))
        #expect(again == widget)
    }

    @Test func aBoardWithoutDataIsUnsupported() throws {
        let json = #"{"id": "s", "type": "status", "x": 0, "y": 0, "w": 3, "h": 3, "label": "Sources", "options": {}}"#
        let widget = try JSONDecoder().decode(DeviceWidget.self, from: Data(json.utf8))
        #expect(widget.content == .unsupported)
    }

    @Test func listsProblemsFirstThenMore() {
        // A 3 × 3 board at 16:9: five rows at font scale 1, three at 1.3.
        let normal = StudioLayout.statusLayout(label: "Sources", width: 404, height: 294.65, fontScale: 1)
        let large = StudioLayout.statusLayout(label: "Sources", width: 404, height: 294.65, fontScale: 1.3)
        #expect(normal.rowCapacity == 5)
        #expect(large.rowCapacity == 3)
        let board = [
            item("a", .authFailed), item("b", .stale), item("c", .backfilling), item("d", .ok), item("e", .ok),
            item("f", .ok), item("g", .ok),
        ]
        let rows = StatusBoard.rows(board, capacity: large.rowCapacity)
        #expect(rows.shown.map(\.connectionId) == ["a", "b"])
        #expect(rows.more == 5)
        #expect(rows.moreTone == .muted)
        let all = StatusBoard.rows(Array(board.prefix(5)), capacity: normal.rowCapacity)
        #expect(all.shown.count == 5)
        #expect(all.more == 0)
        // More problems than rows: "+N more" takes the worst hidden tone.
        let failing = StatusBoard.rows(
            [item("a", .outage), item("b", .authFailed), item("c", .authFailed), item("d", .stale)], capacity: 3)
        #expect(failing.more == 2)
        #expect(failing.moreTone == .down)
    }

    @Test func tonesAgesAndFooter() {
        #expect(StatusBoard.tone(.ok) == .up)
        #expect(StatusBoard.tone(.stale) == .warning)
        #expect(StatusBoard.tone(.backfilling) == .muted)
        #expect(StatusBoard.tone(.authFailed) == .down)
        #expect(StatusBoard.tone(.outage) == .down)
        #expect(StatusBoard.ageText("2026-10-04T11:46:00.000Z", now: now) == "14 m")
        #expect(StatusBoard.ageText("2026-10-04T09:00:00Z", now: now) == "3 h")
        #expect(StatusBoard.ageText("2026-10-02T09:00:00Z", now: now, language: .de) == "2 T")
        #expect(StatusBoard.ageText(nil, now: now) == "never")
        let board = [item("a", .authFailed), item("b", .stale), item("c", .ok), item("d", .ok)]
        #expect(StatusBoard.footer(board) == "4 connected · 1 failing · 1 delayed")
        #expect(StatusBoard.footer(board, language: .de) == "4 verbunden · 1 gestört · 1 verzögert")
        #expect(StatusBoard.footer(board, width: 200, size: 24) == "4 connected")
        #expect(KitStrings.text(.statusMore, .en, 3) == "+3 more")
        #expect(KitStrings.text(.statusEmpty, .de) == "Keine Quellen verbunden")
    }
}
