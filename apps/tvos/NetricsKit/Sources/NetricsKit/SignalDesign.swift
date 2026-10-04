import Foundation

// The polished TV design (ADR 0018, sections 5 and 6; #313): the pure rules
// behind the web's TV renderer, ported so the app draws what the web draws.
//
// - Surfaces: `themeSurface` (apps/web/src/lib/studio-theme.ts) and the
//   colours globals.css derives with `color-mix` (`[data-surface]`, `.sw`,
//   `.sw--stale`, `.sw--auth`, `.sw--empty`), never new theme tokens.
// - Freshness: the widget footer (`footerCandidates` in widget-parts.tsx,
//   `footerLine` and `chartWidgetLayoutWithFooter` in studio-render.ts), the
//   header's refresh countdown (refresh-countdown.ts, `countdownFits` in
//   slide-canvas.tsx) and the slide footer (slide-player.tsx).
// - Data states: `dataSurfaceOf` (widget-parts.tsx).
// - Motion: the enter easing and count-up (enter-motion.ts) and the
//   durations of the continuous cues.
//
// Sizes are in canvas units (u = canvas height / 1080), as everywhere in
// StudioLayout and StudioRender.

// MARK: - Colours

extension ThemeColor {
    public static let black = ThemeColor(red: 0, green: 0, blue: 0)

    /** WCAG 2.x relative luminance (as packages/domain `relativeLuminance`). */
    public var relativeLuminance: Double {
        func channel(_ value: Double) -> Double {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }

    /** WCAG 2.x contrast ratio, 1 … 21, order-independent. */
    public static func contrastRatio(_ a: ThemeColor, _ b: ThemeColor) -> Double {
        let (la, lb) = (a.relativeLuminance, b.relativeLuminance)
        return (Swift.max(la, lb) + 0.05) / (Swift.min(la, lb) + 0.05)
    }

    /** CSS `color-mix(in srgb, self share, other)`: `share` of this colour, the rest of `other`. */
    public func mixed(_ share: Double, with other: ThemeColor) -> ThemeColor {
        let p = Swift.min(1, Swift.max(0, share))
        return ThemeColor(
            red: red * p + other.red * (1 - p), green: green * p + other.green * (1 - p),
            blue: blue * p + other.blue * (1 - p))
    }

    /** `#rrggbb`, each channel rounded. */
    public var hex: String {
        func byte(_ value: Double) -> String {
            let clamped = Int((Swift.min(1, Swift.max(0, value)) * 255).rounded(.toNearestOrAwayFromZero))
            let text = String(clamped, radix: 16)
            return text.count == 1 ? "0" + text : text
        }
        return "#" + byte(red) + byte(green) + byte(blue)
    }
}

/** A derived colour drawn at an opacity (CSS `color-mix(in srgb, c p%, transparent)`). */
public struct TintedColor: Sendable, Equatable {
    public var color: ThemeColor
    public var opacity: Double

    public init(_ color: ThemeColor, _ opacity: Double = 1) {
        self.color = color
        self.opacity = opacity
    }
}

/**
 * How widget surfaces are drawn with a theme (ADR 0018, section 5): a dark
 * theme with hairline borders is "layered" (a gradient, an inner highlight,
 * a soft shadow, a glow of the accent on the canvas); a light theme (paper,
 * light) or one with strong borders (high contrast) stays "flat". Custom
 * themes fall into one or the other by their tokens (web: `themeSurface`).
 */
public enum ThemeSurface: String, Sendable, Equatable {
    case layered, flat

    /** A light background from this relative luminance on. */
    public static let lightBackground = 0.4
    /** Borders this strong against the surface are meant to be seen as such. */
    public static let strongBorder = 3.0

    public init(_ tokens: ThemeTokens) {
        self.init(background: tokens.background, surface: tokens.surface, border: tokens.border)
    }

