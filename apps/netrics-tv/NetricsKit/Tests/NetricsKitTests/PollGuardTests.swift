import Foundation
import Synchronization
import Testing

@testable import NetricsKit

// Guards around the dashboard poll (#739): a screen kept showing its old
// dashboard after another one was assigned, which did not reproduce. These
// make such a screen correct itself, or at least show that it is stuck.

private let otherDashboardID = "7d2e1f00-0000-4000-8000-00000000b0b0"

/** Dashboard A (Support's `dashboard`), or B: another dashboard id. */
private func dashboardB(_ version: String) -> DeviceDashboard {
    var payload = dashboard(version)
    payload.dashboard = .init(id: otherDashboardID, name: "Operations")
    return payload
}

private func me(dashboardId: String?) -> HTTPResponse {
    jsonObject(
        ["device": ["id": pairingID, "name": "Lobby", "dashboardId": dashboardId as Any? ?? NSNull()]], status: 200)
}

/**
 * A server (or something between it and the TV) that answers 304 to the
 * ETag of dashboard A although B is assigned, and B to a request without
 * one.
 */
private func staleDashboardRoute() -> Handler {
    { call in
        if call.header("if-none-match") == "\"vA\"" {
            return HTTPResponse(status: 304, headers: ["etag": "\"vA\""])
        }
        return json(dashboardB("vB"), headers: ["etag": "\"vB\""])
    }
}

@Suite struct AssignedDashboardTests {
    @Test func theHeartbeatSeeingAnotherDashboardPollsWithoutTheETag() async throws {
        let assigned = Mutex<String?>(nil)
        let h = Harness(
            credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) },
            cached: CachedDashboard(etag: "\"vA\"", payload: .v1(dashboard("vA")), updatedAt: T0)
        ) { _ in
            [
                "GET /v1/device/dashboard": staleDashboardRoute(),
                "POST /v1/device/heartbeat": { _ in HTTPResponse(status: 204) },
                "GET /v1/device/me": { _ in me(dashboardId: assigned.withLock { $0 }) },
            ]
        }
        await h.start()
        await h.advance(0)
        // A as cached, confirmed by a (wrong) 304.
        #expect(await h.state.dashboard?.version == "vA")

        // The heartbeat sees that A is still assigned: nothing changes.
        assigned.withLock { $0 = fixtureDashboardID }
        await h.client.sendHeartbeat()
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/dashboard").last?.header("if-none-match") == "\"vA\"")
        #expect(await h.state.dashboard?.version == "vA")

        // B is assigned: the next poll asks without the ETag and gets B.
        assigned.withLock { $0 = otherDashboardID }
        await h.client.sendHeartbeat()
        await h.advance(60)
        let polls = h.api.callsTo("GET /v1/device/dashboard")
        #expect(polls.last?.header("if-none-match") == nil)
        #expect(await h.state.dashboard?.dashboard?.id == otherDashboardID)
        // Then conditional again, with B's ETag.
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/dashboard").last?.header("if-none-match") == "\"vB\"")
    }

    @Test func noDashboardOnScreenAndNoneAssignedIsNoMismatch() async throws {
        var none = dashboard("v0")
        none.dashboard = nil
        let h = Harness(
            credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) },
            cached: CachedDashboard(etag: "\"v0\"", payload: .v1(none), updatedAt: T0)
        ) { _ in
            [
                "GET /v1/device/dashboard": { _ in HTTPResponse(status: 304, headers: ["etag": "\"v0\""]) },
                "POST /v1/device/heartbeat": { _ in HTTPResponse(status: 204) },
                "GET /v1/device/me": { _ in me(dashboardId: nil) },
            ]
        }
        await h.start()
        await h.advance(0)
        await h.client.sendHeartbeat()
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/dashboard").last?.header("if-none-match") == "\"v0\"")
    }

    @Test func anOlderServerWithoutTheFieldChangesNothing() async throws {
        let h = Harness(
            credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) },
            cached: CachedDashboard(etag: "\"vA\"", payload: .v1(dashboard("vA")), updatedAt: T0)
        ) { _ in
            [
                "GET /v1/device/dashboard": staleDashboardRoute(),
                "POST /v1/device/heartbeat": { _ in HTTPResponse(status: 204) },
                "GET /v1/device/me": { _ in
                    jsonObject(["device": ["id": pairingID, "name": "Lobby"]], status: 200)
                },
            ]
        }
        await h.start()
        await h.advance(0)
        await h.client.sendHeartbeat()
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/dashboard").last?.header("if-none-match") == "\"vA\"")
    }
}

