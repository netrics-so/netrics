import Foundation
import Testing

@testable import NetricsKit

// The polished TV design (ADR 0018 sections 5 and 6, #313), case for case
// with the web's tests: studio-theme.test.ts (themeSurface, the auth failed
// surface), widgets.test.tsx (the freshness footer), refresh-countdown.test.ts,
// enter-motion.test.ts and tile-status / widget-parts (data surfaces).

/** The built-in themes of packages/domain/src/theme.ts, value for value. */
enum BuiltinThemes {
    static let netricsDark = ThemeTokens.netricsDark
    static let light = ThemeTokens(
        background: "#eef0f3", surface: "#ffffff", border: "#d5d9e0", text: "#14171c", label: "#343a44",
        muted: "#5a616c", accent: "#2f5fd0", up: "#1a7f37", down: "#c22f2f", warning: "#8f5f00",
        chartLine: "#7a828e", chartFill: "#9db6ee", fontScale: 1)
    static let highContrast = ThemeTokens(
        background: "#000000", surface: "#000000", border: "#ffffff", text: "#ffffff", label: "#ffffff",
        muted: "#d9d9d9", accent: "#ffd60a", up: "#5cf08a", down: "#ff8080", warning: "#ffd60a",
        chartLine: "#ffffff", chartFill: "#ffd60a", fontScale: 1.15)
    static let midnight = ThemeTokens(
        background: "#050a1a", surface: "#0c1630", border: "#1f2d52", text: "#e8eefc", label: "#c2cdec",
        muted: "#8d9cc2", accent: "#5cc8ff", up: "#7ee2a8", down: "#ff9e9e", warning: "#f2c14e",
        chartLine: "#6b7fb3", chartFill: "#2c4c94", fontScale: 1)
    static let paper = ThemeTokens(
        background: "#f2ede2", surface: "#fbf8f1", border: "#ddd3bf", text: "#2b2620", label: "#474036",
        muted: "#6b6252", accent: "#a64b22", up: "#2e6e31", down: "#a8281f", warning: "#865600",
        chartLine: "#8c7e68", chartFill: "#dcc19c", fontScale: 1)

    static let all: [(String, ThemeTokens)] = [
        ("netrics_dark", netricsDark), ("light", light), ("high_contrast", highContrast), ("midnight", midnight),
        ("paper", paper),
    ]
}

@Suite struct ThemeSurfaceTests {
    @Test func layersDarkThemesWithHairlineBordersAndKeepsTheOthersFlat() {
        #expect(ThemeSurface(BuiltinThemes.netricsDark) == .layered)
        #expect(ThemeSurface(BuiltinThemes.midnight) == .layered)
        #expect(ThemeSurface(BuiltinThemes.light) == .flat)
        #expect(ThemeSurface(BuiltinThemes.paper) == .flat)
        #expect(ThemeSurface(BuiltinThemes.highContrast) == .flat)
    }

    @Test func decidesACustomThemeByItsTokens() {
        var dark = BuiltinThemes.netricsDark
        dark.border = "#ffffff"
        #expect(ThemeSurface(dark) == .flat)
        dark = BuiltinThemes.netricsDark
        dark.background = "#fafafa"
        #expect(ThemeSurface(dark) == .flat)
        dark = BuiltinThemes.netricsDark
        dark.surface = "#202020"
        #expect(ThemeSurface(dark) == .layered)
        // Not #rrggbb: the plain surface.
        #expect(ThemeSurface(background: "black", surface: "#11141a", border: "#23272e") == .flat)
    }

    @Test func mixesAsCSSColorMixInSRGB() {
        let a = ThemeColor.parse("#11141a")!
        let b = ThemeColor.parse("#7aa2f7")!
        #expect(a.mixed(1, with: b).hex == "#11141a")
        #expect(a.mixed(0, with: b).hex == "#7aa2f7")
        // 0x11 · 0.95 + 0x7a · 0.05 = 22.25 → 0x16, and so on.
        #expect(a.mixed(0.95, with: b).hex == "#161b25")
        #expect(ThemeColor.contrastRatio(.parse("#000000")!, .parse("#ffffff")!) == 21)
    }

