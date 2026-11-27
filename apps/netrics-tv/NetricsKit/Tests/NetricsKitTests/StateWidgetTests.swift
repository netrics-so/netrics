import Foundation
import Testing

@testable import NetricsKit

// The state widget (#875): decoding (schemas 2 and 3), the fixed states and
// their order, tone and shape, "+N more" (the same cases as
// packages/domain/src/service-state.test.ts), the detail sheet, the words
// in English and German, and the offline cache.

/** One state widget as the server writes it (deviceStateDataSchema). */
func stateWidgetJSON(
    options: String = #"{"layout": "list", "item": null, "limit": 8, "showChanged": true}"#,
    items: String? = nil, total: Int = 4, min: Bool = false
) -> String {
    let rows =
        items ?? """
            {"name": "api", "state": "failed", "rolledBack": false, "changedAt": "2026-11-21T07:00:00.000Z"},
            {"name": "cron", "state": "building", "rolledBack": false, "changedAt": null},
            {"name": "site", "state": "up", "rolledBack": true, "changedAt": "2026-11-20T08:00:00.000Z"},
            {"name": "web", "state": "up", "rolledBack": false, "changedAt": null}
            """
    return """
        {"id": "w-state", "type": "state", "x": 0, "y": 0, "w": 4, "h": 4, \(min ? #""min": {"w": 3, "h": 2},"# : "")
         "label": "Services", "options": \(options),
         "data": {"status": "ok", "items": [\(rows)], "total": \(total),
                  "freshness": {"kind": "continuous", "stream": "Service states", "fetchedAt": "2026-11-21T08:00:00.000Z"}}}
        """
}

private func stateSlides(_ widget: String) -> String {
    """
    [{"id": "\(slideA)", "name": "Ops", "durationSec": 30, "background": null, "widgets": [\(widget)]}]
    """
}

private func stateWidget(_ payload: DeviceDashboardV2) throws -> (StateWidgetOptions, StateWidgetData) {
    let widget = try #require(payload.slides.first?.widgets.first)
    guard case .state(let options, let data) = widget.content else {
        Issue.record("expected .state, got \(widget.content)")
        throw CancellationError()
    }
    return (options, data)
}

@Suite struct StateWidgetDecodingTests {
    @Test func decodesTheListForm() throws {
        let payload = v2Payload(slides: stateSlides(stateWidgetJSON()))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.type == "state")
        #expect(widget.label == "Services")
        let (options, data) = try stateWidget(payload)
        #expect(options == StateWidgetOptions(layout: .list, item: nil, limit: 8, showChanged: true))
        #expect(!options.single)
        #expect(data.status == .ok)
        #expect(data.total == 4)
        // As the server sorted them: not healthy first.
        #expect(data.items.map(\.name) == ["api", "cron", "site", "web"])
        #expect(data.items.map(\.state) == [.failed, .building, .up, .up])
        #expect(data.items[2].rolledBack)
        #expect(data.items[0].changedAt == "2026-11-21T07:00:00.000Z")
        #expect(data.freshness?.stream == "Service states")
    }

    @Test func decodesSchema3WithItsMinimum() throws {
        let payload = v3Payload(slides: stateSlides(stateWidgetJSON(min: true)))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.type == "state")
        let (_, data) = try stateWidget(payload)
        #expect(data.items.count == 4)
        #expect(StudioLayout.minimumSize(.state) == (3, 2))
    }

    @Test func decodesTheSingleForm() throws {
        let (options, data) = try stateWidget(
            v2Payload(
                slides: stateSlides(
                    stateWidgetJSON(
                        options: #"{"layout": "single", "item": "api", "limit": 8, "showChanged": false}"#,
                        items: #"{"name": "api", "state": "down", "rolledBack": false, "changedAt": null}"#,
                        total: 1))))
        #expect(options.single)
        #expect(options.item == "api")
        #expect(!options.showChanged)
        #expect(data.items.map(\.state) == [.down])
    }

    @Test func anUnknownStateOrLayoutFallsBack() throws {
        let (options, data) = try stateWidget(
            v2Payload(
                slides: stateSlides(
                    stateWidgetJSON(
                        options: #"{"layout": "grid", "limit": 99}"#,
                        items: #"{"name": "x", "state": "degraded", "rolledBack": true, "changedAt": null}"#,
                        total: 1))))
        #expect(options.layout == .unknown)
        #expect(!options.single)
        #expect(options.limit == 20)
        #expect(data.items[0].state == .unknown)
        // Rolled back qualifies up only.
        #expect(!data.items[0].rolledBack)
    }

    @Test func aDamagedItemIsDroppedNotTheWidget() throws {
        let (_, data) = try stateWidget(
            v2Payload(
                slides: stateSlides(
                    stateWidgetJSON(
                        items: #""oops", {"name": 7, "state": "up"}, {"name": "web", "state": "up", "rolledBack": false, "changedAt": null}"#,
                        total: 2))))
        #expect(data.items.count == 2)
        #expect(data.items[0] == StateWidgetItem(name: nil, state: .up))
        // A total below the items sent is the items' count.
        #expect(StateWidgetData(items: data.items, total: 0).total == 2)
    }

    @Test func aWidgetWithoutDataIsUnsupported() throws {
        let json = """
            {"id": "w-state", "type": "state", "x": 0, "y": 0, "w": 4, "h": 4, "label": "S", "options": {}}
            """
        let widget = try #require(v2Payload(slides: stateSlides(json)).slides.first?.widgets.first)
        #expect(widget.content == .unsupported)
    }

    @Test func roundTripsThroughTheCache() throws {
        let payload = v2Payload(slides: stateSlides(stateWidgetJSON()))
        let data = try JSONEncoder().encode(DashboardPayload.v2(payload))
        let decoded = try JSONDecoder().decode(DashboardPayload.self, from: data)
        #expect(decoded == .v2(payload))
    }
}

