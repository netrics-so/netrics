import Foundation

// The HTTP seam: the client talks to a small protocol, so tests script the
// API and the app plugs in URLSession (URLSessionTransport).

public struct HTTPRequest: Sendable, Equatable {
    public var url: URL
    public var method: String
    public var headers: [String: String]
    public var body: Data?

    public init(url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
    }

    /** A header by case-insensitive name. */
    public func header(_ name: String) -> String? {
        headers.first { $0.key.lowercased() == name.lowercased() }?.value
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    /** Header names in lower case. */
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = Dictionary(
            headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, last in last })
        self.body = body
    }

    public var isSuccess: Bool { (200..<300).contains(status) }

    public func header(_ name: String) -> String? { headers[name.lowercased()] }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/** Why a request did not produce an HTTP response. */
public enum TransportError: Error, Sendable, Equatable {
    /** Plain HTTP to a host outside the local network: never allowed. */
    case plainHTTPToPublicHost(String)
    /** Plain HTTP to a local host while the insecure setting is off. */
    case plainHTTPNotAllowed(String)
    /** Neither http nor https, or no host. */
    case invalidURL(String)
    case unreachable(String)
    case timedOut
    /** The certificate is not trusted (self-signed, expired, wrong name). */
    case untrustedCertificate(String)
    /** The server presents a different certificate than the pinned one. */
    case certificateChanged
    /** A redirect; the device API never redirects, so it is not followed. */
    case redirected(String?)
}

extension TransportError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .plainHTTPToPublicHost(let host):
            return "Plain HTTP to \(host) is not allowed: only local-network servers can be used without HTTPS"
        case .plainHTTPNotAllowed(let host):
            return "\(host) uses plain HTTP, which is off by default"
        case .invalidURL(let url):
            return "Not a valid server address: \(url)"
        case .unreachable(let detail):
            return "Cannot reach the server (\(detail))"
        case .timedOut:
            return "The server did not answer in time"
        case .untrustedCertificate(let detail):
            return "The server's certificate is not trusted (\(detail))"
        case .certificateChanged:
            return "The server's certificate has changed"
        case .redirected(let location):
            return "The server redirected to \(location ?? "another address")"
        }
    }
}
