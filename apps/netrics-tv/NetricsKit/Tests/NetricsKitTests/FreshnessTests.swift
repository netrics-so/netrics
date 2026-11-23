import Foundation
import Testing

@testable import NetricsKit

// Data freshness (ADR 0025 sections 7 and 8, #706): lenient decoding on
// every data widget, and the wording of the footer, the notices and the
// detail sheet in English and German, in the device's zone and clock, with
// the provider's day never converted.

private let berlin = TimeZone(identifier: "Europe/Berlin")!
private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!
/** An English device that keeps a 24-hour clock (the ADR's examples). */
private let us24 = Locale(identifier: "en_US@hours=h23")
private let us = Locale(identifier: "en_US")
private let germany = Locale(identifier: "de_DE")

private func at(_ iso: String) -> Date { ISODate.parse(iso)! }

/** 2026-11-16 14:00 in Berlin, 05:00 in Los Angeles. */
private let now = at("2026-11-16T13:00:00Z")

private func periodic(
    through: String? = "2026-11-15", fetched: String = "2026-11-16T12:50:00Z", next: String? = "2026-11-16T20:00:00Z",
    late: Bool = false, check: String? = "2026-11-16T14:10:00Z", monthly: Bool = false
) -> WidgetFreshness {
    WidgetFreshness(
        kind: .periodic, stream: "Sales", fetchedAt: fetched, dataThrough: through, monthly: monthly,
        nextExpectedAt: next, late: late, nextCheckAt: check)
}

private func continuous(fetched: String = "2026-11-16T12:50:00Z", check: String? = "2026-11-16T13:30:00Z")
    -> WidgetFreshness
{
    WidgetFreshness(kind: .continuous, stream: "Reviews", fetchedAt: fetched, nextCheckAt: check)
}

extension [String] {
    /// The candidates as they were before a day older than its check was
    /// named (#791): those tests below word the line itself. The named
    /// ones are in ReportingDayTests.
    fileprivate var plain: [String] {
        filter { !$0.hasPrefix("Last reporting day: ") && !$0.hasPrefix("Letzter Berichtstag: ") }
    }
}

private func text(_ language: ScreenLanguage = .en, zone: TimeZone = berlin, region: Locale = us24) -> FreshnessText {
    FreshnessText(language: language, timeZone: zone, region: region)
}

@Suite struct FreshnessWordingTests {
    // MARK: The ADR's table

