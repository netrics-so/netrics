import Foundation
import Synchronization
import Testing

@testable import NetricsKit

// The same cases as apps/web/src/lib/kiosk-client.test.ts, plus what only
// the TV has (certificate block, unpair, concurrent refresh).

@Suite struct BackoffTests {
    @Test func doublesFrom5sUpTo60s() {
        let seconds = [1, 2, 3, 4, 5, 9].map { DeviceClient.backoff(failures: $0).components.seconds }
        #expect(seconds == [5, 10, 20, 40, 60, 60])
    }
}

@Suite struct PairingTests {
    @Test func showsCodePollsUntilApprovedAndStoresCredentials() async throws {
        let approved = Mutex(false)
        let issued = Mutex<DeviceCredentials?>(nil)
        let h = Harness { clock in
            [
                "POST /v1/device/pairings": { _ in pairingResponse(clock: clock) },
                "POST /v1/device/pairings/poll": { _ in
                    if approved.withLock({ $0 }) {
                        let credentials = credentialsFor("paired", clock: clock)
                        issued.withLock { $0 = credentials }
                        return json(
                            PollPairingResponse.approved(
                                device: DeviceSummary(id: pairingID, name: "Lobby"), credentials: credentials))
                    }
                    return json(PollPairingResponse.pending(expiresAt: ISODate.format(clock.now)))
                },
                "GET /v1/device/dashboard": { _ in json(dashboard("v1"), headers: ["ETag": "\"v1\""]) },
            ]
        }
        await h.start()
        await h.advance(0)
        var state = await h.state
        #expect(state.phase == .pairing)
        #expect(state.pairing?.code == "ABCD-EFGH")
        #expect(state.pairing?.pairingUrl == "https://kiosk.test/devices/approve")
        #expect(state.pairing?.approveUrl == "https://kiosk.test/devices/approve?code=ABCD-EFGH")

        await h.advance(5)
        let polls = h.api.callsTo("POST /v1/device/pairings/poll")
        #expect(polls.count == 1)
        #expect(polls[0].json()?["pairingId"] as? String == pairingID)
        #expect(polls[0].json()?["pollSecret"] as? String == pollSecret)
        #expect(await h.state.phase == .pairing)

        approved.withLock { $0 = true }
        await h.advance(5)
        #expect(h.store.snapshot.credentials == issued.withLock { $0 })
        #expect(h.store.snapshot.device == DeviceSummary(id: pairingID, name: "Lobby"))
        state = await h.state
        #expect(state.phase == .paired)
        #expect(state.device?.name == "Lobby")
        #expect(state.dashboard?.version == "v1")
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.header("authorization") == "Bearer access-paired")
    }

    @Test func startsNewPairingWhenCodeIsGone() async {
        let codes = Mutex(0)
        let h = Harness { clock in
            [
                "POST /v1/device/pairings": { _ in
                    let n = codes.withLock { $0 += 1; return $0 }
                    return pairingResponse("CODE-000\(n)", clock: clock)
                },
                "POST /v1/device/pairings/poll": { _ in
                    jsonObject(["error": "pairing_expired"], status: 410)
                },
            ]
        }
        await h.start()
        await h.advance(0)
        #expect(await h.state.pairing?.code == "CODE-0001")
        await h.advance(5)
        #expect(await h.state.pairing?.code == "CODE-0002")
    }

    @Test func startsNewPairingWhenCodeExpires() async {
        let codes = Mutex(0)
        let h = Harness { clock in
            [
                "POST /v1/device/pairings": { _ in
                    let n = codes.withLock { $0 += 1; return $0 }
                    return pairingResponse("CODE-000\(n)", clock: clock)
                },
                "POST /v1/device/pairings/poll": { _ in
                    json(PollPairingResponse.pending(expiresAt: ISODate.format(clock.now)))
                },
            ]
        }
        await h.start()
        await h.advance(0)
        #expect(await h.state.pairing?.code == "CODE-0001")
        await h.advance(600)
        #expect(await h.state.pairing?.code == "CODE-0002")
    }

    @Test func retriesWithBackoffWhileAPIUnreachable() async {
        let up = Mutex(false)
        let h = Harness { clock in
            [
                "POST /v1/device/pairings": { _ in
                    guard up.withLock({ $0 }) else { throw TransportError.unreachable("fetch failed") }
                    return pairingResponse(clock: clock)
                }
            ]
        }
        await h.start()
        await h.advance(0)
        var state = await h.state
        #expect(state.offline)
        #expect(state.pairing == nil)

        await h.advance(5)
        #expect(h.api.callsTo("POST /v1/device/pairings").count == 2)
        up.withLock { $0 = true }
        await h.advance(10)
        state = await h.state
        #expect(!state.offline)
        #expect(state.pairing?.code == "ABCD-EFGH")
    }
}