    @Test func derivesTheLayeredAndFlatSurfaces() {
        let dark = DerivedSurfaces(BuiltinThemes.netricsDark)
        #expect(dark.kind == .layered)
        #expect(dark.widgetTop.hex == "#161b25")
        // surface 80 % towards the background.
        #expect(dark.widgetBottom.hex == "#0f1217")
        #expect(dark.canvasGlow == TintedColor(.parse("#7aa2f7")!, 0.1))
        #expect(dark.staleBorder.opacity == 0.35)
        #expect(dark.barStart != dark.barEnd)

        let paper = DerivedSurfaces(BuiltinThemes.paper)
        #expect(paper.kind == .flat)
        #expect(paper.widgetTop.hex == "#fbf8f1")
        #expect(paper.widgetBottom.hex == "#fbf8f1")
        #expect(paper.canvasGlow == nil)
        #expect(paper.staleBorder == TintedColor(.parse("#865600")!))
        #expect(paper.authBorder == TintedColor(.parse("#a8281f")!))
        #expect(paper.barStart == paper.barEnd)
    }

    // As globals.css derives it (#311): Reconnect (down) and the hint
    // (muted) stay readable on the auth failed surface of every built-in.
    @Test(arguments: BuiltinThemes.all.map(\.0))
    func keepsReconnectAndTheHintReadable(_ key: String) {
        let tokens = BuiltinThemes.all.first { $0.0 == key }!.1
        let derived = DerivedSurfaces(tokens)
        let surfaces = derived.kind == .layered ? [derived.authTop, derived.authBottom] : [derived.authTop]
        // The web test rounds each mix to 8 bits; so does this one.
        for surface in surfaces.map({ ThemeColor.parse($0.hex)! }) {
            #expect(ThemeColor.contrastRatio(.parse(tokens.down)!, surface) >= 3, "\(key) down")
            #expect(ThemeColor.contrastRatio(.parse(tokens.muted)!, surface) >= 3, "\(key) muted")
        }
    }
}

@Suite struct DataSurfaceTests {
    @Test func mapsTheStatusesWithASurfaceOfTheirOwn() {
        #expect(DataSurface(.authFailed) == .authFailed)
        #expect(DataSurface(.noData) == .noData)
        #expect(DataSurface(.backfilling) == .backfilling)
        #expect(DataSurface(.ok) == nil)
        #expect(DataSurface(.stale) == nil)
        #expect(DataSurface(.outage) == nil)
    }

    @Test func decodesBackfillingAndUnknownStatusesInWidgetData() throws {
        let body = """
            {"period":"today","aggregation":"sum","value":null,"unit":null,
             "change":{"previousValue":null,"delta":null,"ratio":null},"spark":[],
             "status":"backfilling","updatedAt":null,"conversion":null,"better":"higher"}
            """
        let data = try JSONDecoder().decode(MetricWidgetData.self, from: Data(body.utf8))
        #expect(data.status == .backfilling)
        #expect(DataSurface(data.status) == .backfilling)
    }

    @Test func wordsTheStatesInBothLanguages() {
        #expect(DataSurface.authFailed.texts(source: nil, language: .en).headline == "Reconnect the source")
        #expect(DataSurface.authFailed.texts(source: " Stripe ", language: .en).headline == "Reconnect Stripe")
        #expect(DataSurface.authFailed.texts(source: "Stripe", language: .de).headline == "Stripe neu verbinden")
        #expect(DataSurface.authFailed.texts(source: "", language: .de).headline == "Quelle neu verbinden")
        #expect(
            DataSurface.authFailed.texts(source: nil, language: .en).hint
                == "Access was rejected. An admin can fix this under Connections.")
        #expect(DataSurface.backfilling.texts(source: nil, language: .en).hint == "Loading history…")
        #expect(DataSurface.backfilling.texts(source: nil, language: .de).hint == "Verlauf wird geladen …")
        #expect(DataSurface.noData.texts(source: nil, language: .en) == (nil, "No data yet"))
        #expect(DataSurface.noData.texts(source: nil, language: .de).hint == "Noch keine Daten")
    }

    @Test func keepsTheReconnectLineAtItsDesignSize() {
        #expect(DataSurface.reconnectSize(small: 24) == 28.5)
        #expect(DataSurface.reconnectSize(small: 27.6) == 27.6 * 1.1875)
    }
}

