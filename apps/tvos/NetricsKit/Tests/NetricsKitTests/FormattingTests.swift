import Foundation
import Testing

@testable import NetricsKit

// Parity with apps/web/src/lib/format-metric.test.ts, tile-status.ts,
// relative-time.ts and tv-grid.test.ts.

@Suite struct FormatValueTests {
    @Test(arguments: [
        (1284.0 as Double?, "signups", "1,284"),
        (12_900, "visitors", "12.9K"),
        (4_200_000, "visitors", "4.2M"),
        (3.14159, "seconds", "3.14"),
        (123_456, "EUR_minor", "€1,234.56"),
        (420_000_000, "USD_minor", "$4.2M"),
        (42.25, "percent", "42.3%"),
        (nil, "visitors", "—"),
        (1500, "EUR_minor", "€15"),
        (0, "count", "0"),
        (-1284, "count", "-1,284"),
        // ISO 4217 exponents: JPY has none, BHD three.
        (1_234, "JPY_minor", "¥1,234"),
        (150, "EUR_minor", "€1.50"),
        (99, "USD_minor", "$0.99"),
    ])
    func formats(_ value: Double?, _ unit: String, _ expected: String) {
        #expect(MetricFormat.value(value, unit: unit) == expected)
    }
}

@Suite struct FormatChangeTests {
    @Test func relativeChangeWithSign() {
        #expect(MetricFormat.change(delta: 50, ratio: 0.5, unit: "signups") == .init(direction: .up, text: "+50%"))
        #expect(
            MetricFormat.change(delta: -3, ratio: -0.034, unit: "signups") == .init(direction: .down, text: "−3.4%"))
        #expect(MetricFormat.change(delta: 0, ratio: 0, unit: "signups") == .init(direction: .flat, text: "±0%"))
    }

    @Test func absoluteChangeWithoutRatio() {
        #expect(MetricFormat.change(delta: 1500, ratio: nil, unit: "EUR_minor") == .init(direction: .up, text: "+€15"))
    }

    @Test func nothingWithoutPreviousValue() {
        #expect(MetricFormat.change(delta: nil, ratio: nil, unit: "signups") == nil)
    }

    @Test func changeLineLikeTheWeb() {
        var tile = dashboard("v1").tiles[0]
        tile.period = .last7Days
        tile.change = TileChange(previousValue: 40, delta: 10, ratio: 0.25)
        #expect(MetricFormat.changeLine(tile).text == "▲ +25% vs previous 7 days")
        tile.change = TileChange(previousValue: nil, delta: nil, ratio: nil)
        #expect(MetricFormat.changeLine(tile).text == "No data to compare vs previous 7 days")
        tile.value = nil
        #expect(MetricFormat.changeLine(tile).text == "No data for this period yet")
        #expect(MetricFormat.subtitle(tile) == "Last 7 days · Total")
    }

    @Test func titlePartsSplitMetricAndResource() {
        let wurfel = MetricFormat.titleParts("Downloads · Wurfel – Cube Solver")
        #expect(wurfel.title == "Downloads")
        #expect(wurfel.detail == "Wurfel – Cube Solver")
        // Only the first separator splits; the resource name keeps the rest.
        let dotted = MetricFormat.titleParts("Clicks · sc-domain:a · b")
        #expect(dotted.title == "Clicks")
        #expect(dotted.detail == "sc-domain:a · b")
        let plain = MetricFormat.titleParts("Signups this week")
        #expect(plain.title == "Signups this week")
        #expect(plain.detail == nil)
        #expect(MetricFormat.titleParts(" · x").detail == nil)
    }
}

@Suite struct TileNoticeTests {
    @Test func noticesMatchTheWeb() {
        let now = T0
        #expect(TileNotices.notice(status: .ok, updatedAt: nil, now: now) == nil)
        #expect(TileNotices.notice(status: .noData, updatedAt: nil, now: now) == nil)
        #expect(TileNotices.notice(status: .authFailed, updatedAt: nil, now: now) == "Connection needs new credentials")
        #expect(TileNotices.notice(status: .outage, updatedAt: nil, now: now) == "Source unreachable")
        #expect(TileNotices.notice(status: .stale, updatedAt: nil, now: now) == "Waiting for the first sync")
        #expect(
            TileNotices.notice(status: .stale, updatedAt: "2026-09-29T07:00:00.000Z", now: now)
                == "Last sync 3 hours ago")
    }

    @Test func relativeTime() {
        #expect(RelativeTime.describe(nil, now: T0) == "never")
        #expect(RelativeTime.describe("2026-09-29T09:59:30.000Z", now: T0) == "just now")
        #expect(RelativeTime.describe("2026-09-29T09:55:00.000Z", now: T0) == "5 minutes ago")
        #expect(RelativeTime.describe("2026-09-29T09:59:00.000Z", now: T0) == "1 minute ago")
        #expect(RelativeTime.describe("2026-09-27T10:00:00Z", now: T0) == "2 days ago")
        #expect(RelativeTime.describe("2026-09-29T12:00:00.000Z", now: T0) == "in 2 hours")
    }
}

@Suite struct TVGridTests {
    @Test(arguments: [
        (0, 1, 1), (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 2, 2), (6, 3, 2), (8, 4, 2), (9, 3, 3), (12, 4, 3),
        (24, 6, 4),
    ])
    func grid(_ tiles: Int, _ columns: Int, _ rows: Int) {
        let layout = TVGrid.layout(tiles: tiles)
        #expect(layout.columns == columns)
        #expect(layout.rows == rows)
    }

