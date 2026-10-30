import Foundation

// Tile formatting, worded and rounded like the web app
// (apps/web/src/lib/format-metric.ts, tile-status.ts, relative-time.ts,
// tv-grid.ts). Numbers use en-US in English and German in German
// (ScreenLanguage.numberLocale); the web rounds half away from zero.

public enum MetricFormat {
    static let rounding = FloatingPointRoundingRule.toNearestOrAwayFromZero

    /** "EUR" for "EUR_minor"; nil for other units. */
    static func currency(of unit: String) -> String? {
        guard unit.hasSuffix("_minor") else { return nil }
        let code = unit.dropLast("_minor".count)
        guard code.count == 3, code.allSatisfy({ $0.isASCII && $0.isUppercase }) else { return nil }
        return String(code)
    }

    /**
     * ISO 4217 minor-unit exponents other than 2 (ISO, not CLDR), as in
     * packages/domain/src/currency.ts. A per-currency amount (ADR 0014)
     * arrives as its currency's "<ISO>_minor" unit.
     */
    static let exponents: [String: Int] = [
        "BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0,
        "KRW": 0, "PYG": 0, "RWF": 0, "UGX": 0, "UYI": 0, "VND": 0, "VUV": 0,
        "XAF": 0, "XOF": 0, "XPF": 0,
        "BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
        "CLF": 4, "UYW": 4,
    ]

    /** Decimal places of the currency's minor unit: JPY 0, EUR 2, BHD 3. */
    static func exponent(of code: String) -> Int {
        exponents[code] ?? 2
    }

    /**
     * 1,284 · 12.9K · 4.2M · 3.14; currency in minor units shown in the
     * major unit (€1,234.56, $4.2M); percent as 42.3%; "—" without a value.
     */
    public static func value(_ value: Double?, unit: String, language: ScreenLanguage = .en) -> String {
        guard let value else { return "—" }
        let locale = language.numberLocale
        if let code = currency(of: unit) {
            let exponent = exponent(of: code)
            let major = value / pow(10, Double(exponent))
            let base = FloatingPointFormatStyle<Double>.Currency(code: code, locale: locale).rounded(rule: rounding)
            if abs(major) >= 10_000 {
                return compactAmount(major, currency: code, language: language)
            }
            // Whole amounts without decimals.
            let digits = major.rounded() == major ? 0 : exponent
            return major.formatted(base.precision(.fractionLength(digits)))
        }
        let number = FloatingPointFormatStyle<Double>(locale: locale).rounded(rule: rounding)
        if unit == "percent" {
            return value.formatted(number.precision(.fractionLength(0...1))) + "%"
        }
        if abs(value) >= 10_000 {
            return compactAmount(value, language: language)
        }
        let maxDigits = abs(value) >= 100 ? 0 : 2
        return value.formatted(number.precision(.fractionLength(0...maxDigits)))
    }

    /**
     * Compact suffixes per language, as localeCompactNumber in
     * packages/domain/src/compact-format.ts writes them: Intl's en-US
     * compact notation in English, the web's own German suffixes (German
     * CLDR does not abbreviate thousands: 12.900, not 12,9 Tsd.).
     */
    static func compactSuffixes(_ language: ScreenLanguage) -> (suffixes: [String], separator: String, grouping: Bool) {
        switch language {
        case .en: return (["", "K", "M", "B", "T"], "", false)
        case .de: return (["", "Tsd.", "Mio.", "Mrd.", "Bio."], "\u{00A0}", true)
        }
    }