@Suite struct WidgetFooterTests {
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    func ago(_ seconds: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-seconds))
    }

    @Test func wordsRelativeTimesAsIntlDoes() {
        // new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
        let cases: [(TimeInterval, String, String)] = [
            (10, "now", "jetzt"),
            (60, "1 min. ago", "vor 1 Min."),
            (5 * 60, "5 min. ago", "vor 5 Min."),
            (3600, "1 hr. ago", "vor 1 Std."),
            (2 * 3600, "2 hr. ago", "vor 2 Std."),
            (86400, "yesterday", "gestern"),
            (3 * 86400, "3 days ago", "vor 3 Tagen"),
            (-2 * 3600, "in 2 hr.", "in 2 Std."),
        ]
        for (seconds, en, de) in cases {
            #expect(WidgetFooter.relativeTime(ago(seconds), now: now, language: .en) == en, "\(seconds)")
            #expect(WidgetFooter.relativeTime(ago(seconds), now: now, language: .de) == de, "\(seconds)")
        }
        #expect(WidgetFooter.relativeTime(nil, now: now) == nil)
        #expect(WidgetFooter.relativeTime("yesterday", now: now) == nil)
    }

    @Test func offersTheCandidatesLongestFirst() {
        #expect(
            WidgetFooter.candidates(updatedAt: ago(300), source: "App Store Connect", now: now)
                == ["updated 5 min. ago · App Store Connect", "updated 5 min. ago", "App Store Connect"])
        #expect(
            WidgetFooter.candidates(updatedAt: ago(300), source: "App Store Connect", now: now, language: .de)
                == ["aktualisiert vor 5 Min. · App Store Connect", "aktualisiert vor 5 Min.", "App Store Connect"])
        // Screens: no source name in the payload.
        #expect(WidgetFooter.candidates(updatedAt: ago(300), source: nil, now: now) == ["updated 5 min. ago"])
        #expect(WidgetFooter.candidates(updatedAt: nil, source: "  ", now: now) == [])
    }

    @Test func takesTheFirstCandidateThatFitsOneLine() {
        let wide = StudioPlacement(x: 0, y: 0, w: 6, h: 4)
        let candidates = WidgetFooter.candidates(updatedAt: ago(300), source: "App Store Connect", now: now)
        #expect(
            WidgetFooter.line(candidates, type: .metric, placement: wide, showHeader: true, fontScale: 1)
                == "updated 5 min. ago · App Store Connect")
        let narrow = StudioPlacement(x: 0, y: 0, w: 3, h: 4)
        let long = WidgetFooter.candidates(
            updatedAt: ago(300), source: "App Store Connect for Wurfel and Paperstand", now: now)
        #expect(
            WidgetFooter.line(long, type: .metric, placement: narrow, showHeader: true, fontScale: 1)
                == "updated 5 min. ago")
        #expect(WidgetFooter.line([], type: .metric, placement: wide, showHeader: true, fontScale: 1) == nil)
    }

    @Test func givesChartsTheFooterWhileTheChartKeepsItsRoom() {
        let footer = "updated 2 min. ago · Search Console"
        let line = WidgetFooter.chartLayout(
            type: .line, label: "Clicks · example.com", value: ("122", "122"), notice: nil, footer: footer,
            placement: StudioPlacement(x: 0, y: 0, w: 6, h: 5), showHeader: true, fontScale: 1)
        #expect(line.footer == footer)
        #expect(line.layout.chartHeight >= WidgetFooter.minChart)

        let bar = WidgetFooter.chartLayout(
            type: .bar, label: "Downloads by app", value: nil, notice: nil, footer: "updated 1 min. ago",
            placement: StudioPlacement(x: 0, y: 0, w: 4, h: 5), showHeader: true, fontScale: 1)
        #expect(bar.footer == "updated 1 min. ago")

        // A chart that would get too small keeps its room: no footer.
        let crowded = WidgetFooter.chartLayout(
            type: .line, label: "Proceeds in every currency · Paperstand – Magazine reader for iPad",
            value: ("€12,345.67", "€12.3K"), notice: nil, footer: "updated 2 min. ago",
            placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), showHeader: true, fontScale: 1)
        #expect(crowded.footer == nil)
        let plain = StudioRender.chartLayout(
            type: .line, label: "Proceeds in every currency · Paperstand – Magazine reader for iPad",
            value: ("€12,345.67", "€12.3K"), notice: nil, placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3),
            showHeader: true, fontScale: 1)
        #expect(crowded.layout == plain)

        // A notice takes the line instead.
        let noticed = WidgetFooter.chartLayout(
            type: .line, label: "Clicks", value: ("122", "122"), notice: "Last sync 3 hours ago", footer: footer,
            placement: StudioPlacement(x: 0, y: 0, w: 6, h: 5), showHeader: true, fontScale: 1)
        #expect(noticed.footer == nil)
    }
}

