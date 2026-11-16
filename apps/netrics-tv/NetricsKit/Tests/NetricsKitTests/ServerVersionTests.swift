import Foundation
import Testing

@testable import NetricsKit

/** The settings show the server's version (#737), from the server info the client reads anyway. */
@Suite struct ServerVersionTests {
    private func paired(_ routes: @escaping (ManualClock) -> [String: Handler]) -> Harness {
        Harness(credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) }, routes: routes)
    }

    @Test func theServerInfoCheckKeepsTheServerVersion() async {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2, 3]) },
                "GET /v1/device/dashboard": { _ in v3Response() },
            ]
        }
        await h.start()
        #expect(await h.state.serverVersion == nil)
        await h.advance(0)
        #expect(await h.state.serverVersion == "1.0.0")
    }

    @Test func aFailedCheckKeepsTheVersionUnknownAndTheDashboardComes() async {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in HTTPResponse(status: 503) },
                "GET /v1/device/dashboard": { _ in v3Response() },
            ]
        }
        await h.start()
        await h.advance(0)
        let state = await h.state
        #expect(state.serverVersion == nil)
        #expect(state.payload?.schema == 3)
    }
}
