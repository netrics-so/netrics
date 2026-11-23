import Foundation
import Testing

@testable import NetricsKit

// The last reporting day (#791, ADR 0025 section 8). On 19 Nov the App
// Store's reports reach 17 Nov and Google Play's 11 Nov, both checked
// minutes ago. "Up to Nov 11" alone reads as if netrics had not checked
// since, so the day is named where it is older than the day of the last
// check and the tile has room; a tile without room shows what it showed
// before.

private let berlin = TimeZone(identifier: "Europe/Berlin")!
private let honolulu = TimeZone(identifier: "Pacific/Honolulu")!
private let us24 = Locale(identifier: "en_US@hours=h23")
private let germany = Locale(identifier: "de_DE")
private func at(_ iso: String) -> Date { ISODate.parse(iso)! }
/** Thursday, 19 Nov 2026, 10:00 in Berlin. */
private let now = at("2026-11-19T09:00:00Z")
private let checked = "2026-11-19T08:50:00Z"

private let appStore = WidgetFreshness(
    kind: .periodic, stream: "Sales", fetchedAt: checked, dataThrough: "2026-11-17",
    nextExpectedAt: "2026-11-19T20:00:00Z")
private let play = WidgetFreshness(
    kind: .periodic, stream: "Installs", fetchedAt: checked, dataThrough: "2026-11-11")
private func product(_ sources: [(String, WidgetFreshness)]) -> WidgetFreshness {
    var f = sources.last!.1
    f.sources = sources.map { WidgetFreshnessSource(source: $0.0, freshness: $0.1) }
    return f
}
private func through(_ f: WidgetFreshness, _ day: String) -> WidgetFreshness {
    var f = f
    f.dataThrough = day
    return f
}

private func en(_ zone: TimeZone = berlin) -> FreshnessText {
    FreshnessText(language: .en, timeZone: zone, region: us24)
}
private let de = FreshnessText(language: .de, timeZone: berlin, region: germany)