    @Test func periodicWithNextInBothLanguages() {
        #expect(
            text().footer(periodic(), now: now).plain == [
                "Up to Nov 15 · fetched 10 min. ago · next ~21:00",
                "Up to Nov 15 · fetched 10 min. ago",
                "Up to Nov 15",
            ])
        #expect(
            text(.de, region: germany).footer(periodic(), now: now).plain.first
                == "Bis 15. Nov. · abgerufen vor 10 Min. · nächste ~21:00")
    }

    @Test func periodicWithoutNext() {
        let f = periodic(through: "2026-11-13", next: nil)
        #expect(text().footer(f, now: now).plain.first == "Up to Nov 13 · fetched 10 min. ago")
        #expect(text(.de, region: germany).footer(f, now: now).plain.first == "Bis 13. Nov. · abgerufen vor 10 Min.")
    }

    @Test func aMonthlyStreamNamesTheMonth() {
        let f = periodic(through: "2026-10-31", next: "2026-11-25T08:00:00Z", monthly: true)
        #expect(text().footer(f, now: now).first == "Up to October · fetched 10 min. ago · next ~Nov 25")
        #expect(
            text(.de, region: germany).footer(f, now: now).first
                == "Bis Oktober · abgerufen vor 10 Min. · nächste ~25. Nov.")
        // Another year than the device's: with the year.
        let december = periodic(through: "2025-12-31", next: nil, monthly: true)
        #expect(text().footer(december, now: now).last == "Up to December 2025")
        #expect(text(.de, region: germany).footer(december, now: now).last == "Bis Dezember 2025")
    }

    @Test func aLateProviderInTheMutedFooter() {
        let f = periodic(through: "2026-11-14", late: true)
        #expect(
            text().footer(f, now: now).plain == [
                "Up to Nov 14 · Nov 15 not published yet · checking again ~15:10",
                "Up to Nov 14 · Nov 15 not published yet",
                "Up to Nov 14",
            ])
        #expect(
            text(.de, region: germany).footer(f, now: now).plain.first
                == "Bis 14. Nov. · 15. Nov. noch nicht veröffentlicht · erneut prüfen ~15:10")
        // Late is no warning: an ok widget gets no notice.
        #expect(TileNotices.notice(status: .ok, updatedAt: nil, freshness: f, now: now, region: us24) == nil)
        // A late monthly stream names the next month.
        let month = periodic(through: "2026-10-31", late: true, monthly: true)
        #expect(text().footer(month, now: now)[1] == "Up to October · November not published yet")
    }

    @Test func continuousInBothLanguages() {
        #expect(text().footer(continuous(), now: now) == ["Checked 10 min. ago · next check ~14:30", "Checked 10 min. ago"])
        #expect(
            text(.de, region: germany).footer(continuous(), now: now).first
                == "Geprüft vor 10 Min. · nächste Prüfung ~14:30")
    }

    // MARK: Precedence

    @Test func overdueByADayIsTheStaleWarningWithTheLateWording() {
        let f = periodic(through: "2026-11-14", late: true)
        #expect(
            TileNotices.notice(status: .stale, updatedAt: "2026-11-16T12:50:00Z", freshness: f, now: now, region: us24)
                == "Up to Nov 14 · Nov 15 not published yet")
        #expect(
            TileNotices.notice(
                status: .stale, updatedAt: "2026-11-16T12:50:00Z", freshness: f, now: now, language: .de, region: germany)
                == "Bis 14. Nov. · 15. Nov. noch nicht veröffentlicht")
        // The footer keeps only the day, never "next" or "checking again".
        #expect(text().footer(f, status: .stale, now: now).plain == ["Up to Nov 14"])
    }

    @Test func aFailingSourceKeepsItsNoticeAndOnlyTheDay() {
        let f = periodic()
        #expect(
            TileNotices.notice(status: .outage, updatedAt: nil, freshness: f, now: now, region: us24)
                == "Source unreachable · Up to Nov 15")
        #expect(
            TileNotices.notice(status: .stale, updatedAt: "2026-11-16T10:00:00Z", freshness: f, now: now, region: us24)
                == "Last sync 3 hours ago · Up to Nov 15")
        #expect(text().footer(f, status: .authFailed, now: now).plain == ["Up to Nov 15"])
        #expect(text().footer(continuous(), status: .outage, now: now) == ["Checked 10 min. ago"])
        // A continuous stream adds nothing to the notice.
        #expect(
            TileNotices.notice(status: .outage, updatedAt: nil, freshness: continuous(), now: now, region: us24)
                == "Source unreachable")
    }

    @Test func withoutFreshnessTheFooterAndNoticeAreAsBefore() {
        let updated = "2026-11-16T12:55:00Z"
        #expect(WidgetFooter.candidates(updatedAt: updated, source: nil, now: now) == ["updated 5 min. ago"])
        #expect(
            WidgetFooter.candidates(
                updatedAt: updated, freshness: periodic(), source: nil, now: now, timeZone: berlin, region: us24
            ).plain.first?
                .hasPrefix("Up to Nov 15 · fetched 10 min. ago") == true)
        #expect(TileNotices.notice(status: .outage, updatedAt: nil, now: now) == "Source unreachable")
    }

    // MARK: Times

    @Test func anExpectedTimeAlreadyPastReadsAnyMinute() {
        let f = periodic(next: "2026-11-16T12:30:00Z")
        #expect(text().footer(f, now: now).plain.first == "Up to Nov 15 · fetched 10 min. ago · next any minute")
        #expect(
            text(.de, region: germany).footer(f, now: now).plain.first
                == "Bis 15. Nov. · abgerufen vor 10 Min. · nächste in Kürze")
        let due = continuous(check: "2026-11-16T12:59:00Z")
        #expect(text().footer(due, now: now).first == "Checked 10 min. ago · next check any minute")
        let late = periodic(through: "2026-11-14", late: true, check: "2026-11-16T12:00:00Z")
        #expect(text(.de, region: germany).footer(late, now: now).first?.hasSuffix("erneut prüfen in Kürze") == true)
    }

    @Test func todayTomorrowWeekdayAndDateThresholds() {
        let t = text()
        #expect(t.expected(at("2026-11-16T22:59:00Z"), now: now) == "~23:59")
        #expect(t.expected(at("2026-11-16T23:00:00Z"), now: now) == "tomorrow ~00:00")
        #expect(t.expected(at("2026-11-17T08:00:00Z"), now: now) == "tomorrow ~09:00")
        #expect(t.expected(at("2026-11-18T08:00:00Z"), now: now) == "Wed ~09:00")
        // Six local days ahead is still a weekday, seven is a date.
        #expect(t.expected(at("2026-11-22T08:00:00Z"), now: now) == "Sun ~09:00")
        #expect(t.expected(at("2026-11-23T08:00:00Z"), now: now) == "~Nov 23")
        let de = text(.de, region: germany)
        #expect(de.expected(at("2026-11-17T08:00:00Z"), now: now) == "morgen ~09:00")
        #expect(de.expected(at("2026-11-18T08:00:00Z"), now: now) == "Mi ~09:00")
        #expect(de.expected(at("2026-11-23T08:00:00Z"), now: now) == "~23. Nov.")
    }

    @Test func theDeviceZoneDecidesTheDayAndTheTime() {
        // 06:00 UTC on Nov 17: still Nov 16 in Los Angeles, Nov 17 in Berlin.
        let next = at("2026-11-17T06:00:00Z")
        let morning = at("2026-11-16T12:00:00Z")
        #expect(text(zone: berlin).expected(next, now: morning) == "tomorrow ~07:00")
        #expect(text(zone: losAngeles, region: us).expected(next, now: morning) == "~10:00\u{202F}PM")
        // The region's 12-hour clock.
        #expect(text(zone: berlin, region: us).expected(at("2026-11-16T20:00:00Z"), now: now) == "~9:00\u{202F}PM")
    }

    @Test func tomorrowAcrossTheDaylightSavingChange() {
        // Berlin leaves summer time in the night to Oct 25 2026 (a 25-hour day).
        let evening = at("2026-10-24T20:00:00Z")  // 22:00 CEST
        #expect(text(zone: berlin).expected(at("2026-10-25T20:00:00Z"), now: evening) == "tomorrow ~21:00")
        #expect(text(zone: berlin).expected(at("2026-10-25T22:30:00Z"), now: evening) == "tomorrow ~23:30")
        #expect(text(zone: berlin).expected(at("2026-10-26T22:30:00Z"), now: evening) == "Mon ~23:30")
        // Los Angeles on Nov 1 2026: noon PDT, then noon PST the next day.
        let noon = at("2026-10-31T19:00:00Z")
        #expect(text(zone: losAngeles, region: us).expected(at("2026-11-01T20:00:00Z"), now: noon) == "tomorrow ~12:00\u{202F}PM")
        // Berlin enters summer time on Mar 29 2026 (a 23-hour day).
        let march = at("2026-03-28T22:30:00Z")  // 23:30 CET
        #expect(text(zone: berlin).expected(at("2026-03-29T21:30:00Z"), now: march) == "tomorrow ~23:30")
    }

    @Test func theProvidersDayIsNeverConverted() {
        let f = periodic(through: "2026-11-15", next: nil)
        for zone in ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/Berlin", "America/Los_Angeles"] {
            let t = text(zone: TimeZone(identifier: zone)!, region: us)
            #expect(t.footer(f, now: now).last == "Up to Nov 15", "\(zone)")
        }
    }

    @Test func aFetchOlderThanADayShowsItsDate() {
        let f = periodic(fetched: "2026-11-12T09:00:00Z", next: nil)
        #expect(text().footer(f, now: now).first == "Up to Nov 15 · fetched Nov 12")
        #expect(text(.de, region: germany).footer(f, now: now).first == "Bis 15. Nov. · abgerufen am 12. Nov.")
        let checked = continuous(fetched: "2026-11-12T09:00:00Z", check: nil)
        #expect(text(.de, region: germany).footer(checked, now: now) == ["Geprüft am 12. Nov."])
        // A fetch a little ahead of this device's clock is "now", never in the future.
        let ahead = periodic(fetched: "2026-11-16T13:05:00Z", next: nil)
        #expect(text().footer(ahead, now: now).plain.first == "Up to Nov 15 · fetched now")
    }

    @Test func relativeTimesFollowTheDeviceClock() {
        let f = periodic(next: nil)
        #expect(text().footer(f, now: now).plain.first == "Up to Nov 15 · fetched 10 min. ago")
        #expect(text().footer(f, now: now.addingTimeInterval(3600)).plain.first == "Up to Nov 15 · fetched 1 hr. ago")
    }

    @Test func datesFollowTheScreenLanguageAndTimesTheDevicesClock() {
        // An English screen on a German device: English dates, a 24-hour clock.
        let english = text(.en, region: germany)
        #expect(english.expected(at("2026-11-16T20:00:00Z"), now: now) == "~21:00")
        #expect(english.footer(periodic(next: nil), now: now).last == "Up to Nov 15")
        // A German screen on a device set to 12 hours.
        let german = text(.de, region: us)
        #expect(german.expected(at("2026-11-16T20:00:00Z"), now: now).hasPrefix("~9:00"))
        #expect(german.footer(periodic(next: nil), now: now).last == "Bis 15. Nov.")
    }

    // MARK: Lists

    @Test func theDetailNamesTheStream() {
        #expect(text().detail(periodic(), now: now) == "Sales up to Nov 15 · next ~21:00")
        #expect(text().detail(continuous(), now: now) == "Reviews checked 10 min. ago · next check ~14:30")
        #expect(text(.de, region: germany).detail(periodic(), now: now) == "Sales bis 15. Nov. · nächste ~21:00")
        #expect(
            text(.de, region: germany).detail(continuous(), now: now)
                == "Reviews geprüft vor 10 Min. · nächste Prüfung ~14:30")
        #expect(text().detail(periodic(), status: .outage, now: now) == "Sales up to Nov 15")
        #expect(
            text().detail(periodic(through: "2026-11-14", late: true), now: now)
                == "Sales up to Nov 14 · Nov 15 not published yet · checking again ~15:10")
    }
}

