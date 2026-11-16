import Foundation
import Synchronization

/// Typed semantic results are calculated on the server and retained in the offline payload.
public enum MeasureValue: Codable, Sendable, Equatable {
    case text(String)
    case number(Double)
    case boolean(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let text = try? value.decode(String.self) {
            self = .text(text)
        } else if let boolean = try? value.decode(Bool.self) {
            self = .boolean(boolean)
        } else {
            self = .number(try value.decode(Double.self))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .text(let text): try value.encode(text)
        case .number(let number): try value.encode(number)
        case .boolean(let boolean): try value.encode(boolean)
        case .null: try value.encodeNil()
        }
    }
    public func text(language: ScreenLanguage) -> String {
        switch self {
        case .text(let text): return text
        case .number(let number):
            return number.formatted(
                .number.locale(language.numberLocale).precision(.fractionLength(0...18)))
        case .boolean(let value):
            return KitStrings.text(value ? .measureTrue : .measureFalse, language)
        case .null: return "—"
        }
    }
    /** Used only for chart geometry; exact strings remain the displayed labels. */
    public var chartNumber: Double? {
        let number: Double?
        switch self {
        case .text(let text): number = Double(text)
        case .number(let value): number = value
        default: number = nil
        }
        guard let number, number.isFinite, abs(number) <= 9_007_199_254_740_991 else { return nil }
        return number
    }
}
public struct MeasureCell: Codable, Sendable, Equatable {
    public var value: MeasureValue
    public var type: String
    public var unit: String?
    public var currency: String?
    public var status: String