@Suite struct ReportingDayTests {
    @Test func appStoreReportsUpTo17NovCheckedOn19Nov() {
        #expect(
            en().footer(appStore, now: now) == [
                "Last reporting day: Nov 17 · fetched 10 min. ago · next ~21:00",
                "Up to Nov 17 · fetched 10 min. ago · next ~21:00",
                "Last reporting day: Nov 17 · fetched 10 min. ago",
                "Up to Nov 17 · fetched 10 min. ago",
                "Last reporting day: Nov 17",
                "Up to Nov 17",
            ])
        #expect(
            de.footer(appStore, now: now) == [
                "Letzter Berichtstag: 17. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
                "Bis 17. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
                "Letzter Berichtstag: 17. Nov. · abgerufen vor 10 Min.",
                "Bis 17. Nov. · abgerufen vor 10 Min.",
                "Letzter Berichtstag: 17. Nov.",
                "Bis 17. Nov.",
            ])
    }

    @Test func googlePlayReportsUpTo11NovCheckedOn19Nov() {
        #expect(
            en().footer(play, now: now) == [
                "Last reporting day: Nov 11 · fetched 10 min. ago",
                "Up to Nov 11 · fetched 10 min. ago",
                "Last reporting day: Nov 11",
                "Up to Nov 11",
            ])
        #expect(
            de.footer(play, now: now) == [
                "Letzter Berichtstag: 11. Nov. · abgerufen vor 10 Min.",
                "Bis 11. Nov. · abgerufen vor 10 Min.",
                "Letzter Berichtstag: 11. Nov.",
                "Bis 11. Nov.",
            ])
    }

    @Test func aDayThatIsTheDayOfTheCheckLeavesTheLineAsItWas() {
        // A source whose reports reach today (an ad account's running day).
        let today = through(appStore, "2026-11-19")
        #expect(!en().reportingDayBeforeCheck(today))
        #expect(
            en().footer(today, now: now) == [
                "Up to Nov 19 · fetched 10 min. ago · next ~21:00",
                "Up to Nov 19 · fetched 10 min. ago",
                "Up to Nov 19",
            ])
        #expect(
            de.footer(today, now: now) == [
                "Bis 19. Nov. · abgerufen vor 10 Min. · nächste ~21:00",
                "Bis 19. Nov. · abgerufen vor 10 Min.",
                "Bis 19. Nov.",
            ])
    }

    @Test func comparesTheProvidersDayWithTheChecksDayOnThisDevice() {
        // Checked at 08:50 UTC on 19 Nov: still 18 Nov in Honolulu.
        let yesterday = through(appStore, "2026-11-18")
        #expect(en(berlin).reportingDayBeforeCheck(yesterday))
        #expect(!en(honolulu).reportingDayBeforeCheck(yesterday))
        // A check days ago: the day of that check counts, not today.
        var old = appStore
        old.fetchedAt = "2026-11-17T10:00:00Z"
        #expect(!en().reportingDayBeforeCheck(old))
    }

    @Test func notForMonthsContinuousStreamsOrAStreamWithoutADay() {
        var monthly = through(play, "2026-10-31")
        monthly.monthly = true
        #expect(en().footer(monthly, now: now) == ["Up to October · fetched 10 min. ago", "Up to October"])
        let continuous = WidgetFreshness(kind: .continuous, stream: "Traffic", fetchedAt: checked)
        #expect(en().footer(continuous, now: now) == ["Checked 10 min. ago"])
        var noDay = play
        noDay.dataThrough = nil
        #expect(en().footer(noDay, now: now) == ["fetched 10 min. ago"])
    }

    @Test func lateAndUnderAWarningTheDayIsNamedTheSameWay() {
        var late = appStore
        late.late = true
        late.nextExpectedAt = "2026-11-18T20:00:00Z"
        late.nextCheckAt = "2026-11-19T09:20:00Z"
        #expect(
            en().footer(late, now: now) == [
                "Last reporting day: Nov 17 · Nov 18 not published yet · checking again ~10:20",
                "Up to Nov 17 · Nov 18 not published yet · checking again ~10:20",
                "Last reporting day: Nov 17 · Nov 18 not published yet",
                "Up to Nov 17 · Nov 18 not published yet",
                "Last reporting day: Nov 17",
                "Up to Nov 17",
            ])
        #expect(de.footer(appStore, status: .outage, now: now) == ["Letzter Berichtstag: 17. Nov.", "Bis 17. Nov."])
        // The warning notice, the detail sheet and a status board keep their words.
        #expect(
            en().notice(appStore, status: .outage, notice: "Source unreachable", now: now)
                == "Source unreachable · Up to Nov 17")
        #expect(en().detail(appStore, now: now) == "Sales up to Nov 17 · next ~21:00")
        let stream = StatusStream(key: "sales", freshness: appStore, overdue: false)
        #expect(
            en().streamCandidates(stream, paused: false, now: now).first
                == "Sales up to Nov 17 · fetched 10 min. ago · next ~21:00")
    }

    @Test func aProductSlideOverBothStoresNamesEachStoresDay() {
        let both = product([("App Store", appStore), ("Google Play", play)])
        #expect(
            en().sourceLevels(both, now: now) == [
                [
                    "App Store last reporting day: Nov 17 · next ~21:00 · Google Play last reporting day: Nov 11 · fetched 10 min. ago"
                ],
                ["App Store up to Nov 17 · next ~21:00 · Google Play up to Nov 11 · fetched 10 min. ago"],
                ["App Store last reporting day: Nov 17 · next ~21:00 · Google Play last reporting day: Nov 11"],
                ["App Store up to Nov 17 · next ~21:00 · Google Play up to Nov 11"],
                ["App Store last reporting day: Nov 17 · Google Play last reporting day: Nov 11"],
                ["App Store up to Nov 17 · Google Play up to Nov 11"],
                ["App Store up to 11/17 · Google Play up to 11/11"],
                ["App Store 11/17 · Google Play 11/11"],
                ["App Store up to 11/17", "Google Play up to 11/11"],
            ])
        #expect(
            de.sourceLevels(both, now: now) == [
                [
                    "App Store letzter Berichtstag: 17. Nov. · nächste ~21:00 · Google Play letzter Berichtstag: 11. Nov. · abgerufen vor 10 Min."
                ],
                ["App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov. · abgerufen vor 10 Min."],
                ["App Store letzter Berichtstag: 17. Nov. · nächste ~21:00 · Google Play letzter Berichtstag: 11. Nov."],
                ["App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov."],
                ["App Store letzter Berichtstag: 17. Nov. · Google Play letzter Berichtstag: 11. Nov."],
                ["App Store bis 17. Nov. · Google Play bis 11. Nov."],
                ["App Store bis 17.11. · Google Play bis 11.11."],
                ["App Store 17.11. · Google Play 11.11."],
                ["App Store bis 17.11.", "Google Play bis 11.11."],
            ])
    }

    @Test func namesOnlyTheSourcesWhoseDayIsOlderThanTheirCheck() {
        let ads = through(appStore, "2026-11-19")
        let mixed = product([("Apple Ads", ads), ("Google Play", play)])
        #expect(
            en().sourceForms(mixed, now: now)[2].named
                == ["Apple Ads up to Nov 19 · Google Play last reporting day: Nov 11"])
        // No source's day is older: the forms are the ones before, alone.
        let same = product([("Apple Ads", ads), ("Google Play", through(play, "2026-11-19"))])
        let forms = en().sourceForms(same, now: now)
        #expect(forms.allSatisfy { $0.named == nil })
        #expect(en().sourceLevels(same, now: now) == forms.map(\.lines))
        #expect(
            forms[0].lines == ["Apple Ads up to Nov 19 · next ~21:00 · Google Play up to Nov 19 · fetched 10 min. ago"])
    }

    /// A smaller tile drops the named day before any part it shows today:
    /// at every width the form is the one from before, named or not.
    @Test func aSmallerTileDropsTheNamedDayFirst() {
        let both = product([("App Store", appStore), ("Google Play", play)])
        let data = MeasureWidgetData(scope: nil, metadata: nil, result: nil, error: nil, exclusions: [], freshness: both)
        let forms = en().sourceForms(both, now: now)
        let before = forms.map(\.lines)
        var named = 0
        var plain = 0
        for width in stride(from: 200.0, through: 2400.0, by: 8.0) {
            let was = before[
                StudioLayout.freshnessLevelFit(levels: before, width: width, fontScale: 1, font: .tv, points: nil)]
            let form = forms.first { $0.lines == was }!
            let shown = data.freshnessSourceLines(
                width: width, fontScale: 1, now: now, language: .en, timeZone: berlin, region: us24)
            #expect(shown == was || shown == form.named)
            if shown == was { plain += 1 } else { named += 1 }
        }
        #expect(named > 0 && plain > 0)
        // The same for one source's line, as a tile fits its candidates.
        let candidates = en().footer(appStore, now: now)
        let old = candidates.filter { !$0.hasPrefix("Last reporting day") }
        for width in stride(from: 100.0, through: 1400.0, by: 8.0) {
            let fits = { (line: String) in StudioLayout.wrappedLineCount(line, maxWidth: width, fontSize: 24) <= 1 }
            guard let was = old.first(where: fits), let shown = candidates.first(where: fits) else { continue }
            #expect(shown == was || shown == candidates[candidates.firstIndex(of: was)! - 1])
        }
        // A scroll card wraps: the form without "fetched", its days named.
        #expect(
            data.freshnessSourceLines(
                width: nil, fontScale: 1, now: now, language: .en, timeZone: berlin, region: us24)
                == ["App Store last reporting day: Nov 17 · next ~21:00 · Google Play last reporting day: Nov 11"])
    }
}
