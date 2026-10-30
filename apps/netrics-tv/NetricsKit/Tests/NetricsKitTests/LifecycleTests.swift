import Foundation
import Synchronization
import Testing

@testable import NetricsKit

// Foreground, background and offline (#415, ADR 0021 section 3). The run
// loop tests drive `run()` on a clock 1000 times faster than real time, so a
// 60 s poll takes 60 ms; the protocol tests use the manual Harness.

/** The client's clock and sleep, 1000 times faster than real time, plus jumps (a night away). */
final class FastClock: Sendable {
    static let speedup = 1000.0
    private let origin = ContinuousClock.now
    private let jumped = Mutex<TimeInterval>(0)

    var now: Date {
        let elapsed = (ContinuousClock.now - origin) / .seconds(1)
        return T0.addingTimeInterval(elapsed * Self.speedup + jumped.withLock { $0 })
    }

    func jump(seconds: TimeInterval) {
        jumped.withLock { $0 += seconds }
    }

    @Sendable func sleep(_ duration: Duration) async throws {
        try await Task.sleep(for: duration / Self.speedup)
    }
}

func credentialsFor(_ name: String, accessExpiresIn: TimeInterval = 3600, at now: Date) -> DeviceCredentials {
    DeviceCredentials(
        accessToken: "access-\(name)",
        accessTokenExpiresAt: ISODate.format(now.addingTimeInterval(accessExpiresIn)),
        refreshToken: "refresh-\(name)",
        refreshTokenExpiresAt: ISODate.format(now.addingTimeInterval(90 * 24 * 3600))
    )
}

/** Polls `condition` in real time until it holds or `timeout` passes. */
func eventually(timeout: Duration = .seconds(5), _ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(2))
    }
    return await condition()
}

private let dashboardRoute = "GET /v1/device/dashboard"
private let heartbeatRoute = "POST /v1/device/heartbeat"
private let tokenRoute = "POST /v1/device/token"

/** A running client (`run()`) on a fast clock with a scripted API. */
final class RunningClient {
    let clock = FastClock()
    let api: FakeAPI
    let store: InMemoryCredentialStore
    let client: DeviceClient
    private var task: Task<Void, Never>?

    init(
        accessExpiresIn: TimeInterval = 24 * 3600, cached: CachedDashboard? = nil, platform: DevicePlatform = .tvos,
        routes: (FastClock) -> [String: Handler]
    ) {
        var all: [String: Handler] = [
            heartbeatRoute: { _ in HTTPResponse(status: 204) },
            "GET /v1/device/me": { _ in
                jsonObject(["device": ["id": pairingID, "name": "Lobby", "dashboardId": NSNull()]], status: 200)
            },
        ]
        all.merge(routes(clock)) { _, new in new }
        api = FakeAPI(clock: ManualClock(), routes: all)
        store = InMemoryCredentialStore(
            server: testServer, credentials: credentialsFor("a", accessExpiresIn: accessExpiresIn, at: clock.now))
        let clock = clock
        client = DeviceClient(
            server: testServer, transport: api, store: store, cache: InMemoryDashboardCache(cached),
            appVersion: "1.2.3", now: { clock.now }, platform: platform, sleep: clock.sleep)
    }

    func run() {
        let client = client
        task = Task { await client.run() }
    }

    deinit {
        task?.cancel()
    }

    func count(_ route: String) -> Int {
        api.callsTo(route).count
    }

    /** The calls from index `start` on, as "METHOD /path", without the server info checks. */
    func routes(from start: Int) -> [String] {
        api.calls[start...].map { "\($0.method) \($0.path)" }.filter { $0 != "GET /v1/server" }
    }
}

/** The dashboard version the scripted server has. */
final class Version: Sendable {
    private let current: Mutex<String>
    init(_ value: String) { current = Mutex(value) }
    var value: String {
        get { current.withLock { $0 } }
        set { current.withLock { $0 = newValue } }
    }
}

/** A dashboard route that answers 304 to the current ETag and 200 with the current version otherwise. */
func versionedDashboard(_ version: @escaping @Sendable () -> String) -> Handler {
    { call in
        let current = version()
        if call.header("if-none-match") == "\"\(current)\"" {
            return HTTPResponse(status: 304, headers: ["etag": "\"\(current)\""])
        }
        return json(dashboard(current), headers: ["etag": "\"\(current)\""])
    }
}