    public init(background: String, surface: String, border: String) {
        guard let background = ThemeColor.parse(background), let surface = ThemeColor.parse(surface),
            let border = ThemeColor.parse(border)
        else {
            // Not #rrggbb (never from a validated theme): the plain surface.
            self = .flat
            return
        }
        if background.relativeLuminance >= Self.lightBackground {
            self = .flat
        } else {
            self = ThemeColor.contrastRatio(border, surface) >= Self.strongBorder ? .flat : .layered
        }
    }
}

/**
 * Every colour the TV design derives from a theme's tokens, as globals.css
 * derives them with `color-mix` (#309, #311). The app turns them into
 * SwiftUI colours; nothing here is a new token.
 */
public struct DerivedSurfaces: Sendable, Equatable {
    public var kind: ThemeSurface
    /** A widget's background, top to bottom (flat: the surface twice). */
    public var widgetTop: ThemeColor
    public var widgetBottom: ThemeColor
    /** The 1.5 unit inner highlight along a layered widget's top edge. */
    public var highlight: TintedColor
    /** The danger hue: the theme's `down` leaned towards red. */
    public var danger: ThemeColor
    /** The auth failed surface, top to bottom, and its border. */
    public var authTop: ThemeColor
    public var authBottom: ThemeColor
    public var authBorder: TintedColor
    /** A stale widget's border. */
    public var staleBorder: TintedColor
    /** The dashed border of no data and backfilling. */
    public var emptyBorder: TintedColor
    /** The skeleton block and its sweep. */
    public var skeleton: ThemeColor
    public var sweep: TintedColor
    /** A bar's track and the slide footer's bar. */
    public var track: ThemeColor
    /** The header countdown's bar. */
    public var refreshTrack: ThemeColor
    /** The slide footer's fill. */
    public var slideProgress: ThemeColor
    /** A bar's fill, from its start to its end (flat: the chart fill twice). */
    public var barStart: ThemeColor
    public var barEnd: ThemeColor
    /** The accent's glow from the top of a layered canvas; nil on flat themes. */
    public var canvasGlow: TintedColor?

    /** The danger hue's red (GitHub's danger, as the web). */
    static let red = ThemeColor.parse("#f85149")!

    public init(_ tokens: ThemeTokens) {
        let fallback = ThemeTokens.netricsDark
        func color(_ value: String, _ backup: String) -> ThemeColor {
            ThemeColor.parse(value) ?? ThemeColor.parse(backup)!
        }
        let surface = color(tokens.surface, fallback.surface)
        let background = color(tokens.background, fallback.background)
        let text = color(tokens.text, fallback.text)
        let accent = color(tokens.accent, fallback.accent)
        let muted = color(tokens.muted, fallback.muted)
        let down = color(tokens.down, fallback.down)
        let warning = color(tokens.warning, fallback.warning)
        let chartFill = color(tokens.chartFill, fallback.chartFill)
        let kind = ThemeSurface(tokens)
        let layered = kind == .layered
        let danger = down.mixed(0.4, with: Self.red)
        let sunk = surface.mixed(0.8, with: background)

        self.kind = kind
        widgetTop = layered ? surface.mixed(0.95, with: accent) : surface
        widgetBottom = layered ? sunk : surface
        highlight = TintedColor(text, 0.06)
        self.danger = danger
        authTop = surface.mixed(0.94, with: danger)
        authBottom = layered ? sunk.mixed(0.96, with: danger) : authTop
        authBorder = layered ? TintedColor(danger, 0.35) : TintedColor(down)
        staleBorder = layered ? TintedColor(warning, 0.35) : TintedColor(warning)
        emptyBorder = TintedColor(text, layered ? 0.14 : 0.45)
        skeleton = surface.mixed(layered ? 0.94 : 0.9, with: text)
        sweep = TintedColor(text, layered ? 0.06 : 0.1)
        track = surface.mixed(0.94, with: text)
        refreshTrack = surface.mixed(0.92, with: text)
        slideProgress = muted.mixed(0.55, with: surface)
        barStart = layered ? chartFill.mixed(0.75, with: .black) : chartFill
        barEnd = chartFill
        canvasGlow = layered ? TintedColor(accent, 0.1) : nil
    }
}

/** The widget box's shape and depth in units (ADR 0018, section 5). */
public enum SurfaceMetrics {
    public static let radius = 24.0
    public static let border = 1.5
    public static let highlight = 1.5
    /** The soft shadow of a layered widget: `0 15u 45u rgb(0 0 0 / 0.35)`. */
    public static let shadowY = 15.0
    public static let shadowBlur = 45.0
    public static let shadowOpacity = 0.35
}

// MARK: - Data states

/**
 * The data states with a surface of their own (ADR 0018 section 5, #311):
 * auth failed, no data and backfilling replace the numbers; every other
 * status keeps the widget (ok, outage with its notice, stale with its
 * warning border and dimmed value).
 */
public enum DataSurface: String, Sendable, Equatable {
    case authFailed = "auth_failed"
    case noData = "no_data"
    case backfilling

