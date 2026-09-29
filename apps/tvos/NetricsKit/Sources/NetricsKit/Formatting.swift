import Foundation

// Tile formatting, worded and rounded like the web app
// (apps/web/src/lib/format-metric.ts, tile-status.ts, relative-time.ts,
// tv-grid.ts). Numbers use en-US; the web rounds half away from zero.

public enum MetricFormat {
    static let locale = Locale(identifier: "en_US")
    static let rounding = FloatingPointRoundingRule.toNearestOrAwayFromZero

    /** "EUR" for "EUR_minor"; nil for other units. */
    static func currency(of unit: String) -> String? {
        guard unit.hasSuffix("_minor") else { return nil }
        let code = unit.dropLast("_minor".count)
        guard code.count == 3, code.allSatisfy({ $0.isASCII && $0.isUppercase }) else { return nil }
        return String(code)
    }

    /**
     * 1,284 · 12.9K · 4.2M · 3.14; currency in minor units shown in the
     * major unit (€1,234.56, $4.2M); percent as 42.3%; "—" without a value.
     */
    public static func value(_ value: Double?, unit: String) -> String {
        guard let value else { return "—" }
        if let code = currency(of: unit) {
            let major = value / 100
            let base = FloatingPointFormatStyle<Double>.Currency(code: code, locale: locale).rounded(rule: rounding)
            if abs(major) >= 10_000 {
                return major.formatted(base.notation(.compactName).precision(.fractionLength(0...1)))
            }
            // Whole amounts without ".00".
            let digits = major.rounded() == major ? 0 : 2
            return major.formatted(base.precision(.fractionLength(digits)))
        }
        let number = FloatingPointFormatStyle<Double>(locale: locale).rounded(rule: rounding)
        if unit == "percent" {
            return value.formatted(number.precision(.fractionLength(0...1))) + "%"
        }
        if abs(value) >= 10_000 {
            return value.formatted(number.notation(.compactName).precision(.fractionLength(0...1)))
        }
        let maxDigits = abs(value) >= 100 ? 0 : 2
        return value.formatted(number.precision(.fractionLength(0...maxDigits)))
    }

    public enum Direction: String, Sendable, Equatable {
        case up, down, flat

        public var arrow: String {
            switch self {
            case .up: return "▲"
            case .down: return "▼"
            case .flat: return "■"
            }
        }
    }

    public struct Change: Sendable, Equatable {
        public var direction: Direction
        /** "+12.5%", or the signed absolute change without a ratio. */
        public var text: String
    }

    /** Nil when there is nothing to compare with. */
    public static func change(delta: Double?, ratio: Double?, unit: String) -> Change? {
        guard let delta else { return nil }
        let direction: Direction = delta > 0 ? .up : delta < 0 ? .down : .flat
        let sign = delta > 0 ? "+" : delta < 0 ? "−" : "±"
        if let ratio {
            let digits = abs(ratio) < 0.1 ? 1 : 0
            let percent = (abs(ratio) * 100).formatted(
                FloatingPointFormatStyle<Double>(locale: locale).rounded(rule: rounding)
                    .precision(.fractionLength(0...digits)))
            return Change(direction: direction, text: "\(sign)\(percent)%")
        }
        return Change(direction: direction, text: "\(sign)\(value(abs(delta), unit: unit))")
    }

    public static func periodLabel(_ period: MetricPeriod) -> String {
        switch period {
        case .today: return "Today"
        case .last7Days: return "Last 7 days"
        case .last30Days: return "Last 30 days"
        case .thisMonth: return "This month"
        case .unknown: return ""
        }
    }

    /** What the change is measured against, e.g. "vs previous 7 days". */
    public static func comparisonLabel(_ period: MetricPeriod) -> String {
        switch period {
        case .today: return "vs yesterday"
        case .last7Days: return "vs previous 7 days"
        case .last30Days: return "vs previous 30 days"
        case .thisMonth: return "vs last month"
        case .unknown: return "vs previous period"
        }
    }

    public static func aggregationLabel(_ aggregation: MetricAggregation) -> String {
        switch aggregation {
        case .sum: return "Total"
        case .avg: return "Average"
        case .min: return "Minimum"
        case .max: return "Maximum"
        case .last: return "Latest"
        case .unknown: return ""
        }
    }

    /** "Today · Total" */
    public static func subtitle(_ tile: DeviceTile) -> String {
        [periodLabel(tile.period), aggregationLabel(tile.aggregation)].filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /**
     * The line under the value: "▲ +25% vs previous 7 days", or why there
     * is nothing to compare.
     */
    public static func changeLine(_ tile: DeviceTile) -> (direction: Direction, text: String) {
        let unit = tile.unit ?? "count"
        if let change = change(delta: tile.change.delta, ratio: tile.change.ratio, unit: unit) {
            return (change.direction, "\(change.direction.arrow) \(change.text) \(comparisonLabel(tile.period))")
        }
        if tile.value == nil {
            return (.flat, "No data for this period yet")
        }
        return (.flat, "No data to compare \(comparisonLabel(tile.period))")
    }
}

public enum TileNotices {
    public static let authFailed = "Connection needs new credentials"
    public static let outage = "Source unreachable"
    public static let firstSync = "Waiting for the first sync"