// MARK: - Decoding

private func metricWidget(freshness: String?) -> String {
    let field = freshness.map { #", "freshness": \#($0)"# } ?? ""
    return """
        {"id": "m1", "type": "metric", "x": 0, "y": 0, "w": 3, "h": 2, "label": "Sales",
         "options": {"showSparkline": true, "showChange": true},
         "data": {"period": "last_7_days", "aggregation": "sum", "value": 12, "unit": "count",
                  "change": {"previousValue": null, "delta": null, "ratio": null}, "spark": [],
                  "status": "ok", "updatedAt": "2026-11-16T12:55:00.000Z"\(field)}}
        """
}

private let fullFreshness = """
    {"kind": "periodic", "stream": "Sales", "fetchedAt": "2026-11-16T11:55:00.000Z", "dataThrough": "2026-11-14",
     "nextExpectedAt": "2026-11-16T20:00:00.000Z", "late": true, "nextCheckAt": "2026-11-16T14:00:00.000Z",
     "futureField": {"x": 1}}
    """

private func slides(_ widgets: String, slideExtra: String = "") -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []\#(slideExtra)}]"#
}

private func metricData(_ payload: DeviceDashboardV2) -> MetricWidgetData? {
    guard case .metric(_, let data) = payload.slides.first?.widgets.first?.content else { return nil }
    return data
}

