import Foundation
import Testing

@testable import NetricsKit

@Suite struct HostClassifierTests {
    @Test(arguments: [
        "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "127.0.0.1", "169.254.10.1",
        "localhost", "nas.local", "NAS.LOCAL", "nas.local.", "::1", "[::1]", "fd12:3456:789a::1",
        "fc00::1", "fe80::1", "fe80::1%en0", "::ffff:192.168.1.2",
    ])
    func local(_ host: String) {
        #expect(HostClassifier.isLocalNetwork(host))
    }

    @Test(arguments: [
        "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "netrics.example.com",
        "local", "nas.localdomain", "example.local.evil.com", "2001:db8::1", "::ffff:8.8.8.8",
        "10.0.0", "10.0.0.256", "", "fe80::1::2",
    ])
    func publicOrInvalid(_ host: String) {
        #expect(!HostClassifier.isLocalNetwork(host))
    }
}

@Suite struct TransportPolicyTests {
    let off = TransportPolicy()
    let on = TransportPolicy(allowInsecureConnections: true)

    @Test func httpsIsAlwaysAllowed() throws {
        try off.validate(URL(string: "https://netrics.example.com/v1/server")!)
        try off.validate(URL(string: "https://192.168.1.2/v1/server")!)
    }

    @Test func plainHTTPToAPublicHostIsRefusedEvenWithTheSetting() {
        #expect(throws: TransportError.plainHTTPToPublicHost("netrics.example.com")) {
            try on.validate(URL(string: "http://netrics.example.com/v1/server")!)
        }
        #expect(throws: TransportError.plainHTTPToPublicHost("8.8.8.8")) {
            try on.validate(URL(string: "http://8.8.8.8/v1/server")!)
        }
    }

    @Test func plainHTTPToALocalHostNeedsTheSetting() throws {
        #expect(throws: TransportError.plainHTTPNotAllowed("nas.local")) {
            try off.validate(URL(string: "http://nas.local:3000/v1/server")!)
        }
        try on.validate(URL(string: "http://nas.local:3000/v1/server")!)
        try on.validate(URL(string: "http://192.168.1.2/v1/server")!)
        try on.validate(URL(string: "http://[fd00::2]:8080/v1/server")!)
    }

    @Test func otherSchemesAreInvalid() {
        #expect(throws: TransportError.self) { try on.validate(URL(string: "ftp://nas.local/")!) }
    }
}

@Suite struct CertificatePinningTests {
    let pin = "aa" + String(repeating: "0", count: 62)
    let other = "bb" + String(repeating: "0", count: 62)

    @Test func systemTrustWithoutPin() {
        #expect(
            CertificatePinning.decide(
                systemTrusted: true, leafSHA256: pin, pinned: nil, allowSelfSigned: false, pinOnFirstUse: false)
                == .useSystemTrust)
    }

    @Test func selfSignedIsRejectedWithoutTheSetting() {
        #expect(
            CertificatePinning.decide(
                systemTrusted: false, leafSHA256: pin, pinned: nil, allowSelfSigned: false, pinOnFirstUse: true)
                == .rejectUntrusted)
    }

    @Test func selfSignedIsPinnedOnFirstUseOnlyWhileChecking() {
        #expect(
            CertificatePinning.decide(
                systemTrusted: false, leafSHA256: pin.uppercased(), pinned: nil, allowSelfSigned: true,
                pinOnFirstUse: true) == .acceptAndPin(pin))
        #expect(
            CertificatePinning.decide(
                systemTrusted: false, leafSHA256: pin, pinned: nil, allowSelfSigned: true, pinOnFirstUse: false)
                == .rejectUntrusted)
    }

    @Test func pinnedCertificateMustMatch() {
        #expect(
            CertificatePinning.decide(
                systemTrusted: false, leafSHA256: pin, pinned: pin, allowSelfSigned: true, pinOnFirstUse: false)
                == .acceptPinned)
        #expect(
            CertificatePinning.decide(
                systemTrusted: false, leafSHA256: other, pinned: pin, allowSelfSigned: true, pinOnFirstUse: false)
                == .rejectChanged)
        // Even a certificate the system trusts: a change stops the app.
        #expect(
            CertificatePinning.decide(
                systemTrusted: true, leafSHA256: other, pinned: pin, allowSelfSigned: true, pinOnFirstUse: true)
                == .rejectChanged)
    }

    @Test func displayGroupsBytes() {
        #expect(CertificatePinning.display("abcd12") == "AB:CD:12")
    }
}

@Suite struct ServerAddressTests {
    @Test(arguments: [
        ("netrics.example.com", "https://netrics.example.com"),
        ("  https://Netrics.Example.com/  ", "https://netrics.example.com"),
        ("http://nas.local:3000/", "http://nas.local:3000"),
        ("https://example.com/netrics/?x=1#y", "https://example.com/netrics"),
        ("192.168.1.2:8443", "https://192.168.1.2:8443"),
    ])
    func parses(_ input: String, _ expected: String) {
        #expect(ServerAddress.parse(input)?.absoluteString == expected)
    }

    @Test(arguments: ["", "   ", "ftp://example.com", "https://", "not a url", "https://user:pw@example.com"])
    func rejects(_ input: String) {
        #expect(ServerAddress.parse(input) == nil)
    }