    public init?(_ status: DeviceTileStatus) {
        switch status {
        case .authFailed: self = .authFailed
        case .noData: self = .noData
        case .backfilling: self = .backfilling
        case .ok, .stale, .outage: return nil
        }
    }

    /** "Reconnect …" in units: the design's 19 px at 2/3 scale, at least the small size × 1.1875. */
    public static func reconnectSize(small: Double) -> Double { Swift.max(28.5, small * 1.1875) }
    /** The skeleton block's height in units (the design's 40 px). */
    public static let skeletonHeight = 60.0
    /** The skeleton's width as a share of the widget's. */
    public static let skeletonWidth = 0.6

    /**
     * The surface's lines: "Reconnect {source}" (or "Reconnect the source"
     * without a name, as on screens) and its hint; "Loading history…" or
     * "No data yet" under the skeleton.
     */
    public func texts(source: String?, language: ScreenLanguage) -> (headline: String?, hint: String) {
        switch self {
        case .authFailed:
            let name = source.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
            let headline = name.map { KitStrings.text(.reconnect, language, $0) } ?? KitStrings.text(.reconnectSource, language)
            return (headline, KitStrings.text(.reconnectHint, language))
        case .noData:
            return (nil, KitStrings.text(.noDataYet, language))
        case .backfilling:
            return (nil, KitStrings.text(.loadingHistory, language))
        }
    }
}

// MARK: - Widget footer

/**
 * The freshness footer of a data widget: "updated 2 min. ago · Stripe"
 * (ADR 0018 section 5). Device payloads carry no source name, so a TV says
 * "updated 2 min. ago", as the web kiosk does.
 */
public enum WidgetFooter {
    /** A chart keeps at least this height in units when a footer is added. */
    public static let minChart = 120.0

    /**
     * "5 min. ago", "vor 5 Min.", "yesterday", "now" (Intl's short style
     * with `numeric: "auto"` on the web; RelativeDateTimeFormatter here,
     * which words them alike): within 45 seconds "now", then minutes, hours
     * and days, each rounded. Nil without a time or one that does not parse.
     */
    public static func relativeTime(_ iso: String?, now: Date = Date(), language: ScreenLanguage = .en) -> String? {
        guard let iso, let date = ISODate.parse(iso) else { return nil }
        // Math.round: halves round up, also below zero.
        func jsRound(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }
        let delta = jsRound(date.timeIntervalSince(now))
        let absolute = abs(delta)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = language.locale
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        let minute = 60
        let hour = 60 * minute
        let day = 24 * hour
        if absolute < 45 {
            return formatter.localizedString(from: DateComponents(second: 0))
        }
        let sign = delta < 0 ? -1 : 1
        func count(_ size: Int) -> Int { sign * jsRound(Double(absolute) / Double(size)) }
        if absolute < hour {
            return formatter.localizedString(from: DateComponents(minute: count(minute)))
        }
        if absolute < day {
            return formatter.localizedString(from: DateComponents(hour: count(hour)))
        }
        return formatter.localizedString(from: DateComponents(day: count(day)))
    }

    /**
     * The footer's candidates, longest first: "updated 2 min. ago · Stripe",
     * "updated 2 min. ago", "Stripe".
     */
    public static func candidates(
        updatedAt: String?, source: String?, now: Date = Date(), language: ScreenLanguage = .en
    ) -> [String] {
        let time = relativeTime(updatedAt, now: now, language: language)
        let name = source.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        var result: [String] = []
        if let time, let name { result.append(KitStrings.text(.updatedFrom, language, time, name)) }
        if let time { result.append(KitStrings.text(.updated, language, time)) }
        if let name { result.append(name) }
        return result
    }

    /**
     * The first candidate that fits on one line of the widget at its
     * smallest readable size, so it never wraps; nil when none does.
     */
    public static func line(
        _ candidates: [String], type: StudioWidgetType, placement: StudioPlacement, showHeader: Bool,
        fontScale: Double, unitBox: StudioCanvas? = nil
    ) -> String? {
        let box = StudioRender.contentBox(placement, showHeader: showHeader, unitBox: unitBox)
        let size =
            StudioLayout.typeScale(type, placement: placement, fontScale: fontScale, showHeader: showHeader)[.any]
            ?? StudioLayout.Minimum.any
        return candidates.first {
            !$0.isEmpty && StudioLayout.wrappedLineCount($0, maxWidth: box.width, fontSize: size) <= 1
        }
    }