    /// A percent-change measure's ratio shows as the signed percentage compare
    /// widgets use ("+8.3%", "−60%"); anything else as `text(language:)`.
    public func text(language: ScreenLanguage, percentChange: Bool, timeZone: TimeZone = .current) -> String {
        guard percentChange, let ratio = value.chartNumber else { return text(language: language, timeZone: timeZone) }
        return MetricFormat.change(delta: ratio, ratio: ratio, unit: "count", language: language)?.text
            ?? text(language: language, timeZone: timeZone)
    }
    /**
     * The cell as shown (formatMeasureCell on the web, #619): days and
     * timestamps in the screen language's date format, timestamps in
     * `timeZone` (the device's); a unit with a display precision (ratings)
     * rounded on its decimal text. The value itself stays exact.
     */
    public func text(language: ScreenLanguage, timeZone: TimeZone = .current) -> String {
        switch value {
        case .null: return "—"
        case .boolean: return value.text(language: language)
        case .text(let text):
            if let date = DataFormat.date(text, type: type, language: language, timeZone: timeZone) { return date }
        case .number: break
        }
        let fractionDigits = unit.flatMap { DataFormat.unitFractionDigits[$0] }
        let text: String
        if type == "decimal" || currency != nil, let raw = decimalText {
            // Decimal strings never pass through Double, beyond IEEE-754 precision too.
            text = Self.exactNumber(
                fractionDigits.map { DataFormat.roundDecimalText(raw, digits: $0) } ?? raw,
                minimumFraction: currency.map { MetricFormat.exponent(of: $0) } ?? 0, language: language)
        } else if case .number(let number) = value {
            text = number.formatted(
                .number.locale(language.numberLocale).precision(.fractionLength(0...(fractionDigits ?? 18)))
                    .rounded(rule: .toNearestOrAwayFromZero))
        } else {
            text = value.text(language: language)
        }
        if let currency { return "\(text) \(currency)" }
        if unit == "percent" { return "\(text)%" }
        if unit == "stars" { return "\(text) ★" }
        return text
    }
    /// The value as a plain decimal string ("-1234.5"), minor units shifted to
    /// major ones; nil when it is none (text, or a number beyond exact integers).
    /// As on the web, a minor-unit number is shifted from its shortest text
    /// (12.5 cents → "0.125"), whatever its size.
    private var decimalText: String? {
        let minor = unit == "currency_minor" ? currency : nil
        var raw: String
        switch value {
        case .text(let text): raw = text
        case .number(let number) where minor != nil || (number.rounded() == number && abs(number) <= 9_007_199_254_740_991):
            guard let text = Self.plainDecimal(number) else { return nil }
            raw = text
        default: return nil
        }
        if let minor {
            raw = Self.majorAmount(raw, exponent: MetricFormat.exponent(of: minor))
        }
        return raw.wholeMatch(of: /-?[0-9]+(\.[0-9]+)?/) == nil ? nil : raw
    }
    /// A finite number's shortest round-trip text without an exponent, as
    /// JavaScript's String(number) for these values: 1e17 → "100000000000000000",
    /// 1.5e-7 → "0.00000015", -0.0 → "0".
    static func plainDecimal(_ number: Double) -> String? {
        guard number.isFinite else { return nil }
        if number == 0 { return "0" }
        let text = "\(abs(number))"
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = parts[0].split(separator: ".", omittingEmptySubsequences: false)
        var whole = String(mantissa[0])
        var fraction = mantissa.count > 1 ? String(mantissa[1]) : ""
        if parts.count > 1, let exponent = Int(parts[1]) {
            if exponent > 0 {
                fraction += String(repeating: "0", count: max(0, exponent - fraction.count))
                whole += fraction.prefix(exponent)
                fraction = String(fraction.dropFirst(exponent))
            } else if exponent < 0 {
                whole = String(repeating: "0", count: max(0, -exponent - whole.count + 1)) + whole
                let at = whole.index(whole.endIndex, offsetBy: exponent)
                fraction = whole[at...] + fraction
                whole = String(whole[..<at])
            }
        }
        while fraction.last == "0" { fraction.removeLast() }
        while whole.count > 1 && whole.first == "0" { whole.removeFirst() }
        if whole.isEmpty { whole = "0" }
        return (number < 0 ? "-" : "") + whole + (fraction.isEmpty ? "" : ".\(fraction)")
    }
    static func exactNumber(_ text: String, minimumFraction: Int, language: ScreenLanguage) -> String {
        if text == "—" { return text }
        let negative = text.hasPrefix("-")
        let parts = (negative ? String(text.dropFirst()) : text).split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts.first ?? "0")
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        let padded = fraction + String(repeating: "0", count: max(0, minimumFraction - fraction.count))
        var groups: [String] = []
        var remaining = whole
        while remaining.count > 3 {
            groups.insert(String(remaining.suffix(3)), at: 0)
            remaining = String(remaining.dropLast(3))
        }
        groups.insert(remaining, at: 0)
        return (negative ? "-" : "") + groups.joined(separator: language == .de ? "." : ",")
            + (padded.isEmpty ? "" : (language == .de ? "," : ".") + padded)
    }

    static func majorAmount(_ text: String, exponent: Int) -> String {
        guard exponent > 0 else { return text }
        let negative = text.hasPrefix("-")
        let raw = negative ? String(text.dropFirst()) : text
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts.first ?? "0")
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        let padded = String(repeating: "0", count: max(0, exponent + 1 - whole.count)) + whole
        let at = padded.index(padded.endIndex, offsetBy: -exponent)
        let result = "\(padded[..<at]).\(padded[at...])\(fraction)"
        return negative ? "-\(result)" : result
    }
}
public struct MeasureNamedField: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// The measure's value is a change ratio, (current − previous) / |previous|.
    /// Absent in payloads from servers before #486.
    public var percentChange: Bool? = nil
    /// A dimension's data type ("date", "timestamp", "decimal", …).
    public var type: String? = nil
}
public struct MeasureMetadata: Codable, Sendable, Equatable {
    public var modelId: String
    public var modelName: String
    public var measures: [MeasureNamedField]
    public var dimensions: [MeasureNamedField]
}
public struct MeasureResultRow: Codable, Sendable, Equatable {
    public var dimensionLabels: [String: String]? = nil
    public var dimensions: [String: MeasureValue]
    public var measures: [String: MeasureCell]
}
public struct MeasureProvenance: Codable, Sendable, Equatable {
    public var datasetId: String
    public var generationId: String
}
public struct MeasureResult: Codable, Sendable, Equatable {
    public var pendingSources: [String]? = nil
    public var releaseId: String?
    public var receivedAt: String?
    public var expiresAt: String?
    public var rows: [MeasureResultRow]
    public var totalRows: Int?
    public var warnings: [String]
    public var provenance: [MeasureProvenance]
    public var stale: Bool
}
public struct MeasureExclusion: Codable, Sendable, Equatable {
    public var filterId: String
    public var reason: String
}
public struct MeasureSourceHealth: Codable, Sendable, Equatable {
    public var connectionId: String
    public var name: String
    public var status: String
    public var lastSuccessAt: String?
}
public struct MeasureWidgetData: Codable, Sendable, Equatable {
    public var sourceHealth: [MeasureSourceHealth]? = nil
    public var scope: [String]?
    public var metadata: MeasureMetadata?
    public var result: MeasureResult?
    public var error: String?
    public var exclusions: [MeasureExclusion]
    /// How far the model's sources reach (ADR 0025); nil without it.
    public var freshness: WidgetFreshness? = nil
}
extension MeasureWidgetData {
    private enum CodingKeys: String, CodingKey {
        case sourceHealth, scope, metadata, result, error, exclusions, freshness
    }
    /// As the synthesized decoding, except that `freshness` is read
    /// leniently: a newer or damaged one never fails the widget.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sourceHealth = try c.decodeIfPresent([MeasureSourceHealth].self, forKey: .sourceHealth)
        scope = try c.decodeIfPresent([String].self, forKey: .scope)
        metadata = try c.decodeIfPresent(MeasureMetadata.self, forKey: .metadata)
        result = try c.decodeIfPresent(MeasureResult.self, forKey: .result)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        exclusions = try c.decode([MeasureExclusion].self, forKey: .exclusions)
        freshness = c.lenient(WidgetFreshness.self, .freshness)
    }
}
/**
 * What a measure tile says about its state on a wall screen, worded as the
 * web kiosk's viewer wording (`audience="viewer"`, #649, #676): the state
 * only, since nobody at a TV can check a model or reconnect a source.
 */
