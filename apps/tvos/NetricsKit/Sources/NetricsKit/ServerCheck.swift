import Foundation

/** Why a server cannot be used; `message` is shown on the server screen. */
public enum ServerCheckError: Error, Sendable, Equatable {
    case invalidAddress
    case plainHTTPToPublicHost(String)
    case plainHTTPNeedsSetting(String)
    case unreachable(String)
    case timedOut
    /** settingHelps: the insecure setting is off and would allow pinning it. */
    case untrustedCertificate(settingHelps: Bool)
    case certificateChanged
    case redirected(String?)
    case notNetrics
    case incompatibleVersion(server: Int)
    case serverError(Int)

    public var message: String {
        switch self {
        case .invalidAddress:
            return "Enter the address of your netrics server, for example netrics.example.com."
        case .plainHTTPToPublicHost(let host):
            return "\(host) is not on your local network, so it needs HTTPS. Plain HTTP is only possible for local servers."
        case .plainHTTPNeedsSetting(let host):
            return "\(host) uses plain HTTP. Use HTTPS, or turn on “Allow insecure connections” (not recommended)."
        case .unreachable(let detail):
            return "Cannot reach this server. Check the address and the network. (\(detail))"
        case .timedOut:
            return "The server did not answer in time. Check the address and the network."
        case .untrustedCertificate(let settingHelps):
            return settingHelps
                ? "The server's certificate is not trusted. If it is your own server with a self-signed certificate, turn on “Allow insecure connections” (not recommended)."
                : "The server's certificate is not trusted."
        case .certificateChanged:
            return "The server's certificate has changed since it was trusted."
        case .redirected(let location):
            return "The server redirected to \(location ?? "another address"). Enter that address instead."
        case .notNetrics:
            return "This address does not answer like a netrics server."
        case .incompatibleVersion(let server):
            return server > (supportedDeviceAPIVersions.max() ?? 0)
                ? "This server is newer than this app (device API \(server)). Update the app."
                : "This server is too old for this app (device API \(server)). Update the server."
        case .serverError(let status):
            return "The server answered with an error (HTTP \(status)). Try again later."
        }
    }
}

public struct ServerCheckResult: Sendable, Equatable {
    public var config: ServerConfig
    public var info: ServerInfo
}

public typealias TransportFactory = @Sendable (ServerConfig, _ pinOnFirstUse: Bool) -> any HTTPTransport

/**
 * Checks a server before pairing (ADR 0010): GET /v1/server must say
 * product "netrics" and a device API version this app supports.
 */
public struct ServerChecker: Sendable {
    let makeTransport: TransportFactory
    /** The pin a transport learned while checking (self-signed, setting on). */
    let learnedPin: @Sendable (any HTTPTransport) -> String?

    public init(
        makeTransport: @escaping TransportFactory,
        learnedPin: @escaping @Sendable (any HTTPTransport) -> String? = { _ in nil }
    ) {
        self.makeTransport = makeTransport
        self.learnedPin = learnedPin
    }

    /** The URLSession transport; pins are learned only during this check. */
    public static let live = ServerChecker(
        makeTransport: { config, pinOnFirstUse in
            URLSessionTransport(
                policy: config.policy,
                trust: CertificateTrust(
                    pinned: config.pinnedCertificateSHA256,
                    allowSelfSigned: config.policy.allowInsecureConnections,
                    pinOnFirstUse: pinOnFirstUse
                )
            )
        },
        learnedPin: { transport in (transport as? URLSessionTransport)?.trust.pinned }
    )

    public func check(address: String, kind: ServerKind, allowInsecure: Bool) async -> Result<
        ServerCheckResult, ServerCheckError
    > {
        guard let url = ServerAddress.parse(address) else {
            return .failure(.invalidAddress)
        }
        let config = ServerConfig(
            baseURL: url, kind: kind, policy: TransportPolicy(allowInsecureConnections: allowInsecure))
        return await check(config)
    }

    public func check(_ config: ServerConfig) async -> Result<ServerCheckResult, ServerCheckError> {
        let url = config.endpoint("/v1/server")
        do {
            try config.policy.validate(url)
        } catch {
            return .failure(Self.map(error, allowInsecure: config.policy.allowInsecureConnections))
        }
        let transport = makeTransport(config, true)
        let response: HTTPResponse
        do {
            response = try await transport.send(
                HTTPRequest(url: url, headers: ["accept": "application/json"]))
        } catch let error as TransportError {
            return .failure(Self.map(error, allowInsecure: config.policy.allowInsecureConnections))
        } catch {
            return .failure(.unreachable(error.localizedDescription))
        }
        if (300..<400).contains(response.status) {
            return .failure(.redirected(response.header("location")))
        }
        if response.status == 404 {
            return .failure(.notNetrics)
        }
        guard response.isSuccess else {
            return .failure(response.status >= 500 ? .serverError(response.status) : .notNetrics)
        }
        guard let info = try? JSONDecoder().decode(ServerInfo.self, from: response.body),
            info.product == "netrics"
        else {
            return .failure(.notNetrics)
        }
        guard supportedDeviceAPIVersions.contains(info.deviceApiVersion) else {
            return .failure(.incompatibleVersion(server: info.deviceApiVersion))
        }
        var checked = config
        if let pin = learnedPin(transport) {
            checked.pinnedCertificateSHA256 = pin
        }
        return .success(ServerCheckResult(config: checked, info: info))
    }

    static func map(_ error: TransportError, allowInsecure: Bool) -> ServerCheckError {
        switch error {
        case .plainHTTPToPublicHost(let host): return .plainHTTPToPublicHost(host)
        case .plainHTTPNotAllowed(let host): return .plainHTTPNeedsSetting(host)
        case .invalidURL: return .invalidAddress
        case .unreachable(let detail): return .unreachable(detail)
        case .timedOut: return .timedOut
        case .untrustedCertificate: return .untrustedCertificate(settingHelps: !allowInsecure)
        case .certificateChanged: return .certificateChanged
        case .redirected(let location): return .redirected(location)
        }
    }
}