@Suite struct RefreshCountdownTests {
    let since = Date(timeIntervalSince1970: 1_000)

    @Test func countsTheWholeSecondsDownToTheNextRefresh() {
        #expect(RefreshCountdown.at(since, since: since, every: 60) == RefreshCountdown(seconds: 60, fraction: 0))
        let later = RefreshCountdown.at(since.addingTimeInterval(18.4), since: since, every: 60)
        #expect(later.seconds == 42)
        #expect(abs(later.fraction - 18.4 / 60) < 1e-9)
        #expect(RefreshCountdown.at(since.addingTimeInterval(59.999), since: since, every: 60).seconds == 1)
    }

    @Test func startsOverWhenARefreshIsLateNeverBelowOneSecond() {
        #expect(
            RefreshCountdown.at(since.addingTimeInterval(60), since: since, every: 60)
                == RefreshCountdown(seconds: 60, fraction: 0))
        #expect(RefreshCountdown.at(since.addingTimeInterval(75), since: since, every: 60).seconds == 45)
        // A clock behind the last refresh: the full cycle.
        #expect(RefreshCountdown.at(since.addingTimeInterval(-5), since: since, every: 60).seconds == 60)
    }

    @Test func takesTheCadenceFromThePayloadLikeTheKiosk() {
        #expect(RefreshCountdown.cycle(updatedAt: nil, offline: false, refreshAfterSec: 60) == nil)
        #expect(RefreshCountdown.cycle(updatedAt: since, offline: true, refreshAfterSec: 60) == nil)
        #expect(RefreshCountdown.cycle(updatedAt: since, offline: false, refreshAfterSec: 30)?.every == 30)
        #expect(RefreshCountdown.cycle(updatedAt: since, offline: false, refreshAfterSec: 0)?.every == 60)
    }

    @Test func fitsBesideShortNamesAndIsLeftOutBeforeANameIsCut() {
        let sample = RefreshCountdown.sample(.en)
        #expect(sample == "next refresh in 88 s")
        #expect(RefreshCountdown.sample(.de) == "nächste Aktualisierung in 88 s")
        let short = StudioLayout.headerFit(name: "Sales", slideName: "Overview", format: .widescreen, logoAspect: nil)
        #expect(RefreshCountdown.fits(short, name: "Sales", slideName: "Overview", pageLabel: nil, sample: sample))
        let longName = "Company-wide revenue, subscriptions and downloads across every product line"
        let long = StudioLayout.headerFit(name: longName, slideName: nil, format: .widescreen, logoAspect: nil)
        #expect(!RefreshCountdown.fits(long, name: longName, slideName: nil, pageLabel: nil, sample: sample))
        // Narrow formats wrap the name: no countdown.
        let tall = StudioLayout.headerFit(name: "Sales", slideName: nil, format: .tall, logoAspect: nil)
        #expect(!RefreshCountdown.fits(tall, name: "Sales", slideName: nil, pageLabel: nil, sample: sample))
    }
}