    /**
     * The full compact form of a value (or an amount in the major unit of
     * `currency`): one decimal at most, rounded half away from zero, as on
     * the web: 12.9K, €4.2M; German 12,9 Tsd., 4,2 Mio. €. Checked against
     * packages/domain/test-vectors/compact-numbers.json.
     */
    public static func compactAmount(_ value: Double, currency: String? = nil, language: ScreenLanguage = .en) -> String {
        guard value.isFinite else { return "—" }
        let (suffixes, separator, grouping) = compactSuffixes(language)
        let magnitude = abs(value)
        var tier = 0
        while tier < suffixes.count - 1 && magnitude >= pow(1000.0, Double(tier + 1)) {
            tier += 1
        }
        var tenths = ((magnitude * 10) / pow(1000.0, Double(tier))).rounded(.toNearestOrAwayFromZero)
        // 999,950 rounds to 1000 thousand: one million.
        if tenths >= 10_000 && tier < suffixes.count - 1 {
            tier += 1
            tenths = ((magnitude * 10) / pow(1000.0, Double(tier))).rounded(.toNearestOrAwayFromZero)
        }
        let scaled = (value < 0 ? -tenths : tenths) / 10
        let locale = language.numberLocale
        let text: String
        if let currency {
            let style = FloatingPointFormatStyle<Double>.Currency(code: currency, locale: locale)
                .rounded(rule: rounding).precision(.fractionLength(0...1))
            // Not `.grouping(.never)`: older Foundation (macOS 15) then drops
            // the currency sign and the precision.
            let formatted = scaled.formatted(style)
            text = grouping ? formatted : formatted.replacingOccurrences(of: locale.groupingSeparator ?? ",", with: "")
        } else {
            var style = FloatingPointFormatStyle<Double>(locale: locale)
                .rounded(rule: rounding).precision(.fractionLength(0...1))
            if !grouping { style = style.grouping(.never) }
            text = scaled.formatted(style)
        }
        let suffix = suffixes[tier]
        // The suffix follows the number, before a trailing currency sign.
        guard !suffix.isEmpty, let last = text.lastIndex(where: { $0.isNumber }) else { return text }
        var result = text
        result.insert(contentsOf: separator + suffix, at: result.index(after: last))
        return result
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
    public static func change(delta: Double?, ratio: Double?, unit: String, language: ScreenLanguage = .en) -> Change? {
        guard let delta else { return nil }
        let direction: Direction = delta > 0 ? .up : delta < 0 ? .down : .flat
        let sign = delta > 0 ? "+" : delta < 0 ? "−" : "±"
        if let ratio {
            let digits = abs(ratio) < 0.1 ? 1 : 0
            let percent = (abs(ratio) * 100).formatted(
                FloatingPointFormatStyle<Double>(locale: language.numberLocale).rounded(rule: rounding)
                    .precision(.fractionLength(0...digits)))
            return Change(direction: direction, text: "\(sign)\(percent)%")
        }
        return Change(direction: direction, text: "\(sign)\(value(abs(delta), unit: unit, language: language))")
    }

    public static func periodLabel(_ period: MetricPeriod, language: ScreenLanguage = .en) -> String {
        let key: KitText
        switch period {
        case .today: key = .periodToday
        case .last7Days: key = .periodLast7Days
        case .last30Days: key = .periodLast30Days
        case .thisMonth: key = .periodThisMonth
        case .last90Days: key = .periodLast90Days
        case .last12Months: key = .periodLast12Months
        case .thisWeek: key = .periodThisWeek
        case .thisQuarter: key = .periodThisQuarter
        case .thisYear: key = .periodThisYear
        case .unknown: return ""
        }
        return KitStrings.text(key, language)
    }

    /** What the change is measured against, e.g. "vs previous 7 days". */
    public static func comparisonLabel(_ period: MetricPeriod, language: ScreenLanguage = .en) -> String {
        let key: KitText
        switch period {
        case .today: key = .comparisonToday
        case .last7Days: key = .comparisonLast7Days
        case .last30Days: key = .comparisonLast30Days
        case .thisMonth: key = .comparisonThisMonth
        case .last90Days: key = .comparisonLast90Days
        case .last12Months: key = .comparisonLast12Months
        case .thisWeek: key = .comparisonThisWeek
        case .thisQuarter: key = .comparisonThisQuarter
        case .thisYear: key = .comparisonThisYear
        case .unknown: key = .comparisonUnknown
        }
        return KitStrings.text(key, language)
    }

    public static func aggregationLabel(_ aggregation: MetricAggregation, language: ScreenLanguage = .en) -> String {
        let key: KitText
        switch aggregation {
        case .sum: key = .aggregationSum
        case .avg: key = .aggregationAvg
        case .min: key = .aggregationMin
        case .max: key = .aggregationMax
        case .last: key = .aggregationLast
        case .unknown: return ""
        }
        return KitStrings.text(key, language)
    }

    /** "Today · Total" */
    /**
     * The tile label split for two lines: the metric, and the resource it
     * is about ("Downloads · Wurfel" → "Downloads", "Wurfel"; tileLabel in
     * @netrics/domain joins them with " · "). A label without the separator,
     * such as a custom title, stays on one line.
     */
    public static func titleParts(_ label: String) -> (title: String, detail: String?) {
        guard let range = label.range(of: " · ") else { return (label, nil) }
        let title = label[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
        let detail = label[range.upperBound...].trimmingCharacters(in: .whitespaces)
        if title.isEmpty || detail.isEmpty { return (label, nil) }
        return (title, detail)
    }

    public static func subtitle(_ tile: DeviceTile, language: ScreenLanguage = .en) -> String {
        [periodLabel(tile.period, language: language), aggregationLabel(tile.aggregation, language: language)]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /**
     * The line under the value: "▲ +25% vs previous 7 days", or why there
     * is nothing to compare.
     */
    public static func changeLine(_ tile: DeviceTile, language: ScreenLanguage = .en) -> (direction: Direction, text: String) {
        let unit = tile.unit ?? "count"
        let comparison = comparisonLabel(tile.period, language: language)
        if let change = change(delta: tile.change.delta, ratio: tile.change.ratio, unit: unit, language: language) {
            return (change.direction, "\(change.direction.arrow) \(change.text) \(comparison)")
        }
        if tile.value == nil {
            return (.flat, KitStrings.text(.noDataForPeriod, language))
        }
        return (.flat, KitStrings.text(.noDataToCompare, language, comparison))
    }
}

public enum TileNotices {
    public static let authFailed = KitStrings.text(.noticeAuthFailed)
    public static let outage = KitStrings.text(.noticeOutage)
    public static let firstSync = KitStrings.text(.noticeFirstSync)

    /** The notice for a tile; nil when it is fresh. */
    public static func notice(
        status: DeviceTileStatus, updatedAt: String?, now: Date = Date(), language: ScreenLanguage = .en
    ) -> String? {
        switch status {
        case .authFailed:
            return KitStrings.text(.noticeAuthFailed, language)
        case .outage:
            return KitStrings.text(.noticeOutage, language)
        case .stale:
            guard let updatedAt else { return KitStrings.text(.noticeFirstSync, language) }
            return KitStrings.text(
                .noticeLastSync, language, RelativeTime.describe(updatedAt, now: now, language: language))
        case .noData, .backfilling, .ok:
            return nil
        }
    }
}

public enum RelativeTime {
    /** "just now", "5 minutes ago", "in 2 hours"; "vor 5 Minuten" in German. */
    public static func describe(_ iso: String?, now: Date = Date(), language: ScreenLanguage = .en) -> String {
        guard let iso, let date = ISODate.parse(iso) else { return KitStrings.text(.never, language) }
        let delta = Int((date.timeIntervalSince(now)).rounded(.toNearestOrAwayFromZero))
        let future = delta > 0
        let absolute = abs(delta)
        let minute = 60
        let hour = 60 * minute
        let day = 24 * hour
        func count(_ seconds: Int, _ size: Int) -> Int {
            Int((Double(seconds) / Double(size)).rounded(.toNearestOrAwayFromZero))
        }
        func plural(_ count: Int, _ one: KitText, _ other: KitText) -> String {
            KitStrings.text(count == 1 ? one : other, language, count)
        }
        let text: String
        if absolute < 45 {
            return KitStrings.text(.justNow, language)
        } else if absolute < hour {
            text = plural(count(absolute, minute), .minuteOne, .minuteOther)
        } else if absolute < day {
            text = plural(count(absolute, hour), .hourOne, .hourOther)
        } else {
            text = plural(count(absolute, day), .dayOne, .dayOther)
        }
        return KitStrings.text(future ? .timeIn : .timeAgo, language, text)
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
    public static func hourMinute(_ date: Date, timeZone: String, language: ScreenLanguage = .en) -> String {
        var style = Date.FormatStyle(locale: language.dateLocale, timeZone: zone(timeZone))
        style = style.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        return date.formatted(style)
    }

    /** "Tue 29 Sep, 14:05" in the workspace's zone (the header clock); "Di. 29. Sept., 14:05". */
    public static func clock(_ date: Date, timeZone: String, language: ScreenLanguage = .en) -> String {
        let day = Date.FormatStyle(locale: language.dateLocale, timeZone: zone(timeZone))
            .weekday(.abbreviated).day().month(.abbreviated)
        return "\(date.formatted(day)), \(hourMinute(date, timeZone: timeZone, language: language))"
    }

    /** "Offline — last update 14:05", or "Offline" without a confirmed update. */
    public static func offlineMarker(updatedAt: Date?, timeZone: String, language: ScreenLanguage = .en) -> String {
        guard let updatedAt else { return KitStrings.text(.offline, language) }
        return KitStrings.text(
            .offlineLastUpdate, language, hourMinute(updatedAt, timeZone: timeZone, language: language))
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

/** Converted amounts (#191): marked approximate, with their source. */
public enum ConversionFormat {
    /** "≈ €339.82" for a converted value, the plain value otherwise. */
    public static func value(_ tile: DeviceTile, unit: String, language: ScreenLanguage = .en) -> String {
        let text = MetricFormat.value(tile.value, unit: unit, language: language)
        return tile.conversion != nil && tile.value != nil ? "≈ \(text)" : text
    }

    /**
     * The muted line at the bottom of a converted tile: "ECB reference
     * rates", plus "· TWD not converted" for amounts left out. Nil for
     * exact values.
     */
    public static func note(_ conversion: TileConversion?, language: ScreenLanguage = .en) -> String? {
        guard let conversion else { return nil }
        let source =
            conversion.source.hasPrefix("ECB") ? KitStrings.text(.conversionSource, language) : conversion.source
        let left = conversion.unconverted.map(\.currency)
        return left.isEmpty
            ? source : KitStrings.text(.conversionNotConverted, language, source, left.joined(separator: ", "))
    }
}