@Suite struct DashboardLoopTests {
    @Test func sendsETagAndKeepsPayloadOn304() async throws {
        let h = Harness(credentials: { credentialsFor("a", clock: $0) }) { _ in
            [
                "GET /v1/device/dashboard": { call in
                    call.header("if-none-match") == "\"v1\""
                        ? HTTPResponse(status: 304, headers: ["etag": "\"v1\""])
                        : json(dashboard("v1"), headers: ["etag": "\"v1\""])
                }
            ]
        }
        await h.start()
        await h.advance(0)
        let first = await h.state.dashboard
        #expect(first?.version == "v1")
        #expect(await h.state.updatedAt == T0)

        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests.count == 2)
        #expect(requests[1].header("if-none-match") == "\"v1\"")
        let state = await h.state
        #expect(state.dashboard == first)
        #expect(state.updatedAt == T0.addingTimeInterval(60))
        #expect(!state.offline)
        #expect(h.cache.load()?.updatedAt == T0.addingTimeInterval(60))
        #expect(h.cache.load()?.etag == "\"v1\"")
    }

    @Test func refreshesBeforeExpiryAndPersistsNewPairFirst() async throws {
        let storedWhenUsed = Mutex<DeviceCredentials?>(nil)
        let rotated = Mutex<DeviceCredentials?>(nil)
        let storeBox = Mutex<InMemoryCredentialStore?>(nil)
        let h = Harness(credentials: { credentialsFor("old", accessExpiresIn: 60, clock: $0) }) { clock in
            [
                "POST /v1/device/token": { _ in
                    let next = credentialsFor("new", clock: clock)
                    rotated.withLock { $0 = next }
                    return json(RefreshDeviceTokenResponse(credentials: next))
                },
                "GET /v1/device/dashboard": { _ in
                    storedWhenUsed.withLock { $0 = storeBox.withLock { $0 }?.loadCredentials() }
                    return json(dashboard("v1"))
                },
            ]
        }
        storeBox.withLock { $0 = h.store }
        await h.start()
        await h.advance(0)

        let refreshes = h.api.callsTo("POST /v1/device/token")
        #expect(refreshes.count == 1)
        #expect(refreshes[0].json()?["refreshToken"] as? String == "refresh-old")
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.header("authorization") == "Bearer access-new")
        #expect(storedWhenUsed.withLock { $0 } == rotated.withLock { $0 })
        #expect(await h.state.phase == .paired)
    }

    @Test func adoptsPairRotatedElsewhereInsteadOfRefreshing() async throws {
        let h = Harness(credentials: { credentialsFor("old", accessExpiresIn: 5 * 60, clock: $0) }) { clock in
            [
                "POST /v1/device/token": { _ in
                    json(RefreshDeviceTokenResponse(credentials: credentialsFor("x", clock: clock)))
                },
                "GET /v1/device/dashboard": { _ in json(dashboard("v1")) },
            ]
        }
        await h.start()
        await h.advance(0)
        h.store.saveCredentials(credentialsFor("other", clock: h.clock))

        await h.advance(4 * 60)
        #expect(h.api.callsTo("POST /v1/device/token").isEmpty)
        let last = try #require(h.api.callsTo("GET /v1/device/dashboard").last)
        #expect(last.header("authorization") == "Bearer access-other")
    }

    @Test func refreshesOnceOn401AndRetries() async {
        let h = Harness(credentials: { credentialsFor("old", clock: $0) }) { clock in
            [
                "POST /v1/device/token": { _ in
                    json(RefreshDeviceTokenResponse(credentials: credentialsFor("new", clock: clock)))
                },
                "GET /v1/device/dashboard": { call in
                    call.header("authorization") == "Bearer access-new"
                        ? json(dashboard("v1"))
                        : jsonObject(["error": "unauthorized"], status: 401)
                },
            ]
        }
        await h.start()
        await h.advance(0)
        #expect(h.api.callsTo("POST /v1/device/token").count == 1)
        #expect(h.api.callsTo("GET /v1/device/dashboard").count == 2)
        #expect(await h.state.dashboard?.version == "v1")
    }

    @Test func pairsAgainWhenFreshTokenIsRefused() async {
        let h = Harness(credentials: { credentialsFor("old", clock: $0) }) { clock in
            [
                "POST /v1/device/token": { _ in
                    json(RefreshDeviceTokenResponse(credentials: credentialsFor("new", clock: clock)))
                },
                "GET /v1/device/dashboard": { _ in jsonObject(["error": "unauthorized"], status: 401) },
                "POST /v1/device/pairings": { _ in pairingResponse(clock: clock) },
            ]
        }
        await h.start()
        await h.advance(0)
        #expect(h.api.callsTo("GET /v1/device/dashboard").count == 2)
        #expect(await h.state.phase == .pairing)
        #expect(h.store.snapshot.credentials == nil)
    }

    @Test func clearsCredentialsAndPairsAgainWhenRefreshIsRefused() async {
        let h = Harness(
            credentials: { credentialsFor("revoked", accessExpiresIn: 30, clock: $0) },
            cached: CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: T0.addingTimeInterval(-60))
        ) { clock in
            [
                "POST /v1/device/token": { _ in jsonObject(["error": "unauthorized"], status: 401) },
                "POST /v1/device/pairings": { _ in pairingResponse(clock: clock) },
            ]
        }
        h.store.saveDevice(DeviceSummary(id: pairingID, name: "Lobby"))
        await h.start()
        await h.advance(0)

        #expect(h.store.snapshot.credentials == nil)
        #expect(h.store.snapshot.device == nil)
        // The server stays: it changes only by unpairing.
        #expect(h.store.snapshot.server == testServer)
        #expect(h.cache.load() == nil)
        #expect(h.api.callsTo("GET /v1/device/dashboard").isEmpty)
        let state = await h.state
        #expect(state.phase == .pairing)
        #expect(state.dashboard == nil)
        #expect(state.pairing?.code == "ABCD-EFGH")
    }

    @Test func keepsLastDashboardThroughOutageBacksOffAndRecovers() async {
        enum Mode { case up, down, error }
        let mode = Mutex(Mode.up)
        let h = Harness(credentials: { credentialsFor("a", accessExpiresIn: 24 * 3600, clock: $0) }) { _ in
            [
                "GET /v1/device/dashboard": { _ in
                    switch mode.withLock({ $0 }) {
                    case .down: throw TransportError.unreachable("fetch failed")
                    case .error: return jsonObject(["error": "api_unreachable"], status: 502)
                    case .up: return json(dashboard("v2", value: 50), headers: ["etag": "\"v2\""])
                    }
                }
            ]
        }
        let updates = h.client.updates
        let seen = Task { await updates.first { _ in true } }
        await h.start()
        await h.advance(0)
        let before = await h.state.dashboard
        #expect(before?.version == "v2")

        mode.withLock { $0 = .down }
        await h.advance(60)
        var state = await h.state
        #expect(state.offline)
        #expect(state.dashboard == before)
        #expect(state.updatedAt == T0)
        #expect(state.lastError?.contains("fetch failed") == true)

        mode.withLock { $0 = .error }
        await h.advance(5 + 10 + 20)
        // 60 s (down), then 5 s, 10 s and 20 s later (502s).
        #expect(h.api.callsTo("GET /v1/device/dashboard").map(\.at) == [0, 60, 65, 75, 95])
        state = await h.state
        #expect(state.offline)
        #expect(state.dashboard == before)
        #expect(state.lastError == "HTTP 502")

        mode.withLock { $0 = .up }
        await h.advance(40)
        state = await h.state
        #expect(!state.offline)
        #expect(state.lastError == nil)
        #expect(state.updatedAt == T0.addingTimeInterval(135))
        #expect(await seen.value != nil)
    }

    @Test func showsCachedDashboardOnOfflineStart() async throws {
        let cachedAt = T0.addingTimeInterval(-5 * 60)
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) },
            cached: CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: cachedAt)
        ) { _ in [:] }
        await h.start()
        #expect(await h.state.dashboard?.version == "v1")

        await h.advance(0)
        let state = await h.state
        #expect(state.phase == .paired)
        #expect(state.offline)
        #expect(state.dashboard?.version == "v1")
        #expect(state.updatedAt == cachedAt)
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.header("if-none-match") == "\"v1\"")
    }

    @Test func sendsHeartbeatsWithVersionUptimeAndLastError() async throws {
        let h = Harness(credentials: { credentialsFor("a", accessExpiresIn: 24 * 3600, clock: $0) }) { _ in
            [
                "GET /v1/device/dashboard": { _ in jsonObject(["error": "internal"], status: 500) },
                "POST /v1/device/heartbeat": { _ in HTTPResponse(status: 204) },
                "GET /v1/device/me": { _ in
                    jsonObject(["device": ["id": pairingID, "name": "Renamed", "dashboardId": NSNull()]], status: 200)
                },
            ]
        }
        await h.start()
        await h.advance(10)
        #expect(await h.client.sendHeartbeat())
        let first = try #require(h.api.callsTo("POST /v1/device/heartbeat").first)
        #expect(first.header("authorization") == "Bearer access-a")
        let body = try #require(first.json())
        #expect(body["appVersion"] as? String == "1.2.3")
        #expect(body["uptimeSeconds"] as? Int == 10)
        #expect(body["lastError"] as? String == "HTTP 500")
        // A rename in the web app reaches the settings screen.
        #expect(await h.state.device?.name == "Renamed")
        #expect(h.store.snapshot.device?.name == "Renamed")
    }

    @Test func noHeartbeatWhilePairing() async {
        let h = Harness { clock in ["POST /v1/device/pairings": { _ in pairingResponse(clock: clock) }] }
        await h.start()
        await h.advance(0)
        #expect(await h.client.sendHeartbeat() == false)
        #expect(h.api.callsTo("POST /v1/device/heartbeat").isEmpty)
    }
}