    @Test func endpointsKeepAPathPrefix() {
        let config = ServerConfig(baseURL: URL(string: "https://example.com/netrics")!, kind: .custom)
        #expect(config.endpoint("/v1/server").absoluteString == "https://example.com/netrics/v1/server")
    }

    @Test func cloudIsTheDefault() {
        #expect(ServerConfig.cloud.baseURL == NetricsCloud.baseURL)
        #expect(ServerConfig.cloud.baseURL.scheme == "https")
        #expect(ServerConfig.cloud.displayName == "netrics cloud")
    }
}

/** A transport that answers /v1/server with one fixed result. */
struct ServerStub: HTTPTransport {
    let result: @Sendable () throws -> HTTPResponse
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        #expect(request.url.path() == "/v1/server")
        return try result()
    }
}

@Suite struct ServerCheckTests {
    func checker(pin: String? = nil, _ result: @escaping @Sendable () throws -> HTTPResponse) -> ServerChecker {
        ServerChecker(makeTransport: { _, _ in ServerStub(result: result) }, learnedPin: { _ in pin })
    }

    let netrics = ServerInfo(
        product: "netrics", deviceApiVersion: 1, version: "0.6.0",
        pairingUrl: "https://nas.local/devices/approve")

    @Test func acceptsANetricsServer() async throws {
        let info = netrics
        let result = await checker { json(info) }.check(
            address: "netrics.example.com", kind: .custom, allowInsecure: false)
        let checked = try result.get()
        #expect(checked.info == info)
        #expect(checked.config.baseURL.absoluteString == "https://netrics.example.com")
        #expect(checked.config.pinnedCertificateSHA256 == nil)
    }

    @Test func storesACertificatePinnedDuringTheCheck() async throws {
        let info = netrics
        let result = await checker(pin: "abc") { json(info) }.check(
            address: "https://nas.local", kind: .custom, allowInsecure: true)
        #expect(try result.get().config.pinnedCertificateSHA256 == "abc")
        #expect(try result.get().config.policy.allowInsecureConnections)
    }

    @Test func refusesOtherProducts() async {
        let other = #"{"product":"grafana","deviceApiVersion":1,"version":"1","pairingUrl":"https://x.test"}"#
        #expect(
            await checker { HTTPResponse(status: 200, body: Data(other.utf8)) }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.notNetrics))
        #expect(
            await checker { HTTPResponse(status: 200, body: Data("<html>".utf8)) }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.notNetrics))
        #expect(
            await checker { HTTPResponse(status: 404) }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.notNetrics))
    }

    @Test func refusesIncompatibleVersions() async {
        var newer = netrics
        newer.deviceApiVersion = 2
        let info = newer
        let result = await checker { json(info) }.check(address: "x.test", kind: .custom, allowInsecure: false)
        #expect(result == .failure(.incompatibleVersion(server: 2)))
        #expect(ServerCheckError.incompatibleVersion(server: 2).message.contains("Update the app"))
    }

    @Test func reportsUnreachableAndTLSProblems() async {
        #expect(
            await checker { throw TransportError.unreachable("offline") }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.unreachable("offline")))
        #expect(
            await checker { throw TransportError.timedOut }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.timedOut))
        #expect(
            await checker { throw TransportError.untrustedCertificate("self-signed") }
                .check(address: "x.test", kind: .custom, allowInsecure: false)
                == .failure(.untrustedCertificate(settingHelps: true)))
        #expect(
            await checker { throw TransportError.untrustedCertificate("expired") }
                .check(address: "x.test", kind: .custom, allowInsecure: true)
                == .failure(.untrustedCertificate(settingHelps: false)))
    }

    @Test func refusesPlainHTTPBeforeConnecting() async {
        let never = checker { Issue.record("must not connect"); return HTTPResponse(status: 500) }
        #expect(
            await never.check(address: "http://netrics.example.com", kind: .custom, allowInsecure: true)
                == .failure(.plainHTTPToPublicHost("netrics.example.com")))
        #expect(
            await never.check(address: "http://nas.local:3000", kind: .custom, allowInsecure: false)
                == .failure(.plainHTTPNeedsSetting("nas.local")))
        #expect(
            await never.check(address: "", kind: .custom, allowInsecure: false) == .failure(.invalidAddress))
    }

    @Test func allowsPlainHTTPOnTheLocalNetworkWithTheSetting() async throws {
        let info = netrics
        let result = await checker { json(info) }.check(
            address: "http://192.168.1.20:3000", kind: .custom, allowInsecure: true)
        #expect(try result.get().config.baseURL.absoluteString == "http://192.168.1.20:3000")
    }

    @Test func reportsRedirectsAndServerErrors() async {
        #expect(
            await checker { HTTPResponse(status: 301, headers: ["Location": "https://y.test/"]) }
                .check(address: "x.test", kind: .custom, allowInsecure: false)
                == .failure(.redirected("https://y.test/")))
        #expect(
            await checker { HTTPResponse(status: 503) }
                .check(address: "x.test", kind: .custom, allowInsecure: false) == .failure(.serverError(503)))
    }
}