@Suite struct FreshnessDecodingTests {
    @Test func aMetricWithFreshness() throws {
        let data = try #require(metricData(v3Payload(primaryFormat: "16x9", slides: slides(metricWidget(freshness: fullFreshness)))))
        #expect(
            data.freshness
                == WidgetFreshness(
                    kind: .periodic, stream: "Sales", fetchedAt: "2026-11-16T11:55:00.000Z", dataThrough: "2026-11-14",
                    nextExpectedAt: "2026-11-16T20:00:00.000Z", late: true, nextCheckAt: "2026-11-16T14:00:00.000Z"))
        #expect(data.updatedAt == "2026-11-16T12:55:00.000Z")
    }

    @Test func aMetricWithoutFreshnessIsAsBefore() throws {
        let data = try #require(metricData(v3Payload(primaryFormat: "16x9", slides: slides(metricWidget(freshness: nil)))))
        #expect(data.freshness == nil)
        #expect(data.value == 12)
    }

    @Test func aDamagedFreshnessNeverBreaksTheWidget() throws {
        for damaged in [
            #""stale""#, "42", "null", "[]",
            #"{"kind": "hourly", "stream": "Sales", "fetchedAt": "2026-11-16T11:55:00Z"}"#,
            #"{"kind": "periodic", "stream": "Sales"}"#,
            #"{"kind": "periodic", "fetchedAt": "yesterday"}"#,
        ] {
            let data = try #require(
                metricData(v3Payload(primaryFormat: "16x9", slides: slides(metricWidget(freshness: damaged)))), "\(damaged)")
            #expect(data.freshness == nil, "\(damaged)")
            #expect(data.value == 12)
        }
    }

    @Test func damagedOptionalFieldsAreLeftOut() throws {
        let partial = """
            {"kind": "periodic", "fetchedAt": "2026-11-16T11:55:00Z", "dataThrough": "2026-02-30",
             "period": "week", "nextExpectedAt": 7, "late": "yes", "nextCheckAt": "soon"}
            """
        let data = try #require(metricData(v3Payload(primaryFormat: "16x9", slides: slides(metricWidget(freshness: partial)))))
        let f = try #require(data.freshness)
        #expect(f.stream == "")
        #expect(f.dataThrough == nil)
        #expect(f.monthly == false)
        #expect(f.nextExpectedAt == nil)
        #expect(f.late == false)
        #expect(f.nextCheckAt == nil)
    }

    @Test func everyDataWidgetReadsIt() throws {
        let fresh = #""freshness": {"kind": "continuous", "stream": "Reviews", "fetchedAt": "2026-11-16T11:55:00Z"}"#
        let widgets = [
            #"{"id": "l", "type": "line", "x": 0, "y": 0, "w": 4, "h": 3, "data": {"buckets": [], "values": [], "previous": [], "status": "ok", "updatedAt": null, \#(fresh)}}"#,
            #"{"id": "b", "type": "bar", "x": 4, "y": 0, "w": 4, "h": 3, "data": {"bars": [], "status": "ok", "updatedAt": null, \#(fresh)}}"#,
            #"{"id": "t", "type": "table", "x": 8, "y": 0, "w": 4, "h": 3, "data": {"rows": [], "status": "ok", "updatedAt": null, \#(fresh)}}"#,
            #"{"id": "r", "type": "review", "x": 0, "y": 3, "w": 4, "h": 3, "imageId": null, "data": {"status": "ok", "updatedAt": null, "review": null, \#(fresh)}}"#,
            #"{"id": "c", "type": "compare", "x": 4, "y": 3, "w": 4, "h": 3, "data": {"numerator": {"label": "A", "value": 1, "unit": "count"}, "denominator": {"label": "B", "value": 2, "unit": "count"}, "ratio": {"value": 0.5, "previousValue": null, "format": "percent"}, "status": "ok", "updatedAt": null, \#(fresh)}}"#,
            #"{"id": "g", "type": "gauge", "x": 8, "y": 3, "w": 4, "h": 3, "data": {"status": "ok", "updatedAt": null, "goal": null, "value": null, "target": null, "progress": null, \#(fresh)}}"#,
            #"{"id": "m", "type": "measure", "x": 0, "y": 6, "w": 4, "h": 2, "measureIds": ["x"], "groupBy": [], "data": {"widgetId": "m", "metadata": null, "result": null, "error": null, "exclusions": [], \#(fresh)}}"#,
        ]
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(widgets.joined(separator: ",")))
        let decoded = try #require(payload.slides.first?.widgets)
        let freshness: [WidgetFreshness?] = decoded.map { widget in
            switch widget.content {
            case .line(_, let d): return d.freshness
            case .bar(_, let d): return d.freshness
            case .table(_, let d): return d.freshness
            case .review(_, _, let d): return d.freshness
            case .compare(_, let d): return d.freshness
            case .gauge(_, let d): return d.freshness
            case .measure(_, _, _, let d): return d.freshness
            default: return nil
            }
        }
        #expect(freshness.count == 7)
        #expect(freshness.allSatisfy { $0?.kind == .continuous && $0?.stream == "Reviews" })
    }

    @Test func aMeasureWithADamagedFreshnessStillShows() throws {
        let widget = #"{"id": "m", "type": "measure", "x": 0, "y": 0, "w": 4, "h": 2, "measureIds": ["x"], "groupBy": [], "data": {"metadata": null, "result": null, "error": null, "exclusions": [], "freshness": {"kind": 3}}}"#
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(widget))
        guard case .measure(_, _, _, let data) = payload.slides.first?.widgets.first?.content else {
            Issue.record("measure")
            return
        }
        #expect(data.freshness == nil)
    }

    @Test func itSurvivesTheCache() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(metricWidget(freshness: fullFreshness)))
        let again = try JSONDecoder().decode(DeviceDashboardV2.self, from: JSONEncoder().encode(payload))
        #expect(again == payload)
        #expect(metricData(again)?.freshness?.late == true)
    }
}