@Suite struct LifecycleRunTests {
    @Test func pollingAndHeartbeatsStopInTheBackgroundAndResumeAtOnce() async throws {
        let version = Version("v1")
        let r = RunningClient { _ in [dashboardRoute: versionedDashboard { version.value }] }
        r.run()
        // A poll at once, the next after 60 s; the first heartbeat after 10 s.
        #expect(await eventually { r.count(dashboardRoute) >= 2 && r.count(heartbeatRoute) >= 1 })

        await r.client.enterBackground()
        #expect(await r.client.isActive == false)
        // A request already in flight may still land.
        try await Task.sleep(for: .milliseconds(30))
        let polls = r.count(dashboardRoute)
        let beats = r.count(heartbeatRoute)
        let before = r.api.calls.count
        // 600 s on the client's clock: ten polls and two heartbeats if it kept going.
        try await Task.sleep(for: .milliseconds(600))
        #expect(r.count(dashboardRoute) == polls)
        #expect(r.count(heartbeatRoute) == beats)
        #expect(await r.client.state.dashboard?.version == "v1")

        await r.client.enterForeground()
        #expect(await r.client.isActive)
        #expect(await eventually { r.count(dashboardRoute) >= polls + 2 })
        // At once: the poll with the ETag, then a heartbeat, then the next poll a minute later.
        let after = r.routes(from: before)
        #expect(Array(after.prefix(2)) == [dashboardRoute, heartbeatRoute])
        let resumed = r.api.callsTo(dashboardRoute)[polls]
        #expect(resumed.header("if-none-match") == "\"v1\"")
    }

    @Test func resumeAfterAnExpiredAccessTokenRefreshesThenPollsThenSendsAHeartbeat() async throws {
        let r = RunningClient(accessExpiresIn: 3600, platform: .ipados) { clock in
            [
                tokenRoute: { _ in
                    json(RefreshDeviceTokenResponse(credentials: credentialsFor("new", at: clock.now)))
                },
                dashboardRoute: { _ in json(dashboard("v1"), headers: ["etag": "\"v1\""]) },
            ]
        }
        r.run()
        #expect(await eventually { r.count(dashboardRoute) >= 1 })
        await r.client.enterBackground()
        try await Task.sleep(for: .milliseconds(30))
        #expect(r.count(tokenRoute) == 0)

        // A night away: the access token expired hours ago.
        r.clock.jump(seconds: 10 * 3600)
        let before = r.api.calls.count
        await r.client.enterForeground()
        #expect(await eventually { r.count(heartbeatRoute) >= 1 && r.routes(from: before).count >= 3 })

        #expect(Array(r.routes(from: before).prefix(3)) == [tokenRoute, dashboardRoute, heartbeatRoute])
        let refresh = try #require(r.api.callsTo(tokenRoute).first)
        #expect(refresh.json()?["refreshToken"] as? String == "refresh-a")
        let poll = try #require(r.api.callsTo(dashboardRoute).last)
        #expect(poll.header("authorization") == "Bearer access-new")
        #expect(poll.header("if-none-match") == "\"v1\"")
        let beat = try #require(r.api.callsTo(heartbeatRoute).last)
        #expect(beat.header("authorization") == "Bearer access-new")
        #expect(beat.json()?["appVersion"] as? String == "ipados 1.2.3")
        #expect(beat.json()?["platform"] as? String == "ipados")
        #expect(r.store.snapshot.credentials?.refreshToken == "refresh-new")
        #expect(await r.client.state.phase == .paired)
    }