@Suite struct CredentialRotationTests {
    @Test func concurrentRefreshesShareOneRequest() async throws {
        let h = Harness(credentials: { credentialsFor("old", accessExpiresIn: 30, clock: $0) }) { clock in
            [
                "POST /v1/device/token": { _ in
                    try await Task.sleep(for: .milliseconds(50))
                    return json(RefreshDeviceTokenResponse(credentials: credentialsFor("new", clock: clock)))
                }
            ]
        }
        await h.start()
        let client = h.client
        async let a = client.refresh()
        async let b = client.refresh()
        async let c = client.refresh()
        let outcomes = try await [a, b, c]
        #expect(outcomes == [.ok, .ok, .ok])
        #expect(h.api.callsTo("POST /v1/device/token").count == 1)
        #expect(h.store.snapshot.credentials?.refreshToken == "refresh-new")
    }

    @Test func aFailedRefreshKeepsTheOldPairAndBacksOff() async {
        let h = Harness(credentials: { credentialsFor("old", accessExpiresIn: 30, clock: $0) }) { _ in
            ["POST /v1/device/token": { _ in jsonObject(["error": "internal"], status: 500) }]
        }
        await h.start()
        await h.advance(0)
        let state = await h.state
        #expect(state.phase == .paired)
        #expect(state.offline)
        #expect(h.store.snapshot.credentials?.refreshToken == "refresh-old")
        #expect(h.api.callsTo("GET /v1/device/dashboard").isEmpty)
    }
}