// MARK: - Detail sheet

@Suite struct FreshnessDetailTests {
    private func metric(status: DeviceTileStatus = .ok, freshness: WidgetFreshness?) -> DeviceWidget {
        var data = MetricWidgetData(
            period: .last7Days, aggregation: .sum, value: 12, unit: "count",
            change: TileChange(previousValue: nil, delta: nil, ratio: nil), spark: [], status: status,
            updatedAt: "2026-11-16T12:55:00Z")
        data.freshness = freshness
        return DeviceWidget(
            id: "w1", type: "metric", placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), label: "Sales",
            content: .metric(MetricWidgetOptions(), data))
    }

    @Test func theUpdatedRowNamesTheStreamAndTheDay() throws {
        let detail = try #require(
            WidgetDetail.make(metric(freshness: periodic()), now: now, timeZone: berlin, region: us24))
        #expect(detail.text(.updated) == "Sales up to Nov 15 · next ~21:00")
        let german = try #require(
            WidgetDetail.make(metric(freshness: periodic()), now: now, language: .de, timeZone: berlin, region: germany))
        #expect(german.text(.updated) == "Sales bis 15. Nov. · nächste ~21:00")
        let failing = try #require(
            WidgetDetail.make(metric(status: .outage, freshness: periodic()), now: now, timeZone: berlin, region: us24))
        #expect(failing.text(.updated) == "Sales up to Nov 15")
    }

    @Test func withoutFreshnessTheUpdatedRowIsAsBefore() throws {
        let detail = try #require(WidgetDetail.make(metric(freshness: nil), now: now))
        #expect(detail.text(.updated) == "5 minutes ago")
    }

    @Test func aMeasureGetsTheRowWhenItHasFreshness() throws {
        var data = MeasureWidgetData(scope: nil, metadata: nil, result: nil, error: nil, exclusions: [])
        let widget = { (data: MeasureWidgetData) in
            DeviceWidget(
                id: "m", type: "measure", placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), label: "Revenue",
                content: .measure(measureIds: [], groupBy: [], MeasureWidgetOptions(), data))
        }
        #expect(try #require(WidgetDetail.make(widget(data), now: now)).text(.updated) == nil)
        data.freshness = continuous()
        #expect(
            try #require(WidgetDetail.make(widget(data), now: now, timeZone: berlin, region: us24)).text(.updated)
                == "Reviews checked 10 min. ago · next check ~14:30")
    }
}

