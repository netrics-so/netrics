import Foundation

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
            return language == .de ? (value ? "Wahr" : "Falsch") : (value ? "True" : "False")
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
    private var decimalText: String? {
        var raw: String
        switch value {
        case .text(let text): raw = text
        case .number(let number) where number.rounded() == number && abs(number) <= 9_007_199_254_740_991:
            raw = String(format: "%.0f", number)
        default: return nil
        }
        if unit == "currency_minor", let currency {
            raw = Self.majorAmount(raw, exponent: MetricFormat.exponent(of: currency))
        }
        return raw.wholeMatch(of: /-?\d+(\.\d+)?/) == nil ? nil : raw
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
        guard let match = raw.wholeMatch(of: /(-?)(\d+)(?:\.(\d+))?/) else { return raw }
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
            guard let match = value.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
                let year = Int(match.1), let month = Int(match.2), let day = Int(match.3)
            else { return nil }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = utc
            // 2026-02-30 rolls over to March: not a day.
            guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
                calendar.dateComponents([.year, .month, .day], from: date)
                    == DateComponents(year: year, month: month, day: day)
            else { return nil }
            return formatter(language, timeZone: utc, date: .medium, time: .none).string(from: date)
        case "timestamp":
            guard value.prefixMatch(of: /\d{4}-\d{2}-\d{2}T/) != nil, let date = ISODate.parse(value) else {
                return nil
            }
            // Joined like Intl's "Jan 7, 2026, 9:15 AM"; Apple writes " at " in English.
            let day = formatter(language, timeZone: timeZone, date: .medium, time: .none).string(from: date)
            let time = formatter(language, timeZone: timeZone, date: .none, time: .short).string(from: date)
            // Plain spaces: ICU writes a narrow no-break space before "AM".
            return "\(day), \(time)".replacingOccurrences(of: "\u{202F}", with: " ")
        default:
            return nil
        }
    }

    private static func formatter(
        _ language: ScreenLanguage, timeZone: TimeZone, date: DateFormatter.Style, time: DateFormatter.Style
    ) -> DateFormatter {
        let formatter = DateFormatter()
        // The web's locales: "en" reads as en-US ("Jan 7, 2026"), "de" as de-DE.
        formatter.locale = language.numberLocale
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateStyle = date
        formatter.timeStyle = time
        return formatter
    }
}
