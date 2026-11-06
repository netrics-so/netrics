import Foundation
import NetricsKit
import Synchronization
import Testing

@testable import NetricsUI

// "Try a demo" (#416): the bundled payloads decode as schema 3 with every
// widget known to this build, and the demo sends nothing and stores
// nothing. packages/contracts/src/tv-demo-payload.test.ts checks the same
// files against the zod contract.

@MainActor
@Suite struct DemoDashboardTests {
    @Test(arguments: ScreenLanguage.allCases)
    func bundledPayloadDecodesAsSchema3(_ language: ScreenLanguage) throws {
        let url = try #require(DemoDashboard.url(language))
        // The file itself, as bundled: schema 3.
        let raw = try JSONDecoder().decode(DashboardPayload.self, from: Data(contentsOf: url))
        guard case .v2(let bundled) = raw else {
            Issue.record("not a schema 2 or 3 payload")
            return
        }
        #expect(bundled.schema == 3)
        #expect(bundled.language == language)

        let payload = try #require(try DemoDashboard.state(language: language).dashboardV2)
        #expect(payload.dashboard != nil)
        #expect(payload.slides.count == 2)
        #expect(payload.images.isEmpty)
        let widgets = payload.slides.flatMap(\.widgets)
        #expect(!widgets.contains { $0.content == .unsupported })
        #expect(Set(widgets.map(\.type)).count >= 8)
        #expect(payload.timeZone == TimeZone.current.identifier)
    }

    @Test func demoIsNotStaleToday() throws {
        let state = try DemoDashboard.state(language: .en, now: Date())
        let widgets = try #require(state.dashboardV2).slides.flatMap(\.widgets)
        for widget in widgets {
            if case .metric(_, let data) = widget.content {
                let updated = try #require(data.updatedAt.flatMap(ISODate.parse))
                #expect(abs(updated.timeIntervalSinceNow) < 15 * 60)
            }
        }
        // No refresh countdown: nothing refreshes.
        #expect(state.updatedAt == nil)
        #expect(state.phase == .paired)
    }

    @Test func demoSendsNothingStoresNothingAndReturnsToTheCloudCheck() async throws {
        let requests = Counter()
        let offline = ServerChecker(makeTransport: { _, _ in CountingOffline(requests: requests) })
        let store = InMemoryCredentialStore()
        let session = DeviceSession(platform: .ios, appGroup: nil, store: store, checker: offline)
        session.launch()
        #expect(session.route == .connectingCloud)
        #expect(session.canTryDemo)
        try await waitUntil { requests.value >= 1 }

        session.startDemo()
        #expect(session.demo != nil)
        #expect(!session.canTryDemo)
        #expect(session.route == .connectingCloud)
        let sent = requests.value
        try await Task.sleep(for: .milliseconds(200))
        #expect(requests.value == sent)
        #expect(store.snapshot.server == nil && store.snapshot.credentials == nil && store.snapshot.device == nil)

        // Back from the background in the demo: still nothing is sent.
        session.enterBackground()
        session.enterForeground()
        try await Task.sleep(for: .milliseconds(200))
        #expect(requests.value == sent)

        session.leaveDemo()
        #expect(session.demo == nil)
        #expect(session.route == .connectingCloud)
        // The cloud is checked again at once, not after the retry interval.
        try await waitUntil { requests.value > sent }
        #expect(store.snapshot.server == nil && store.snapshot.credentials == nil && store.snapshot.device == nil)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(condition())
    }
}

private final class Counter: Sendable {
    private let count = Mutex(0)
    var value: Int { count.withLock { $0 } }
    func add() { count.withLock { $0 += 1 } }
}

/** No network: every request fails, and is counted. */
private struct CountingOffline: HTTPTransport {
    let requests: Counter

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.add()
        throw URLError(.notConnectedToInternet)
    }
}