extension MeasureWidgetData {
    /// The line instead of the data when the request failed or the result
    /// expired: "Data not available yet" while the source has not imported,
    /// else "Data not available"; nil with data to show.
    public func viewerError(expired: Bool, language: ScreenLanguage) -> String? {
        guard error != nil || expired else { return nil }
        return KitStrings.text(
            error == "data_source_pending" && !expired ? .measurePending : .measureUnavailable, language)
    }
    /// "Some source data is missing." for partial cells, then "2 data
    /// warnings" for the result's warnings.
    public func viewerWarnings(rows: [MeasureResultRow], language: ScreenLanguage) -> [String] {
        var lines: [String] = []
        if rows.contains(where: { $0.measures.values.contains { $0.status == "partial" } }) {
            lines.append(KitStrings.text(.measurePartial, language))
        }
        if let count = result?.warnings.count, count > 0 {
            lines.append(
                KitStrings.text(count == 1 ? .measureWarningOne : .measureWarningOther, language, count))
        }
        return lines
    }
    /// One line per source that is not ok, worded as the web's viewer
    /// branch: "Imports from Apple team are paused." when its access expired
    /// or was rejected, "… interrupted." on an outage, and the collection
    /// pause or first import by name. Keyed by connection and state, so two
    /// connections with the same name stay two lines.
    public func viewerSourceNotices(language: ScreenLanguage) -> [MeasureNotice] {
        (sourceHealth ?? []).filter { $0.status != "ok" }.map { source in
            let key: KitText =
                switch source.status {
                case "needs_reauthorization", "auth_failed": .measureSourcePaused
                case "paused": .measureSourceCollectionPaused
                case "pending": .measureSourcePending
                default: .measureSourceOutage
                }
            return MeasureNotice(
                id: "\(source.connectionId)|\(source.status)", text: KitStrings.text(key, language, source.name))
        }
    }
}

extension MeasureWidgetData {
    /// The state the freshness line is worded for (ADR 0025 section 8): a
    /// failing or stale source keeps the line to the day its numbers reach.
    public var freshnessStatus: DeviceTileStatus {
        let failing: Set<String> = ["auth_failed", "needs_reauthorization", "outage", "stale"]
        return (sourceHealth ?? []).contains { failing.contains($0.status) } ? .outage : .ok
    }
}

/** A line under a measure tile, with an id that is unique on the tile. */
public struct MeasureNotice: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

extension MeasureWidgetData {
    /// A measure cell as displayed, honouring the measure's metadata.
    public func text(
        _ cell: MeasureCell?, measure id: String, language: ScreenLanguage, timeZone: TimeZone = .current
    ) -> String {
        cell?.text(
            language: language,
            percentChange: metadata?.measures.first { $0.id == id }?.percentChange == true, timeZone: timeZone) ?? "—"
    }
    /// A row's dimension value as displayed: its label, else the value in its
    /// type's format (a day as "07.01.2026", like the web's table and charts).
    public func dimensionText(
        _ row: MeasureResultRow, dimension id: String, language: ScreenLanguage, timeZone: TimeZone = .current
    ) -> String {
        if let label = row.dimensionLabels?[id] { return label }
        guard let value = row.dimensions[id] else { return "—" }
        let type = metadata?.dimensions.first { $0.id == id }?.type ?? "string"
        return MeasureCell(value: value, type: type, unit: nil, currency: nil, status: "ok")
            .text(language: language, timeZone: timeZone)
    }
    public var expirationDate: Date? {
        guard let raw = result?.expiresAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
    public func expired(at now: Date = Date()) -> Bool {
        guard result?.expiresAt != nil else { return false }
        return expirationDate.map { $0 <= now } ?? true
    }
}
public struct MeasureWidgetOptions: Codable, Sendable, Equatable {
    public var view: String
    public var limit: Int
    public init(view: String = "value", limit: Int = 20) {
        self.view = view
        self.limit = limit
    }
}

/**
 * Display rules shared with packages/domain/src/dashboard-data.ts (#619):
 * MEASURE_UNIT_FRACTION_DIGITS, roundDecimalText and formatDataDate.
 */
public enum DataFormat {
    /// Fraction digits a unit's values are shown with; other units show every digit.
    public static let unitFractionDigits: [String: Int] = ["stars": 2]

