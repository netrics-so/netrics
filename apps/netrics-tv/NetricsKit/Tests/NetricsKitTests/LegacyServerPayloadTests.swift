import Foundation
import Testing

@testable import NetricsKit

// The server's recorded payloads of schemas 1–3
// (apps/server/src/devices/fixtures/compare-legacy-payloads.json, pinned
// byte for byte by the server's compare-binding test) must decode in this
// app and survive its offline cache, so an older server, or a payload a TV
// cached before an update, keeps playing.

private let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // NetricsKitTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // NetricsKit
    .deletingLastPathComponent()  // netrics-tv
    .deletingLastPathComponent()  // apps
    .deletingLastPathComponent()  // repository
    .appendingPathComponent("apps/server/src/devices/fixtures/compare-legacy-payloads.json")

private func recorded(_ key: String) throws -> Data {
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
    return try JSONSerialization.data(withJSONObject: try #require(root[key]))
}

@Suite struct LegacyServerPayloadTests {
    @Test(arguments: [("schema1", 1), ("schema2", 2), ("schema3", 3), ("german", 3)])
    func serverPayloadDecodes(key: String, schema: Int) throws {
        let payload = try JSONDecoder().decode(DashboardPayload.self, from: recorded(key))
        #expect(payload.schema == schema)
        #expect(payload.hasDashboard)
    }

    @Test(arguments: ["schema1", "schema2", "schema3", "german"])
    func serverPayloadSurvivesTheOfflineCache(key: String) throws {
        let payload = try JSONDecoder().decode(DashboardPayload.self, from: recorded(key))
        let cache = FileDashboardCache(
            fileURL: FileManager.default.temporaryDirectory.appending(path: "netrics-\(UUID().uuidString)/d.json"))
        defer { cache.clear() }
        let entry = CachedDashboard(
            etag: "\"\(key)\"", payload: payload, updatedAt: Date(timeIntervalSince1970: 1_759_140_000))
        cache.save(entry)
        #expect(cache.load() == entry)
    }
}
