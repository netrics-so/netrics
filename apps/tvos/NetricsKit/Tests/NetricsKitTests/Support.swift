import Foundation
import Synchronization

@testable import NetricsKit

let T0 = ISODate.parse("2026-09-29T10:00:00.000Z")!
let pairingID = "0b8f6a52-7c1e-4a8e-9a55-3d6f0e3b2a11"
let pollSecret = String(repeating: "s", count: 43)
let testServer = ServerConfig(baseURL: URL(string: "https://kiosk.test")!, kind: .custom)

/** A clock the test moves by hand. */
final class ManualClock: Sendable {
    private let current = Mutex(T0)

    var now: Date { current.withLock { $0 } }

    func advance(_ duration: Duration) {
        let seconds = Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
        current.withLock { $0 = $0.addingTimeInterval(seconds) }
    }

    func advance(seconds: TimeInterval) {
        current.withLock { $0 = $0.addingTimeInterval(seconds) }
    }
}

struct Call: Sendable {
    var method: String
    var path: String
    var query: String?
    var headers: [String: String]
    var body: Data?
    /** Seconds since T0. */
    var at: TimeInterval

    func header(_ name: String) -> String? {
        headers.first { $0.key.lowercased() == name.lowercased() }?.value
    }

    func json() -> [String: Any]? {
        guard let body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
}

typealias Handler = @Sendable (Call) async throws -> HTTPResponse

/** A scripted API: one handler per "METHOD /path", recording each call. */
final class FakeAPI: HTTPTransport {
    private let routes: Mutex<[String: Handler]>
    private let recorded = Mutex<[Call]>([])
    let clock: ManualClock

    init(clock: ManualClock, routes: [String: Handler]) {
        self.clock = clock
        self.routes = Mutex(routes)
    }

    func route(_ key: String, _ handler: @escaping Handler) {
        routes.withLock { $0[key] = handler }
    }

    var calls: [Call] { recorded.withLock { $0 } }

    func callsTo(_ key: String) -> [Call] {
        calls.filter { "\($0.method) \($0.path)" == key }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let call = Call(
            method: request.method, path: request.url.path(), query: request.url.query(), headers: request.headers,
            body: request.body, at: clock.now.timeIntervalSince(T0))
        recorded.withLock { $0.append(call) }
        guard let handler = routes.withLock({ $0["\(call.method) \(call.path)"] }) else {
            throw TransportError.unreachable("no route \(call.method) \(call.path)")
        }
        return try await handler(call)
    }
}

func json(_ value: some Encodable, status: Int = 200, headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, headers: headers, body: try! JSONEncoder().encode(value))
}

func jsonObject(_ object: [String: Any], status: Int, headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, headers: headers, body: try! JSONSerialization.data(withJSONObject: object))
}

func credentialsFor(_ name: String, accessExpiresIn: TimeInterval = 3600, clock: ManualClock) -> DeviceCredentials {
    DeviceCredentials(
        accessToken: "access-\(name)",
        accessTokenExpiresAt: ISODate.format(clock.now.addingTimeInterval(accessExpiresIn)),
        refreshToken: "refresh-\(name)",
        refreshTokenExpiresAt: ISODate.format(clock.now.addingTimeInterval(90 * 24 * 3600))
    )
}

func dashboard(_ version: String, value: Double = 42) -> DeviceDashboard {
    DeviceDashboard(
        version: version,
        refreshAfterSec: 60,
        timeZone: "Europe/Berlin",
        dashboard: .init(id: "4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "Sales"),
        tiles: [
            DeviceTile(
                id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
                label: "Revenue",
                period: .today,
                aggregation: .sum,
                value: value,
                unit: "count",
                change: TileChange(previousValue: 40, delta: value - 40, ratio: 0.05),
                spark: [1, 2, nil, 4],
                status: .ok,
                updatedAt: "2026-09-29T09:55:00.000Z"
            )
        ]
    )
}

func pairingResponse(_ code: String = "ABCD-EFGH", clock: ManualClock) -> HTTPResponse {
    json(
        CreatePairingResponse(
            pairingId: pairingID,
            code: code,
            pollSecret: pollSecret,
            expiresAt: ISODate.format(clock.now.addingTimeInterval(600)),
            pollIntervalSeconds: 5,
            pairingUrl: "https://kiosk.test/devices/approve",
            approveUrl: "https://kiosk.test/devices/approve?code=\(code)"
        ))
}

/**
 * A client with a scripted API, in-memory storage and a manual clock.
 * `advance(_:)` works like vitest's advanceTimersByTimeAsync: every step
 * due within the window runs, at the time it is due.
 */
final class Harness {
    let clock: ManualClock
    let api: FakeAPI
    let store: InMemoryCredentialStore
    let cache: InMemoryDashboardCache
    let client: DeviceClient
    /** When the client's next step is due; nil once it stopped. */
    private var nextStepAt: Date?

    init(
        credentials: ((ManualClock) -> DeviceCredentials)? = nil,
        cached: CachedDashboard? = nil,
        routes: (ManualClock) -> [String: Handler],
        images: InMemoryImageCache = InMemoryImageCache()
    ) {
        let clock = ManualClock()
        self.clock = clock
        api = FakeAPI(clock: clock, routes: routes(clock))
        store = InMemoryCredentialStore(server: testServer, credentials: credentials?(clock))
        cache = InMemoryDashboardCache(cached)
        client = DeviceClient(
            server: testServer, transport: api, store: store, cache: cache, images: images,
            appVersion: "1.2.3", now: { clock.now })
        nextStepAt = clock.now
    }

    func start() async {
        await client.start()
    }

    func advance(_ seconds: TimeInterval) async {
        let end = clock.now.addingTimeInterval(seconds)
        while let due = nextStepAt, due <= end {
            clock.advance(seconds: due.timeIntervalSince(clock.now))
            if let delay = await client.tick() {
                let wait = Double(delay.components.seconds) + Double(delay.components.attoseconds) / 1e18
                nextStepAt = clock.now.addingTimeInterval(wait)
            } else {
                nextStepAt = nil
            }
        }
        clock.advance(seconds: end.timeIntervalSince(clock.now))
    }

    var state: DeviceState {
        get async { await client.state }
    }
}