    @Test func alwaysFitsEveryTile() {
        for tiles in 1...24 {
            let (columns, rows) = TVGrid.layout(tiles: tiles)
            #expect(columns * rows >= tiles)
            #expect(columns * (rows - 1) < tiles)
        }
    }
}

@Suite struct SparklineTests {
    @Test func nullsAreGaps() {
        let segments = Sparkline.segments([1, 2, nil, 4, nil, nil, 7, 8])
        #expect(segments.map { $0.map(\.index) } == [[0, 1], [3], [6, 7]])
        #expect(segments.map { $0.map(\.value) } == [[1, 2], [4], [7, 8]])
    }

    @Test func drawableLikeTheWeb() {
        #expect(Sparkline.isDrawable([1, nil]))
        #expect(!Sparkline.isDrawable([1]))
        #expect(!Sparkline.isDrawable([nil, nil]))
    }
}

@Suite struct TVTimeTests {
    @Test func inTheWorkspaceZone() {
        #expect(TVTime.hourMinute(T0, timeZone: "Europe/Berlin") == "12:00")
        #expect(TVTime.offlineMarker(updatedAt: T0, timeZone: "UTC") == "Offline — last update 10:00")
        #expect(TVTime.offlineMarker(updatedAt: nil, timeZone: "UTC") == "Offline")
        #expect(TVTime.clock(T0, timeZone: "Europe/Berlin") == "Tue 29 Sep, 12:00")
    }
}

@Suite struct ModelTests {
    @Test func decodesTheServerPayload() throws {
        let body = """
            {"version":"abc","refreshAfterSec":60,"timeZone":"Europe/Berlin",
             "dashboard":{"id":"4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f","name":"Sales"},
             "tiles":[{"id":"9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a","label":"MRR","period":"this_month",
               "aggregation":"last","value":123456,"unit":"EUR_minor",
               "change":{"previousValue":100000,"delta":23456,"ratio":0.23456},
               "spark":[1,null,3],"status":"auth_failed","updatedAt":null}]}
            """
        let payload = try JSONDecoder().decode(DeviceDashboard.self, from: Data(body.utf8))
        #expect(payload.tiles[0].period == .thisMonth)
        #expect(payload.tiles[0].aggregation == .last)
        #expect(payload.tiles[0].status == .authFailed)
        #expect(payload.tiles[0].spark == [1, nil, 3])
        #expect(payload.tiles[0].updatedAt == nil)
        // Round trip through the disk cache keeps it intact.
        let again = try JSONDecoder().decode(DeviceDashboard.self, from: JSONEncoder().encode(payload))
        #expect(again == payload)
    }

    @Test func toleratesNewEnumValues() throws {
        let body = """
            {"version":"abc","refreshAfterSec":60,"timeZone":"UTC","dashboard":null,
             "tiles":[{"id":"x","label":"L","period":"last_90_days","aggregation":"median","value":null,
               "unit":null,"change":{"previousValue":null,"delta":null,"ratio":null},
               "spark":[],"status":"brand_new","updatedAt":null}]}
            """
        let payload = try JSONDecoder().decode(DeviceDashboard.self, from: Data(body.utf8))
        #expect(payload.dashboard == nil)
        #expect(payload.tiles[0].period == .unknown)
        #expect(payload.tiles[0].status == .ok)
    }

    @Test func decodesPollResponses() throws {
        let pending = #"{"status":"pending","expiresAt":"2026-09-29T10:10:00.000Z"}"#
        #expect(
            try JSONDecoder().decode(PollPairingResponse.self, from: Data(pending.utf8))
                == .pending(expiresAt: "2026-09-29T10:10:00.000Z"))
        let approved = """
            {"status":"approved","device":{"id":"d","name":"Lobby"},
             "credentials":{"accessToken":"a","accessTokenExpiresAt":"2026-09-29T11:00:00.000Z",
               "refreshToken":"r","refreshTokenExpiresAt":"2026-12-28T10:00:00.000Z"}}
            """
        guard case .approved(let device, let credentials) = try JSONDecoder().decode(
            PollPairingResponse.self, from: Data(approved.utf8))
        else {
            Issue.record("expected approved")
            return
        }
        #expect(device.name == "Lobby")
        #expect(credentials.isComplete)
    }

    @Test func heartbeatSendsExplicitNull() throws {
        let data = try JSONEncoder().encode(DeviceHeartbeatRequest(appVersion: "1", uptimeSeconds: 3, lastError: nil))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?["lastError"] is NSNull)
    }

    @Test func fileCacheRoundTrip() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "netrics-test-\(UUID())/dashboard.json")
        let cache = FileDashboardCache(fileURL: url)
        #expect(cache.load() == nil)
        let entry = CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: T0)
        cache.save(entry)
        #expect(cache.load() == entry)
        cache.clear()
        #expect(cache.load() == nil)
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    @Test func qrCodeRenders() {
        #expect(QRCode.image(for: "https://netrics.tv/link?code=ABCD-EFGH") != nil)
    }
}

// Parity with apps/web/src/lib/pairing-address.test.ts.
@Suite struct PairingAddressTests {
    @Test(arguments: [
        ("https://netrics.tv", "netrics.tv"),
        ("https://netrics.tv/", "netrics.tv"),
        ("https://app.example.com/devices/approve", "app.example.com/devices/approve"),
        ("http://nas.local:8080/devices/approve/", "nas.local:8080/devices/approve"),
        ("netrics.tv", "netrics.tv"),
    ])
    func showsHostAndPath(_ url: String, _ expected: String) {
        #expect(PairingAddress.display(url) == expected)
    }
}