// MARK: - Slide logo and brand

@Suite struct SlideLogoTests {
    @Test func aSlideLogoReplacesTheDashboards() throws {
        let images = """
            [{"id": "\(logoID)", "sha256": "\(logoHash)", "contentType": "image/png", "width": 10, "height": 10, "bytes": 14, "url": "/v1/device/images/\(logoID)"},
             {"id": "\(backgroundID)", "sha256": "\(backgroundHash)", "contentType": "image/png", "width": 10, "height": 10, "bytes": 21, "url": "/v1/device/images/\(backgroundID)"}]
            """
        let slidesJSON = """
            [{"id": "\(slideA)", "durationSec": 20, "widgets": [], "logo": {"imageId": "\(backgroundID)"}},
             {"id": "\(slideB)", "durationSec": 20, "widgets": []},
             {"id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "durationSec": 20, "widgets": [], "logo": {"imageId": "33333333-3333-4333-8333-333333333333"}},
             {"id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "durationSec": 20, "widgets": [], "logo": "broken"}]
            """
        let payload = v2Payload(slides: slidesJSON, images: images)
        #expect(payload.slides.count == 4)
        #expect(payload.slides[0].logo == SlideLogo(imageId: backgroundID))
        #expect(payload.logoImageId(for: payload.slides[0]) == backgroundID)
        // No logo of its own, one the payload does not list, or a damaged one: the dashboard's.
        #expect(payload.logoImageId(for: payload.slides[1]) == logoID)
        #expect(payload.logoImageId(for: payload.slides[2]) == logoID)
        #expect(payload.slides[3].logo == nil)
        #expect(payload.logoImageId(for: payload.slides[3]) == logoID)
        #expect(payload.logoImageId(for: nil) == logoID)
        let again = try JSONDecoder().decode(DeviceDashboardV2.self, from: JSONEncoder().encode(payload))
        #expect(again.slides[0].logo == SlideLogo(imageId: backgroundID))
    }

    @Test func theBrandIsNeverTranslated() {
        #expect(ServerConfig.cloud.displayName == Brand.cloud)
        #expect(Brand.name == "netrics")
    }
}

// MARK: - Review cadence and prefixed lines

@Suite struct ReviewFreshnessTests {
    private let placement = StudioPlacement(x: 0, y: 0, w: 4, h: 3)