@Suite struct SlideFooterTests {
    @Test func saysWhereTheRotationIsAndWhatComesNext() {
        #expect(
            SlideFooter.text(position: 2, count: 3, name: "Sales", next: "Team", language: .en)
                == "2 / 3 · Sales · next: Team")
        #expect(
            SlideFooter.text(position: 2, count: 3, name: "Sales", next: "Team", language: .de)
                == "2 / 3 · Sales · als Nächstes: Team")
        #expect(SlideFooter.text(position: 1, count: 2, name: nil, next: nil, language: .en) == "1 / 2")
        #expect(SlideFooter.entryName(slideName: "Sales", pageLabel: "2/2") == "Sales 2/2")
        #expect(SlideFooter.entryName(slideName: " ", pageLabel: "2/2") == nil)
        #expect(SlideFooter.entryName(slideName: "Sales", pageLabel: nil) == "Sales")
    }

    @Test func measuresTheSlidesTimeAndHoldsItWhilePaused() {
        let start = Date(timeIntervalSince1970: 0)
        var rotation = SlideRotation(
            slides: [.init(id: "a", durationSec: 20), .init(id: "b", durationSec: 10)], autoAdvance: true, now: start)
        #expect(rotation.progress(at: start) == 0)
        #expect(rotation.progress(at: start.addingTimeInterval(5)) == 0.25)
        #expect(rotation.currentDuration == 20)
        rotation.togglePause(now: start.addingTimeInterval(10))
        #expect(rotation.progress(at: start.addingTimeInterval(15)) == 0.5)
        rotation.togglePause(now: start.addingTimeInterval(30))
        #expect(rotation.progress(at: start.addingTimeInterval(35)) == 0.75)
    }
}

@Suite struct EnterMotionTests {
    @Test func easesOutCubicClamped() {
        #expect(EnterMotion.easeOutCubic(0) == 0)
        #expect(EnterMotion.easeOutCubic(0.5) == 0.875)
        #expect(EnterMotion.easeOutCubic(1) == 1)
        #expect(EnterMotion.easeOutCubic(-1) == 0)
        #expect(EnterMotion.easeOutCubic(2) == 1)
    }

    @Test func staggersTableRowsBy90msEach400msLong() {
        // At 450 ms into the enter (eased progress of t = 0.375): row 0 has
        // risen for 450 ms (done), row 1 for 360 ms, row 5 just starts.
        let eased = EnterMotion.easeOutCubic(0.375)
        #expect(abs(EnterMotion.linearProgress(eased: eased) - 0.375) < 1e-9)
        #expect(EnterMotion.rowProgress(0, eased: eased) == 1)
        #expect(abs(EnterMotion.rowProgress(1, eased: eased) - EnterMotion.easeOutCubic(0.9)) < 1e-9)
        #expect(EnterMotion.rowProgress(5, eased: eased) == 0)
        #expect(EnterMotion.rowProgress(0, eased: 0) == 0)
        // Every row is at rest once the enter is (Reduce Motion: progress 1).
        #expect(EnterMotion.rowProgress(9, eased: 1) == 1)
        #expect(EnterMotion.rowRise == 14)
    }

    @Test func countsFromZeroToExactlyTheTarget() {
        #expect(EnterMotion.countUpValue(1248, 0) == 0)
        #expect(EnterMotion.countUpValue(1248, 0.5) == 1092)
        #expect(EnterMotion.countUpValue(1248, 1) == 1248)
    }

    @Test func keepsTheTargetsPrecision() {
        let whole = EnterMotion.countUpValue(7, 0.3)
        #expect(whole == whole.rounded())
        #expect(EnterMotion.countUpValue(12.5, 0.5) == 10.9)
        #expect(EnterMotion.countUpValue(0.034, 0.5) == 0.03)
    }

    @Test func wordsEveryFrameAsTheFinalTextAndEndsOnIt() {
        let compact = { (value: Double) in MetricFormat.compactValue(value, unit: "count") }
        let final = compact(48_200)
        #expect(final == "48.2K")
        #expect(EnterMotion.countUpText(48_200, 0, format: compact, final: final) == "0")
        #expect(EnterMotion.countUpText(48_200, 0.5, format: compact, final: final) == "42.2K")
        #expect(EnterMotion.countUpText(48_200, 1, format: compact, final: final) == final)
        #expect(EnterMotion.countUpText(1248, 1, format: { String($0) }, final: "≈ 1,248") == "≈ 1,248")
    }

    @Test func neverNeedsMoreRoomThanTheFinalText() {
        let compact = { (value: Double) in MetricFormat.compactValue(value, unit: "count") }
        let final = compact(1_000_000)
        #expect(final == "1M")
        for t in [0.2, 0.5, 0.8, 0.95, 0.999] {
            #expect(EnterMotion.countUpText(1_000_000, t, format: compact, final: final).count <= final.count)
        }
    }
}