@Suite struct TVOnlyTests {
    @Test func aChangedCertificateBlocksTheClient() async {
        let h = Harness(credentials: { credentialsFor("a", clock: $0) }) { _ in
            ["GET /v1/device/dashboard": { _ in throw TransportError.certificateChanged }]
        }
        await h.start()
        await h.advance(0)
        guard case .blocked = await h.state.phase else {
            Issue.record("expected blocked")
            return
        }
        await h.advance(600)
        #expect(h.api.callsTo("GET /v1/device/dashboard").count == 1)
        // Credentials stay until the user unpairs.
        #expect(h.store.snapshot.credentials != nil)
    }

    @Test func unpairClearsKeychainAndCache() async {
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) },
            cached: CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: T0)
        ) { _ in ["GET /v1/device/dashboard": { _ in json(dashboard("v1")) }] }
        await h.start()
        await h.advance(0)
        await h.client.unpair()
        #expect(h.store.snapshot == InMemoryCredentialStore.Contents())
        #expect(h.cache.load() == nil)
        #expect(await h.state.phase == .unpaired)
        #expect(await h.client.tick() == nil)
    }

    @Test func plainHTTPToAPublicHostIsNeverSent() async {
        let clock = ManualClock()
        let api = FakeAPI(clock: clock, routes: [:])
        let server = ServerConfig(
            baseURL: URL(string: "http://netrics.example.com")!, kind: .custom,
            policy: TransportPolicy(allowInsecureConnections: true))
        let client = DeviceClient(
            server: server, transport: api, store: InMemoryCredentialStore(), cache: InMemoryDashboardCache(),
            appVersion: "1", now: { clock.now })
        await client.start()
        _ = await client.tick()
        #expect(api.calls.isEmpty)
        #expect(await client.state.lastError?.contains("not allowed") == true)
    }
}