@Suite struct StateWidgetLogicTests {
    @Test func ranksProblemsFirstAndARollbackBeforeAPlainUp() {
        let order = [
            ServiceState.down.rank(), ServiceState.failed.rank(), ServiceState.unknown.rank(),
            ServiceState.building.rank(), ServiceState.sleeping.rank(), ServiceState.up.rank(rolledBack: true),
            ServiceState.up.rank(),
        ]
        #expect(order == order.sorted())
        #expect(Set(order).count == order.count)
    }

    @Test func sortsAsTheServerDoes() {
        func item(_ name: String?, _ state: ServiceState, _ rolledBack: Bool = false) -> StateWidgetItem {
            StateWidgetItem(name: name, state: state, rolledBack: rolledBack)
        }
        let sorted = StateBoard.sorted([
            item("web", .up), item("api", .up), item("Worker", .failed), item(nil, .failed), item("db", .down),
            item("site", .up, true), item("cron", .building), item("Api", .up),
        ])
        #expect(
            sorted.map { "\($0.name ?? "null"):\($0.state.rawValue)" } == [
                "db:down", "Worker:failed", "null:failed", "cron:building", "site:up", "Api:up", "api:up", "web:up",
            ])
    }

    @Test func everyStateHasItsOwnShapeAndATone() {
        #expect(Set(ServiceState.allCases.map(\.symbol)).count == ServiceState.allCases.count)
        #expect(ServiceState.up.tone() == .up)
        #expect(ServiceState.up.tone(rolledBack: true) == .warning)
        #expect(ServiceState.failed.tone() == .down)
        #expect(ServiceState.down.tone() == .down)
        #expect(ServiceState.building.tone() == .muted)
        #expect(ServiceState.unknown.tone() == .warning)
    }

    @Test func rowsShownMatchTheDomain() {
        // packages/domain/src/service-state.test.ts, serviceStateRowsShown.
        let cases: [(items: Int, total: Int, capacity: Int, rows: Int, more: Int)] = [
            (3, 3, 5, 3, 0), (5, 5, 5, 5, 0), (8, 8, 5, 4, 4), (2, 2, 1, 0, 2), (5, 7, 10, 5, 2), (5, 7, 5, 4, 3),
            (3, 3, 0, 0, 0),
        ]
        for c in cases {
            let fit = StateBoard.rowsShown(items: c.items, total: c.total, capacity: c.capacity)
            #expect(fit.rows == c.rows && fit.more == c.more, "\(c)")
        }
    }

    @Test func wordsInEnglishAndGerman() {
        let words: [ServiceState: (String, String)] = [
            .up: ("Up", "Online"), .down: ("Down", "Offline"), .failed: ("Failed", "Fehlgeschlagen"),
            .building: ("Building", "Wird gebaut"), .sleeping: ("Sleeping", "Schläft"), .unknown: ("Unknown", "Unbekannt"),
        ]
        for (state, (en, de)) in words {
            #expect(state.word(.en) == en)
            #expect(state.word(.de) == de)
        }
        let rolled = StateWidgetItem(name: "site", state: .up, rolledBack: true)
        #expect(StateBoard.stateText(rolled, language: .en) == "Up · rolled back")
        #expect(StateBoard.stateText(rolled, language: .de) == "Online · zurückgesetzt")
        #expect(StateBoard.accessibilityText(rolled, language: .en) == "site, Up · rolled back")
        let now = ISODate.parse("2026-11-21T10:00:00.000Z")!
        #expect(StateBoard.changed("2026-11-21T07:00:00.000Z", now: now, language: .en) == "Changed 3 hours ago")
        #expect(StateBoard.changed("2026-11-21T07:00:00.000Z", now: now, language: .de) == "Geändert vor 3 Stunden")
        #expect(StateBoard.changed(nil, now: now, language: .en) == nil)
        #expect(StateBoard.age("2026-11-21T07:00:00.000Z", now: now, language: .en) == "3 h")
    }

    @Test func detailSheetListsEveryItem() throws {
        let payload = v2Payload(slides: stateSlides(stateWidgetJSON()))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(WidgetDetail.available(widget))
        let detail = try #require(
            WidgetDetail.make(
                widget, now: ISODate.parse("2026-11-21T10:00:00.000Z")!, language: .en,
                timeZone: TimeZone(identifier: "UTC")!))
        #expect(detail.items.map(\.label) == ["api", "cron", "site", "web"])
        #expect(detail.items.map(\.value) == ["Failed", "Building", "Up · rolled back", "Up"])
        #expect(detail.items[0].lines.map(\.text) == ["Changed 3 hours ago"])
        // Only down and failed count as failing, not building or a rollback (review).
        let summary = try #require(detail.rows.first)
        #expect(summary.text == "4 items · 1 failing")
    }

    @Test(arguments: [ScreenLanguage.en, .de])
    func detailSheetWarnsWhenStaleWithoutFreshness(language: ScreenLanguage) throws {
        let json = stateWidgetJSON().replacingOccurrences(of: #""status": "ok""#, with: #""status": "stale""#)
        let widget = try #require(v2Payload(slides: stateSlides(json)).slides.first?.widgets.first)
        let detail = try #require(
            WidgetDetail.make(
                widget, now: ISODate.parse("2026-11-21T10:00:00.000Z")!, language: language,
                timeZone: TimeZone(identifier: "UTC")!))
        #expect(detail.text(.source) == KitStrings.text(.stateStale, language))
        // A current state has no warning.
        let current = try #require(v2Payload(slides: stateSlides(stateWidgetJSON())).slides.first?.widgets.first)
        let plain = try #require(
            WidgetDetail.make(
                current, now: ISODate.parse("2026-11-21T10:00:00.000Z")!, language: language,
                timeZone: TimeZone(identifier: "UTC")!))
        #expect(plain.text(.source) == nil)
    }

    @Test func decodesCountsAndStale() throws {
        let json = stateWidgetJSON().replacingOccurrences(
            of: #""status": "ok""#,
            with: #""status": "stale", "counts": {"up": 2, "down": 1, "failed": 1, "building": 1, "sleeping": 0, "unknown": 0, "rolledBack": 1}"#
        )
        let (_, data) = try stateWidget(v2Payload(slides: stateSlides(json)))
        #expect(data.status == .stale)
        #expect(data.counts.down == 1)
        #expect(data.counts.rolledBack == 1)
        // Without counts (an older server), they come from the items.
        let (_, plain) = try stateWidget(v2Payload(slides: stateSlides(stateWidgetJSON())))
        #expect(plain.counts == ServiceStateCounts(items: plain.items))
    }

    @Test func summarisesWithoutAChosenItem() {
        var counts = ServiceStateCounts()
        counts.up = 5
        #expect(StateBoard.summaryText(counts, language: .en) == "All 5 up")
        #expect(StateBoard.summaryText(counts, language: .de) == "Alle 5 online")
        counts.up = 3
        counts.down = 2
        #expect(StateBoard.summaryText(counts, language: .en) == "2 of 5 down")
        #expect(StateBoard.summaryText(counts, language: .de) == "2 von 5 offline")
        #expect(StateBoard.summaryState(counts)?.0 == .down)
        #expect(StateBoard.summaryState(counts)?.1 == false)
        #expect(StateBoard.summaryText(ServiceStateCounts(), language: .en) == nil)
    }

    @Test func tonesMoreByAHiddenOutage() {
        var counts = ServiceStateCounts()
        counts.up = 2
        counts.down = 1
        let up = StateWidgetItem(name: "web", state: .up)
        #expect(StateBoard.hiddenTone(counts, shown: [up]) == .down)
        #expect(StateBoard.hiddenTone(counts, shown: [StateWidgetItem(name: "db", state: .down)]) == .up)
    }

    @Test func readsADateOnlyChangeAsMidnightUTC() {
        let now = ISODate.parse("2026-11-21T10:00:00.000Z")!
        #expect(StateBoard.age("2026-11-21", now: now, language: .en) == "10 h")
        #expect(StateBoard.changed("2026-11-20", now: now, language: .en) != nil)
        #expect(StateBoard.changed("not a date", now: now, language: .en) == nil)
    }

    @Test func scrollCardSummarisesTonesAndWarnsLikeTheCanvas() {
        var counts = ServiceStateCounts()
        counts.up = 3
        counts.down = 1
        let shown = [StateWidgetItem(name: "web", state: .up), StateWidgetItem(name: "api", state: .up)]
        let data = StateWidgetData(status: .stale, items: shown, total: 4, counts: counts)
        // The single form without an item: the summary, never the first item.
        let single = StateBoard.scrollPlan(StateWidgetOptions(layout: .single), data, language: .en)
        #expect(single.summary == "1 of 4 down")
        #expect(single.items.isEmpty)
        #expect(single.stale)
        // A chosen item: that item.
        let chosen = StateBoard.scrollPlan(StateWidgetOptions(layout: .single, item: "web"), data, language: .en)
        #expect(chosen.summary == nil)
        #expect(chosen.items.map(\.name) == ["web"])
        // A list: "+2 more" in the tone of the hidden outage.
        let list = StateBoard.scrollPlan(StateWidgetOptions(), data, language: .en)
        #expect(list.items.count == 2)
        #expect(list.more == 2)
        #expect(list.moreTone == .down)
    }
}
