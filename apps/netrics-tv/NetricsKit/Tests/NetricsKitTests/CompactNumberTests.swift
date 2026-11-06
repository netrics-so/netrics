import Foundation
import Testing

@testable import NetricsKit

// Runs the compact-number vectors the TypeScript generates
// (packages/domain/test-vectors/compact-numbers.json, `pnpm vectors:compact`),
// read straight from the repository, so the TV writes 12,9 Tsd. where the
// web does.

enum CompactVectors {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // NetricsKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // NetricsKit
        .deletingLastPathComponent()  // tvos
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("packages/domain/test-vectors/compact-numbers.json")

    struct Case: Sendable {
        var value: Double
        var currency: String?
        var text: String
    }

    static func cases(_ language: ScreenLanguage, _ key: String) -> [Case] {
        let data = try! Data(contentsOf: url)
        let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let locales = root["locales"] as! [String: Any]
        let entry = locales[language.rawValue] as! [String: Any]
        return (entry[key] as! [[String: Any]]).map {
            Case(
                value: ($0["value"] as! NSNumber).doubleValue, currency: $0["currency"] as? String,
                text: $0["text"] as! String)
        }
    }
}

@Suite struct CompactNumberVectorTests {
    @Test(arguments: ScreenLanguage.allCases)
    func fullForm(_ language: ScreenLanguage) {
        let cases = CompactVectors.cases(language, "full")
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(MetricFormat.compactAmount(c.value, language: language) == c.text, "\(c.value)")
            #expect(MetricFormat.value(c.value, unit: "count", language: language) == c.text, "\(c.value)")
        }
    }

    @Test(arguments: ScreenLanguage.allCases)
    func fullFormAmounts(_ language: ScreenLanguage) {
        let cases = CompactVectors.cases(language, "fullCurrency")
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(
                MetricFormat.compactAmount(c.value, currency: c.currency, language: language) == c.text,
                "\(c.value) \(c.currency ?? "")")
        }
    }

    @Test(arguments: ScreenLanguage.allCases)
    func narrowForm(_ language: ScreenLanguage) {
        let cases = CompactVectors.cases(language, "narrow")
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(MetricFormat.compactNumber(c.value, language: language) == c.text, "\(c.value)")
            #expect(MetricFormat.compactValue(c.value, unit: "count", language: language) == c.text, "\(c.value)")
        }
    }

    @Test(arguments: ScreenLanguage.allCases)
    func narrowFormAmounts(_ language: ScreenLanguage) {
        let cases = CompactVectors.cases(language, "narrowCurrency")
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(
                MetricFormat.compactAmount(c.value, currency: c.currency, language: language) == c.text,
                "\(c.value) \(c.currency ?? "")")
        }
    }

    @Test func tilesInGermanReadAsOnTheWeb() {
        #expect(MetricFormat.value(12_900, unit: "count", language: .de) == "12,9\u{00A0}Tsd.")
        #expect(MetricFormat.value(4_200_000, unit: "count", language: .de) == "4,2\u{00A0}Mio.")
        #expect(MetricFormat.value(420_000_000, unit: "EUR_minor", language: .de) == "4,2\u{00A0}Mio.\u{00A0}€")
        #expect(MetricFormat.compactValue(1_234_550, unit: "EUR_minor", language: .de) == "12,3\u{00A0}Tsd.\u{00A0}€")
        #expect(MetricFormat.value(12_900, unit: "count", language: .en) == "12.9K")
        #expect(MetricFormat.compactValue(12_345, unit: "count", language: .de) == "12,3K")
    }
}
