import Foundation
import Testing

@testable import NetricsKit

// Display currency (#191): converted tiles carry an optional `conversion`.

private func tileJSON(_ extra: String) -> String {
    """
    {"version":"v","refreshAfterSec":60,"timeZone":"UTC","dashboard":{"id":"d","name":"D"},
     "tiles":[{"id":"t","label":"Proceeds · All apps","period":"last_7_days","aggregation":"sum",
       "value":33982,"unit":"EUR_minor","change":{"previousValue":null,"delta":null,"ratio":null},
       "spark":[1,2],"kind":"delta","granularity":"day","better":"higher","status":"ok",
       "updatedAt":null\(extra)}]}
    """
}

private func decode(_ extra: String) throws -> DeviceTile {
    try JSONDecoder().decode(DeviceDashboard.self, from: Data(tileJSON(extra).utf8)).tiles[0]
}

@Suite struct ConversionTests {
    @Test func decodesConversion() throws {
        let tile = try decode("""
            ,"conversion":{"displayCurrency":"EUR","source":"ECB euro foreign exchange reference rates",
              "unconverted":[{"currency":"TWD","value":108000},{"currency":"CLP","value":null}]}
            """)
        #expect(tile.conversion?.displayCurrency == "EUR")
        #expect(tile.conversion?.unconverted.map(\.currency) == ["TWD", "CLP"])
        #expect(tile.label == "Proceeds · All apps")
        // Round trip, as the app caches the payload.
        let again = try JSONDecoder().decode(DeviceTile.self, from: JSONEncoder().encode(tile))
        #expect(again == tile)
    }

    @Test func olderServersAndUnknownShapesKeepTheTile() throws {
        #expect(try decode("").conversion == nil)
        #expect(try decode(",\"conversion\":null").conversion == nil)
        #expect(try decode(",\"conversion\":{\"rate\":\"1.12\"}").conversion == nil)
        #expect(try decode(",\"conversion\":\"EUR\"").value == 33982)
    }

    @Test func marksConvertedValuesApproximate() throws {
        let converted = try decode("""
            ,"conversion":{"displayCurrency":"EUR","source":"ECB euro foreign exchange reference rates","unconverted":[]}
            """)
        #expect(ConversionFormat.value(converted, unit: "EUR_minor") == "≈ €339.82")
        #expect(ConversionFormat.value(try decode(""), unit: "EUR_minor") == "€339.82")
        var empty = converted
        empty.value = nil
        #expect(ConversionFormat.value(empty, unit: "EUR_minor") == "—")
    }

    @Test func noteCitesTheSourceAndWhatWasLeftOut() {
        let ecb = "ECB euro foreign exchange reference rates"
        #expect(ConversionFormat.note(nil) == nil)
        #expect(
            ConversionFormat.note(TileConversion(displayCurrency: "EUR", source: ecb, unconverted: []))
                == "ECB reference rates")
        #expect(
            ConversionFormat.note(
                TileConversion(
                    displayCurrency: "USD", source: ecb,
                    unconverted: [.init(currency: "TWD", value: 3000), .init(currency: "AED", value: nil)]))
                == "ECB reference rates · TWD, AED not converted")
    }
}