    /**
     * A line or bar widget with its footer: the footer takes the notice
     * line (a notice, when there is one, takes it instead), and only while
     * the chart keeps `minChart` units; else the widget shows no footer.
     */
    public static func chartLayout(
        type: StudioWidgetType, label: String, value: (full: String, compact: String)?, notice: String?,
        footer: String?, placement: StudioPlacement, showHeader: Bool, fontScale: Double, unitBox: StudioCanvas? = nil
    ) -> (layout: StudioRender.ChartLayout, footer: String?) {
        func layout(_ line: String?) -> StudioRender.ChartLayout {
            StudioRender.chartLayout(
                type: type, label: label, value: value, notice: line, placement: placement, showHeader: showHeader,
                fontScale: fontScale, unitBox: unitBox)
        }
        guard notice == nil, let footer else { return (layout(notice), nil) }
        let withFooter = layout(footer)
        return withFooter.chartHeight >= minChart ? (withFooter, footer) : (layout(nil), nil)
    }
}

// MARK: - Header countdown

/**
 * The header's "next refresh in 42 s" over a thin bar (ADR 0018 section 5).
 * The TV takes its cadence from the payload: `refreshAfterSec` after the
 * API last answered, as the web kiosk does.
 */
public struct RefreshCountdown: Sendable, Equatable {
    /** Whole seconds to the next refresh, 1 … the cycle. */
    public var seconds: Int
    /** How much of the cycle has passed, 0 … <1 (the progress bar). */
    public var fraction: Double

    public init(seconds: Int, fraction: Double) {
        self.seconds = seconds
        self.fraction = fraction
    }

    /** Text size, the bar, and the gaps in units (slide-canvas.tsx). */
    public static let textSize = StudioLayout.Minimum.any
    public static let barWidth = 210.0
    public static let barHeight = 4.5
    public static let gap = 12.0
    /** Between the items on the header's right (countdown, offline, clock). */
    public static let metaGap = 24.0

    /**
     * Where `now` is in the cycle. Past one cycle (a late refresh) the
     * countdown starts over, so it never shows a negative or frozen number.
     */
    public static func at(_ now: Date, since: Date, every: TimeInterval) -> RefreshCountdown {
        let cycle = Swift.max(1, every)
        let elapsed = Swift.max(0, now.timeIntervalSince(since)).truncatingRemainder(dividingBy: cycle)
        return RefreshCountdown(
            seconds: Swift.max(1, Int((cycle - elapsed).rounded(.up))), fraction: elapsed / cycle)
    }

    /**
     * The cadence: since the API last answered, every `refreshAfterSec`
     * (the default when the payload has none); none before the first answer
     * or while offline (the header shows the offline marker then).
     */
    public static func cycle(updatedAt: Date?, offline: Bool, refreshAfterSec: Int)
        -> (since: Date, every: TimeInterval)?
    {
        guard let updatedAt, !offline else { return nil }
        let seconds = refreshAfterSec > 0 ? refreshAfterSec : DeviceClient.defaultRefreshAfterSeconds
        return (updatedAt, TimeInterval(seconds))
    }

    /**
     * Whether the countdown fits beside the names the header shows, by the
     * same conservative estimates as `headerFit`: it is left out before the
     * dashboard or slide name would be cut, and in narrow formats.
     */
    public static func fits(_ fit: HeaderFit, name: String, slideName: String?, pageLabel: String?, sample: String)
        -> Bool
    {
        guard fit.maxNameLines <= 1 else { return false }
        typealias M = StudioHeaderMetrics
        let trimmedSlide = slideName.map(trimmed).flatMap { $0.isEmpty ? nil : $0 }
        var used = StudioLayout.estimateTextWidth(trimmed(name), fontSize: M.name, weight: .semibold)
        if let trimmedSlide { used += M.gap + StudioLayout.estimateTextWidth(trimmedSlide, fontSize: M.meta) }
        if let pageLabel { used += M.gap + StudioLayout.estimateTextWidth(pageLabel, fontSize: M.meta) }
        let countdown = metaGap + StudioLayout.estimateTextWidth(sample, fontSize: textSize) + gap + barWidth
        return fit.width - used >= countdown
    }