    /**
     * A decimal string rounded to at most `digits` fraction digits, half away
     * from zero, trailing zeros dropped; computed on the digits, never through
     * a Double. Text that is no plain decimal is returned unchanged.
     */
    public static func roundDecimalText(_ raw: String, digits: Int) -> String {
        guard let match = raw.wholeMatch(of: /(-?)([0-9]+)(?:\.([0-9]+))?/) else { return raw }
        let negative = !match.1.isEmpty
        let given = match.3.map(String.init) ?? ""
        let fraction = Array(given.utf8) + Array(repeating: UInt8(ascii: "0"), count: max(0, digits + 1 - given.utf8.count))
        var scaled = Array(match.2.utf8) + fraction[..<digits]
        if fraction[digits] >= UInt8(ascii: "5") {
            var index = scaled.count - 1
            while index >= 0 && scaled[index] == UInt8(ascii: "9") {
                scaled[index] = UInt8(ascii: "0")
                index -= 1
            }
            if index >= 0 { scaled[index] += 1 } else { scaled.insert(UInt8(ascii: "1"), at: 0) }
        }
        // Leading zeros off, then at least one integer digit.
        while scaled.count > digits + 1 && scaled.first == UInt8(ascii: "0") { scaled.removeFirst() }
        let text = String(decoding: scaled, as: UTF8.self)
        let integer = text.dropLast(digits)
        var rest = text.suffix(digits)
        while rest.last == "0" { rest = rest.dropLast() }
        let result = rest.isEmpty ? String(integer) : "\(integer).\(rest)"
        return negative && result.contains(where: { ("1"..."9").contains($0) }) ? "-\(result)" : result
    }

    /**
     * A date or timestamp value as people read it: a calendar day
     * ("YYYY-MM-DD") in the language's medium date style ("Jan 7, 2026",
     * "07.01.2026"), the same day in every time zone; a timestamp adds the
     * time of day in `timeZone`. Nil when the value is no valid date of that type.
     */
    public static func date(
        _ value: String, type: String, language: ScreenLanguage, timeZone: TimeZone = .current
    ) -> String? {
        let utc = TimeZone(identifier: "UTC")!
        switch type {
        case "date":
            guard let match = value.wholeMatch(of: /([0-9]{4})-([0-9]{2})-([0-9]{2})/),
                let year = Int(match.1), let month = Int(match.2), let day = Int(match.3)
            else { return nil }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = utc
            // 2026-02-30 rolls over to March: not a day.
            guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
                calendar.dateComponents([.year, .month, .day], from: date)
                    == DateComponents(year: year, month: month, day: day)
            else { return nil }
            return format(date, language, timeZone: utc, date: .medium, time: .none)
        case "timestamp":
            guard value.prefixMatch(of: /[0-9]{4}-[0-9]{2}-[0-9]{2}T/) != nil, let date = ISODate.parse(value) else {
                return nil
            }
            // Joined like Intl's "Jan 7, 2026, 9:15 AM"; Apple writes " at " in English.
            let day = format(date, language, timeZone: timeZone, date: .medium, time: .none)
            let time = format(date, language, timeZone: timeZone, date: .none, time: .short)
            // Plain spaces: ICU writes a narrow no-break space before "AM".
            return "\(day), \(time)".replacingOccurrences(of: "\u{202F}", with: " ")
        default:
            return nil
        }
    }

    /// Formatters by language, zone and style: SwiftUI bodies call this per cell.
    private static let formatters = Mutex<[String: DateFormatter]>([:])

    private static func format(
        _ value: Date, _ language: ScreenLanguage, timeZone: TimeZone, date: DateFormatter.Style,
        time: DateFormatter.Style
    ) -> String {
        let key = "\(language.rawValue)|\(timeZone.identifier)|\(date.rawValue)|\(time.rawValue)"
        return formatters.withLock { cache in
            if let formatter = cache[key] { return formatter.string(from: value) }
            let formatter = DateFormatter()
            // The web's locales: "en" reads as en-US ("Jan 7, 2026"), "de" as de-DE.
            formatter.locale = language.numberLocale
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = timeZone
            formatter.dateStyle = date
            formatter.timeStyle = time
            cache[key] = formatter
            return formatter.string(from: value)
        }
    }
}