    @Test func afterALongBackgroundTheLastDashboardStaysThenTheFreshOneComesWithinOnePoll() async throws {
        let version = Version("v1")
        let r = RunningClient { _ in [dashboardRoute: versionedDashboard { version.value }] }
        r.run()
        #expect(await eventually { await r.client.state.dashboard?.version == "v1" })
        await r.client.enterBackground()
        try await Task.sleep(for: .milliseconds(30))

        version.value = "v2"
        r.clock.jump(seconds: 10 * 3600)
        let polls = r.count(dashboardRoute)
        // Still on screen after the night, not offline.
        var state = await r.client.state
        #expect(state.dashboard?.version == "v1")
        #expect(!state.offline)

        await r.client.enterForeground()
        #expect(await eventually { await r.client.state.dashboard?.version == "v2" })
        #expect(r.count(dashboardRoute) <= polls + 2)
        #expect(r.api.callsTo(dashboardRoute)[polls].header("if-none-match") == "\"v1\"")
        state = await r.client.state
        #expect(!state.offline)
    }

    @Test func foregroundTwiceAndBackgroundTwiceAreNoOps() async {
        let r = RunningClient { _ in [dashboardRoute: { _ in json(dashboard("v1")) }] }
        await r.client.enterForeground()
        #expect(await r.client.isActive)
        await r.client.enterBackground()
        await r.client.enterBackground()
        #expect(await r.client.isActive == false)
    }

    @Test func unpairingInTheBackgroundEndsTheRunLoop() async throws {
        let r = RunningClient { _ in [dashboardRoute: { _ in json(dashboard("v1")) }] }
        let client = r.client
        let run = Task {
            await client.run()
            return true
        }
        #expect(await eventually { r.count(dashboardRoute) >= 1 })
        await client.enterBackground()
        await client.unpair()
        // Both loops wake and end, so `run()` returns.
        #expect(try await withTimeout(run) == true)
    }
}

/** The task's value, or nil after a second. */
private func withTimeout(_ task: Task<Bool, Never>) async throws -> Bool? {
    try await withThrowingTaskGroup(of: Bool?.self) { group in
        group.addTask { await task.value }
        group.addTask {
            try await Task.sleep(for: .seconds(1))
            return nil
        }
        let first = try await group.next() ?? nil
        group.cancelAll()
        return first
    }
}

@Suite struct LifecycleProtocolTests {
    @Test func aStartAfterTheNightShowsTheCacheBeforeAnyRequestThenTheFreshDashboard() async throws {
        let version = Version("v2")
        let cachedAt = T0.addingTimeInterval(-10 * 3600)
        let h = Harness(
            // The access token expired in the night.
            credentials: { credentialsFor("a", accessExpiresIn: -9 * 3600, clock: $0) },
            cached: CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: cachedAt)
        ) { clock in
            [
                tokenRoute: { _ in
                    json(RefreshDeviceTokenResponse(credentials: credentialsFor("new", clock: clock)))
                },
                dashboardRoute: versionedDashboard { version.value },
            ]
        }
        await h.start()
        var state = await h.state
        #expect(state.phase == .paired)
        #expect(state.dashboard?.version == "v1")
        #expect(state.updatedAt == cachedAt)
        #expect(h.api.calls.isEmpty)