    /** The notice for a tile; nil when it is fresh. */
    public static func notice(status: DeviceTileStatus, updatedAt: String?, now: Date = Date()) -> String? {
        switch status {
        case .authFailed:
            return authFailed
        case .outage:
            return outage
        case .stale:
            guard let updatedAt else { return firstSync }
            return "Last sync \(RelativeTime.describe(updatedAt, now: now))"
        case .noData, .ok:
            return nil
        }
    }
}

public enum RelativeTime {
    /** "just now", "5 minutes ago", "in 2 hours". */
    public static func describe(_ iso: String?, now: Date = Date()) -> String {
        guard let iso, let date = ISODate.parse(iso) else { return "never" }
        let delta = Int((date.timeIntervalSince(now)).rounded(.toNearestOrAwayFromZero))
        let future = delta > 0
        let absolute = abs(delta)
        let minute = 60
        let hour = 60 * minute
        let day = 24 * hour
        func plural(_ count: Int, _ word: String) -> String {
            "\(count) \(word)\(count == 1 ? "" : "s")"
        }
        let text: String
        if absolute < 45 {
            return "just now"
        } else if absolute < hour {
            text = plural(Int((Double(absolute) / Double(minute)).rounded(.toNearestOrAwayFromZero)), "minute")
        } else if absolute < day {
            text = plural(Int((Double(absolute) / Double(hour)).rounded(.toNearestOrAwayFromZero)), "hour")
        } else {
            text = plural(Int((Double(absolute) / Double(day)).rounded(.toNearestOrAwayFromZero)), "day")
        }
        return future ? "in \(text)" : "\(text) ago"
    }
}

public enum TVGrid {
    static let targetTileAspect = 1.2
    static let emptyCellCost = 0.5

    /**
     * Every tile on one screen: the column count whose cells come closest
     * to a slightly wide card (1.2:1); an empty cell costs about as much as
     * a clearly misshapen tile.
     */
    public static func layout(tiles: Int, screenAspect: Double = 16.0 / 9.0) -> (columns: Int, rows: Int) {
        guard tiles > 1 else { return (1, 1) }
        var best = (columns: 1, rows: tiles, score: Double.infinity)
        for columns in 1...tiles {
            let rows = (tiles + columns - 1) / columns
            let tileAspect = (screenAspect * Double(rows)) / Double(columns)
            let empty = columns * rows - tiles
            let score = abs(log(tileAspect / targetTileAspect)) + emptyCellCost * Double(empty)
            if score < best.score {
                best = (columns, rows, score)
            }
        }
        return (best.columns, best.rows)
    }
}

public enum Sparkline {
    public struct Point: Sendable, Equatable {
        public var index: Int
        public var value: Double
    }

    /** Runs of consecutive values; a null bucket ends a run (a gap). */
    public static func segments(_ spark: [Double?]) -> [[Point]] {
        var segments: [[Point]] = []
        var current: [Point] = []
        for (index, value) in spark.enumerated() {
            if let value {
                current.append(Point(index: index, value: value))
            } else if !current.isEmpty {
                segments.append(current)
                current = []
            }
        }
        if !current.isEmpty {
            segments.append(current)
        }
        return segments
    }

    /** Whether there is a trend to draw (web: two buckets and a value). */
    public static func isDrawable(_ spark: [Double?]) -> Bool {
        spark.count >= 2 && spark.contains { $0 != nil }
    }
}

public enum TVTime {
    static func zone(_ identifier: String) -> TimeZone {
        TimeZone(identifier: identifier) ?? .current
    }

    /** "14:05" in the workspace's zone (the offline marker). */
    public static func hourMinute(_ date: Date, timeZone: String) -> String {
        var style = Date.FormatStyle(locale: Locale(identifier: "en_GB"), timeZone: zone(timeZone))
        style = style.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return date.formatted(style)
    }

    /** "Tue 29 Sep, 14:05" in the workspace's zone (the header clock). */
    public static func clock(_ date: Date, timeZone: String) -> String {
        let day = Date.FormatStyle(locale: Locale(identifier: "en_GB"), timeZone: zone(timeZone))
            .weekday(.abbreviated).day().month(.abbreviated)
        return "\(date.formatted(day)), \(hourMinute(date, timeZone: timeZone))"
    }

    /** "Offline — last update 14:05", or "Offline" without a confirmed update. */
    public static func offlineMarker(updatedAt: Date?, timeZone: String) -> String {
        guard let updatedAt else { return "Offline" }
        return "Offline — last update \(hourMinute(updatedAt, timeZone: timeZone))"
    }
}

/**
 * The pairing URL as the TV shows it: host and path, without scheme or
 * trailing slash ("netrics.tv", "app.example.com/devices/approve"). Same as
 * apps/web/src/lib/pairing-address.ts.
 */
public enum PairingAddress {
    public static func display(_ pairingUrl: String) -> String {
        guard let parts = URLComponents(string: pairingUrl), let host = parts.host, !host.isEmpty else {
            return pairingUrl
        }
        var text = host
        if let port = parts.port { text += ":\(port)" }
        text += parts.percentEncodedPath
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }
}
