import Foundation
import Testing

@testable import NetricsKit

// Runs the measure-cell vectors the web's formatMeasureCell passes too
// (packages/domain/test-vectors/measure-cells.json, #619, #835), read
// straight from the repository: the same rounding and unit words on the TV.

@Suite struct MeasureCellVectorTests {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // NetricsKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // NetricsKit
        .deletingLastPathComponent()  // netrics-tv
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("packages/domain/test-vectors/measure-cells.json")

    @Test func everyCaseReadsAsOnTheWeb() throws {
        let data = try Data(contentsOf: Self.url)
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(root["cases"] as? [[String: Any]])
        #expect(cases.count >= 20)
        for c in cases {
            var object: [String: Any] = ["value": c["value"]!, "type": c["type"]!, "status": "ok"]
            object["unit"] = c["unit"] ?? NSNull()
            object["currency"] = c["currency"] ?? NSNull()
            let cell = try JSONDecoder().decode(MeasureCell.self, from: JSONSerialization.data(withJSONObject: object))
            let single = c["single"] as? Bool ?? false
            for language in [ScreenLanguage.en, .de] {
                #expect(
                    cell.text(language: language, timeZone: TimeZone(identifier: "UTC")!, single: single)
                        == c[language.rawValue] as? String, "\(c)")
            }
        }
    }
}