        await h.advance(0)
        #expect(h.api.callsTo(tokenRoute).count == 1)
        let poll = try #require(h.api.callsTo(dashboardRoute).first)
        #expect(poll.header("authorization") == "Bearer access-new")
        #expect(poll.header("if-none-match") == "\"v1\"")
        state = await h.state
        #expect(state.dashboard?.version == "v2")
        #expect(state.updatedAt == T0)
        #expect(!state.offline)
    }

    @Test func anAirplaneModeStartShowsTheCacheOfflineAndBacksOffUntilTheNetworkReturns() async throws {
        let online = Mutex(false)
        let cachedAt = T0.addingTimeInterval(-3600)
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) },
            cached: CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: cachedAt)
        ) { _ in
            [
                dashboardRoute: { call in
                    guard online.withLock({ $0 }) else {
                        throw TransportError.unreachable("The Internet connection appears to be offline.")
                    }
                    return call.header("if-none-match") == "\"v1\""
                        ? HTTPResponse(status: 304, headers: ["etag": "\"v1\""])
                        : json(dashboard("v1"), headers: ["etag": "\"v1\""])
                }
            ]
        }
        await h.start()
        await h.advance(0)
        var state = await h.state
        #expect(state.dashboard?.version == "v1")
        #expect(state.offline)
        // The header reads "Offline — last update" with the cached time.
        #expect(
            TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: "Europe/Berlin")
                == "Offline — last update 11:00")

        await h.advance(5 + 10)
        #expect(h.api.callsTo(dashboardRoute).map(\.at) == [0, 5, 15])
        online.withLock { $0 = true }
        await h.advance(20)
        state = await h.state
        #expect(!state.offline)
        #expect(state.dashboard?.version == "v1")
        #expect(state.updatedAt == T0.addingTimeInterval(35))
    }

    @Test func aDeviceUnusedForMoreThan90DaysShowsANewCode() async throws {
        let h = Harness(
            // Last opened 91 days ago: both tokens expired since.
            credentials: { credentialsFor("a", accessExpiresIn: -91 * 24 * 3600 + 3600, clock: $0) },
            cached: CachedDashboard(
                etag: "\"v1\"", payload: dashboard("v1"), updatedAt: T0.addingTimeInterval(-91 * 24 * 3600))
        ) { clock in
            [
                // The refresh token expired: the server refuses it.
                tokenRoute: { _ in jsonObject(["error": "unauthorized"], status: 401) },
                "POST /v1/device/pairings": { _ in pairingResponse("NEWC-ODE1", clock: clock) },
            ]
        }
        h.store.saveDevice(DeviceSummary(id: pairingID, name: "Lobby"))
        await h.start()
        // The last dashboard first, as after any start.
        #expect(await h.state.dashboard?.version == "v1")

        await h.advance(0)
        let state = await h.state
        #expect(state.phase == .pairing)
        #expect(state.pairing?.code == "NEWC-ODE1")
        #expect(state.payload == nil)
        #expect(h.api.callsTo(dashboardRoute).isEmpty)
        #expect(h.store.snapshot.credentials == nil)
        #expect(h.store.snapshot.device == nil)
        #expect(h.store.snapshot.server == testServer)
        #expect(h.cache.load() == nil)
    }
}

// Pull to refresh (#413): `refreshNow()` ends the poll loop's wait for one
// poll and returns once it is answered; the heartbeat keeps its schedule.

/** A dashboard route like `versionedDashboard` whose answer asks for the next poll in an hour. */
private func hourlyDashboard(_ version: @escaping @Sendable () -> String) -> Handler {
    { call in
        let current = version()
        if call.header("if-none-match") == "\"\(current)\"" {
            return HTTPResponse(status: 304, headers: ["etag": "\"\(current)\""])
        }
        var body = dashboard(current)
        body.refreshAfterSec = 3600
        return json(body, headers: ["etag": "\"\(current)\""])
    }
}

@Suite struct RefreshNowTests {
    @Test func pollsAtOnceAndReturnsWithTheAnswer() async throws {
        let version = Version("v1")
        let r = RunningClient { _ in [dashboardRoute: hourlyDashboard { version.value }] }
        r.run()
        #expect(await eventually { r.count(dashboardRoute) == 1 && r.count(heartbeatRoute) >= 1 })
        // The next poll is an hour away (3.6 s here); a refresh does not wait for it.
        version.value = "v2"
        let started = ContinuousClock.now
        await r.client.refreshNow()
        #expect(ContinuousClock.now - started < .seconds(2))
        #expect(r.count(dashboardRoute) == 2)
        #expect(r.api.callsTo(dashboardRoute)[1].header("if-none-match") == "\"v1\"")
        #expect(await r.client.state.dashboard?.version == "v2")
        // Again: one more poll each time, a 304 now.
        let beats = r.count(heartbeatRoute)
        await r.client.refreshNow()
        #expect(r.count(dashboardRoute) == 3)
        #expect(r.count(heartbeatRoute) == beats)
        #expect(await r.client.state.dashboard?.version == "v2")
    }

    @Test func returnsAtOnceInTheBackgroundAndWithoutTheRunLoop() async throws {
        let r = RunningClient { _ in [dashboardRoute: hourlyDashboard { "v1" }] }
        // Not running: nothing to wake.
        await r.client.refreshNow()
        #expect(r.count(dashboardRoute) == 0)
        r.run()
        #expect(await eventually { r.count(dashboardRoute) == 1 })
        await r.client.enterBackground()
        await r.client.refreshNow()
        try await Task.sleep(for: .milliseconds(30))
        #expect(r.count(dashboardRoute) == 1)
    }
}
