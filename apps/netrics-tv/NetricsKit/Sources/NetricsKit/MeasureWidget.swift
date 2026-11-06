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

    public func text(language: ScreenLanguage) -> String {
        var value = self.value.text(language: language)
        if unit == "currency_minor", let currency, self.value != .null {
            // Shift the decimal point using text, preserving all provider digits.
            let raw: String
            switch self.value {
            case .text(let text): raw = text
            case .number(let number): raw = String(format: "%.0f", number)
            default: raw = value
            }
            value = Self.majorAmount(raw, exponent: MetricFormat.exponent(of: currency))
        }
        if type == "decimal" || currency != nil {
            let raw: String
            if unit == "currency_minor" {
                raw = value
            } else if case .text(let text) = self.value {
                raw = text
            } else {
                raw = value.replacingOccurrences(of: language == .de ? "." : ",", with: "")
            }
            value = Self.exactNumber(
                raw, minimumFraction: currency.map { MetricFormat.exponent(of: $0) } ?? 0, language: language)
        }
        if let currency, self.value != .null { return "\(value) \(currency)" }
        if self.value != .null && unit == "stars" { return "\(value) ★" }
        if self.value != .null && unit == "percent" { return "\(value)%" }
        return value
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