@Suite struct AssignedDashboardRunLoopTests {
    /** In the running client the poll follows the heartbeat at once, not a minute later. */
    @Test func theRunLoopPollsAtOnceAfterTheHeartbeat() async throws {
        let r = RunningClient(
            cached: CachedDashboard(etag: "\"vA\"", payload: .v1(dashboard("vA")), updatedAt: T0)
        ) { _ in
            [
                "GET /v1/device/dashboard": staleDashboardRoute(),
                "GET /v1/device/me": { _ in me(dashboardId: otherDashboardID) },
            ]
        }
        r.run()
        #expect(await eventually { await r.client.state.dashboard?.dashboard?.id == otherDashboardID })
        // The first poll (304 for A), the first heartbeat after 10 s, then at
        // once the poll without the ETag, not the next one a minute later.
        let polls = r.api.callsTo("GET /v1/device/dashboard")
        #expect(polls.count == 2)
        #expect(polls.first?.header("if-none-match") == "\"vA\"")
        #expect(polls.last?.header("if-none-match") == nil)
        #expect(
            Array(r.routes(from: 0).prefix(4)) == [
                "GET /v1/device/dashboard", "POST /v1/device/heartbeat", "GET /v1/device/me",
                "GET /v1/device/dashboard",
            ])
    }
}

@Suite struct PollHealthTests {
    @Test func staleAfterTwiceTheRefreshWithoutAConfirmedPoll() {
        #expect(!PollHealth.isStale(updatedAt: nil, refreshAfterSec: 60, now: T0))
        #expect(!PollHealth.isStale(updatedAt: T0, refreshAfterSec: 60, now: T0.addingTimeInterval(120)))
        #expect(PollHealth.isStale(updatedAt: T0, refreshAfterSec: 60, now: T0.addingTimeInterval(121)))
        // No refreshAfterSec: the default minute.
        #expect(PollHealth.isStale(updatedAt: T0, refreshAfterSec: 0, now: T0.addingTimeInterval(121)))
        #expect(!PollHealth.isStale(updatedAt: T0, refreshAfterSec: 300, now: T0.addingTimeInterval(500)))
    }

    @Test func aStalledScreenShowsTheOfflineMarkerAndNoCountdown() {
        let fresh = T0.addingTimeInterval(30)
        #expect(!PollHealth.showsOffline(offline: false, updatedAt: T0, refreshAfterSec: 60, now: fresh))
        #expect(PollHealth.showsOffline(offline: true, updatedAt: T0, refreshAfterSec: 60, now: fresh))
        let stalled = T0.addingTimeInterval(600)
        #expect(PollHealth.showsOffline(offline: false, updatedAt: T0, refreshAfterSec: 60, now: stalled))
        // The countdown counts from the last confirmed poll and goes away with the marker.
        #expect(
            RefreshCountdown.cycle(updatedAt: T0, offline: false, refreshAfterSec: 60, now: fresh)?.since == T0)
        #expect(RefreshCountdown.cycle(updatedAt: T0, offline: false, refreshAfterSec: 60, now: stalled) == nil)
    }
}

@Suite struct PausedDashboardSwitchTests {
    @Test func aNewDashboardWhilePausedGetsItsFullDurationAfterResume() {
        let a = [SlideRotation.Slide(id: "a1", durationSec: 20), SlideRotation.Slide(id: "a2", durationSec: 20)]
        let b = [SlideRotation.Slide(id: "b1", durationSec: 30), SlideRotation.Slide(id: "b2", durationSec: 30)]
        var rotation = SlideRotation(slides: a, autoAdvance: true, now: T0)
        rotation.togglePause(now: T0.addingTimeInterval(5))
        // B is assigned long after the pause began.
        rotation.update(slides: b, autoAdvance: true, now: T0.addingTimeInterval(100))
        #expect(rotation.currentID == "b1")
        #expect(rotation.isPaused)
        #expect(rotation.progress(at: T0.addingTimeInterval(110)) == 0)
        // Resumed: b1 shows its whole 30 s from now.
        rotation.togglePause(now: T0.addingTimeInterval(130))
        #expect(rotation.nextChange() == T0.addingTimeInterval(160))
    }

    @Test func theSameDashboardWhilePausedKeepsItsPause() {
        let a = [SlideRotation.Slide(id: "a1", durationSec: 20), SlideRotation.Slide(id: "a2", durationSec: 20)]
        var rotation = SlideRotation(slides: a, autoAdvance: true, now: T0)
        rotation.togglePause(now: T0.addingTimeInterval(5))
        rotation.update(slides: a, autoAdvance: true, now: T0.addingTimeInterval(100))
        rotation.togglePause(now: T0.addingTimeInterval(130))
        // 15 s of a1 were left when it paused.
        #expect(rotation.nextChange() == T0.addingTimeInterval(145))
    }
}