    private func review(status: DeviceTileStatus = .ok, freshness: WidgetFreshness?) -> ReviewWidgetData {
        var data = ReviewWidgetData(
            status: status, updatedAt: "2026-11-16T12:50:00Z",
            review: WidgetReview(
                rating: 5, title: "Finally", body: "Finally a dashboard.", author: nil, territory: "DE",
                createdAt: "2026-11-16T07:02:00Z"))
        data.freshness = freshness
        return data
    }

    private func footer(_ data: ReviewWidgetData, notice: Bool = false, language: ScreenLanguage = .en) -> String? {
        ReviewText.footer(
            data, notice: notice, placement: placement, showHeader: true, fontScale: 1, now: now, language: language,
            timeZone: berlin, region: language == .en ? us24 : germany)
    }

    @Test func theReviewCadenceShowsInTheNoticeSlot() {
        #expect(footer(review(freshness: continuous())) == "Checked 10 min. ago · next check ~14:30")
        // The longer German line drops its last part where it would wrap.
        let german = footer(review(freshness: continuous()), language: .de)
        #expect(german == "Geprüft vor 10 Min." || german == "Geprüft vor 10 Min. · nächste Prüfung ~14:30")
        #expect(
            ReviewText.footer(
                review(freshness: continuous()), notice: false, placement: StudioPlacement(x: 0, y: 0, w: 6, h: 3),
                showHeader: true, fontScale: 1, now: now, language: .de, timeZone: berlin, region: germany)
                == "Geprüft vor 10 Min. · nächste Prüfung ~14:30")
        // A notice keeps the slot; without freshness there is no line, as before.
        #expect(footer(review(freshness: continuous()), notice: true) == nil)
        #expect(footer(review(freshness: nil)) == nil)
        // A failing source: no next check.
        #expect(footer(review(status: .outage, freshness: continuous())) == "Checked 10 min. ago")
    }

    @Test func theLineUsesTheNoticesRoomSoTheSharedLayoutHolds() throws {
        // The line is laid out as a notice: reviewLayout(notice: true), a
        // shape the shared layout already has, never a new one.
        let box = StudioRender.contentBox(placement, showHeader: true)
        func layout(notice: Bool) -> StudioLayout.ReviewLayout {
            StudioLayout.reviewLayout(
                label: "Latest review · Wurfel", width: box.width, height: box.height, fontScale: 1, icon: true,
                title: "Finally", body: "Finally a dashboard.", notice: notice)
        }
        #expect(layout(notice: true).bodyLines <= layout(notice: false).bodyLines)
        // It fits the slot's one line at the slot's size.
        let line = try #require(footer(review(freshness: continuous())))
        #expect(
            StudioLayout.wrappedLineCount(line, maxWidth: box.width, fontSize: layout(notice: true).sizes.author) == 1)
    }

    @Test func aLineAfterAPrefixStartsLowerCase() {
        let compare = CompareText.footerCandidates(updatedAt: nil, freshness: continuous(), now: now, language: .en)
        #expect(compare.first?.hasPrefix("derived · checked ") == true)
        #expect(compare.last == "derived")
        #expect(FreshnessText.midLine("Up to Nov 15") == "up to Nov 15")
        #expect(FreshnessText.midLine("Geprüft vor 10 Min.") == "geprüft vor 10 Min.")
        // Without freshness the compare footer is as before.
        #expect(
            CompareText.footerCandidates(updatedAt: "2026-11-16T12:55:00Z", now: now)
                == ["derived · updated 5 min. ago", "derived"])
        // On its own a line keeps its capital.
        #expect(text().footer(continuous(), now: now).first?.hasPrefix("Checked") == true)
    }
}

// MARK: - Measure status and failing review cards (Codex review of #725)