    /** The widest text the countdown reserves room for. */
    public static func sample(_ language: ScreenLanguage) -> String {
        KitStrings.text(.nextRefresh, language, 88)
    }

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - Slide footer

/**
 * The slide footer (ADR 0018 section 5): "2 / 3 · Sales · next: Team" over
 * a thin bar that fills over the slide's time, in the canvas's bottom
 * padding (32 units; the grid unchanged). Shown while the rotation moves
 * on by itself.
 */
public enum SlideFooter {
    public static let textSize = StudioLayout.Minimum.any
    public static let barHeight = 4.5
    public static let gap = 3.0

    /** "Sales 2/2" for a page of a slide on several pages; nil without a name. */
    public static func entryName(slideName: String?, pageLabel: String?) -> String? {
        guard let name = slideName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return pageLabel.map { "\(name) \($0)" } ?? name
    }

    public static func text(position: Int, count: Int, name: String?, next: String?, language: ScreenLanguage)
        -> String
    {
        [
            KitStrings.text(.slidePosition, language, position, count),
            name,
            next.map { KitStrings.text(.nextSlide, language, $0) },
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }
}

extension SlideRotation {
    /** How much of the current slide's time has passed, 0 … 1 (held while paused). */
    public func progress(at now: Date) -> Double {
        guard !slides.isEmpty else { return 0 }
        let duration = TimeInterval(Swift.max(1, slides[index].durationSec))
        let elapsed = (pausedAt ?? now).timeIntervalSince(shownSince)
        return Swift.min(1, Swift.max(0, elapsed / duration))
    }

    /** The current slide's duration in seconds. */
    public var currentDuration: TimeInterval {
        slides.isEmpty ? 0 : TimeInterval(Swift.max(1, slides[index].durationSec))
    }
}

// MARK: - Motion

/**
 * Slide enter and the continuous cues (ADR 0018 section 6): on every slide
 * change, values count up from zero and charts draw over 1.2 s with an
 * ease-out cubic; then the slide is still, apart from a pulse on a chart's
 * last point, the stale dot's blink and the skeleton's sweep. None of it
 * with Reduce Motion.
 */
public enum EnterMotion {
    public static let duration: TimeInterval = 1.2
    public static let pulse: TimeInterval = 2.4
    public static let blink: TimeInterval = 1.8
    public static let sweep: TimeInterval = 1.6
    /** The pulse ring's reach beyond the dot, in units. */
    public static let pulseRing = 21.0
    /**
     * `cubic-bezier(0.33, 1, 0.68, 1)`: the curve SwiftUI animates the
     * enter with, the standard Bézier fit of `1 − (1 − t)³`.
     */
    public static let bezier = (x1: 0.33, y1: 1.0, x2: 0.68, y2: 1.0)

    /** `1 − (1 − t)³`, t clamped to 0…1. */
    public static func easeOutCubic(_ t: Double) -> Double {
        let clamped = Swift.min(1, Swift.max(0, t))
        return 1 - pow(1 - clamped, 3)
    }

    /** Decimal places of a number as written (at most 6). */
    static func decimals(_ value: Double) -> Int {
        for places in 0..<6 {
            let scaled = value * pow(10, Double(places))
            if abs(scaled - scaled.rounded()) < 1e-9 { return places }
        }
        return 6
    }

    /**
     * The value shown at linear progress `t`: the target eased up from zero
     * at the target's precision (a whole count stays whole); exactly the
     * target from `t = 1` on.
     */
    public static func countUpValue(_ target: Double, _ t: Double) -> Double {
        t >= 1 ? target : countUpValue(target, eased: easeOutCubic(t))
    }

    /** As `countUpValue`, from progress already eased (SwiftUI's animated value). */
    public static func countUpValue(_ target: Double, eased p: Double) -> Double {
        if p >= 1 { return target }
        let factor = pow(10, Double(decimals(target)))
        return ((target * Swift.max(0, p) * factor) + 0.5).rounded(.down) / factor
    }

    /**
     * A counting value's text: `format` of the counted value and, at the
     * end, exactly `final` (the text at rest). A frame that would be longer
     * than the final text shows the final text, so the value never needs
     * more room than it has at rest.
     */
    public static func countUpText(_ target: Double, _ t: Double, format: (Double) -> String, final: String) -> String {
        t >= 1 ? final : countUpText(target, eased: easeOutCubic(t), format: format, final: final)
    }

    public static func countUpText(_ target: Double, eased p: Double, format: (Double) -> String, final: String)
        -> String
    {
        if p >= 1 || !target.isFinite { return final }
        let text = format(countUpValue(target, eased: p))
        // JavaScript's length: UTF-16 code units.
        return text.utf16.count > final.utf16.count ? final : text
    }
}