@Suite struct FreshnessStatusTests {
    private func measure(status: String?, sources: String = "ok") throws -> MeasureWidgetData {
        let statusField = status.map { #""status": "\#($0)", "# } ?? ""
        let json = """
            {\(statusField)"widgetId": "11111111-1111-4111-8111-111111111111",
             "sourceHealth": [{"connectionId": "22222222-2222-4222-8222-222222222222", "name": "App Store",
                               "status": "\(sources)", "lastSuccessAt": "2026-11-16T12:50:00Z"}],
             "metadata": null, "result": null, "error": null, "exclusions": [],
             "freshness": {"kind": "periodic", "stream": "Sales", "fetchedAt": "2026-11-16T12:50:00Z",
                           "dataThrough": "2026-11-14", "nextExpectedAt": "2026-11-15T20:00:00Z", "late": true,
                           "nextCheckAt": "2026-11-16T14:10:00Z"}}
            """
        return try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
    }

    @Test func anOverdueMeasureIsStaleThoughItsSourcesAreOk() throws {
        // The server marks a provider a day overdue on the widget's own status;
        // its sources stay "ok" (apps/server/src/dashboards/data.ts).
        let overdue = try measure(status: "stale")
        #expect(overdue.freshnessStatus == .stale)
        let lines = overdue.freshnessLines(now: now, language: .en, timeZone: berlin, region: us24)
        #expect(lines.warning == "Up to Nov 14 · Nov 15 not published yet")
        #expect(lines.footer.allSatisfy { !$0.contains("checking again") })
        // Late under a day: the muted wording, no warning.
        let late = try measure(status: "ok")
        #expect(late.freshnessStatus == .ok)
        let muted = late.freshnessLines(now: now, language: .en, timeZone: berlin, region: us24)
        #expect(muted.warning == nil)
        #expect(muted.footer.plain.first == "Up to Nov 14 · Nov 15 not published yet · checking again ~15:10")
        // A server before the field, and an unknown value: the sources decide.
        #expect(try measure(status: nil).freshnessStatus == .ok)
        #expect(try measure(status: "melting").freshnessStatus == .ok)
        #expect(try measure(status: nil, sources: "outage").freshnessStatus == .outage)
        #expect(try measure(status: "outage").freshnessStatus == .outage)
    }

    /// A measure with the oldest source refresh, and the given freshness.
    private func refreshed(freshness: String?, status: String = "ok", sources: String = "ok") throws
        -> MeasureWidgetData
    {
        let json = """
            {"status": "\(status)", "widgetId": "11111111-1111-4111-8111-111111111111",
             "sourceHealth": [{"connectionId": "22222222-2222-4222-8222-222222222222", "name": "App Store",
                               "status": "\(sources)", "lastSuccessAt": "2026-11-16T12:50:00Z"}],
             "metadata": null, "error": null, "exclusions": [],
             "result": {"releaseId": null, "rows": [], "warnings": [], "operations": 1, "provenance": [],
                        "appliedFilter": null, "groupBy": [], "stale": false, "receivedAt": "2026-11-13T11:08:00Z"}
             \(freshness.map { #", "freshness": \#($0)"# } ?? "")}
            """
        return try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
    }

    @Test func theOldestSourceRefreshShowsOnlyWithoutAFreshnessLine() throws {
        let periodic = #"""
            {"kind": "periodic", "stream": "Sales", "fetchedAt": "2026-11-16T12:50:00Z",
             "dataThrough": "2026-11-15", "nextExpectedAt": "2026-11-16T20:00:00Z"}
            """#
        let continuous = #"""
            {"kind": "continuous", "stream": "Reviews", "fetchedAt": "2026-11-16T12:50:00Z",
             "nextCheckAt": "2026-11-16T13:30:00Z"}
            """#
        func shows(_ data: MeasureWidgetData) -> Bool {
            data.showsFreshnessLine(now: now, language: .en, timeZone: berlin, region: us24)
        }
        // No freshness: the refresh age is the tile's time.
        let bare = try refreshed(freshness: nil)
        #expect(bare.result?.receivedAt != nil)
        #expect(!shows(bare))
        // A periodic or continuous line replaces it, also under a failing source.
        #expect(shows(try refreshed(freshness: periodic)))
        #expect(shows(try refreshed(freshness: continuous)))
        #expect(shows(try refreshed(freshness: continuous, sources: "auth_failed")))
        #expect(shows(try refreshed(freshness: continuous, status: "outage")))
    }

    @Test func aPausedReviewCardNeverPromisesTheNextCheck() {
        var data = ReviewWidgetData(status: .authFailed, updatedAt: "2026-11-16T12:50:00Z")
        data.freshness = continuous()
        #expect(
            ReviewText.scrollFooter(data, now: now, language: .en, timeZone: berlin, region: us24)
                == "Checked 10 min. ago")
        data.status = .ok
        #expect(
            ReviewText.scrollFooter(data, now: now, language: .en, timeZone: berlin, region: us24)
                == "Checked 10 min. ago · next check ~14:30")
        data.freshness = nil
        #expect(ReviewText.scrollFooter(data, now: now) == nil)
    }
}
