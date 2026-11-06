import Foundation

/**
 * The hosted service ("netrics cloud"): the web app's public address. The
 * device API is served under /v1 of the same origin.
 */
public enum NetricsCloud {
    public static let baseURL = URL(string: "https://app.netrics.so")!
}

public enum ServerKind: String, Codable, Sendable, Equatable {
    case cloud
    case custom
}

/**
 * The server this TV talks to, stored with the credentials (Keychain). It
 * changes only by unpairing (ADR 0010).
 */
public struct ServerConfig: Codable, Sendable, Equatable {
    /** Origin (and optional path prefix) without a trailing slash. */
    public var baseURL: URL
    public var kind: ServerKind
    public var policy: TransportPolicy
    /** SHA-256 of the leaf certificate, when a self-signed one was trusted. */
    public var pinnedCertificateSHA256: String?

    public init(
        baseURL: URL, kind: ServerKind, policy: TransportPolicy = TransportPolicy(),
        pinnedCertificateSHA256: String? = nil
    ) {
        self.baseURL = baseURL
        self.kind = kind
        self.policy = policy
        self.pinnedCertificateSHA256 = pinnedCertificateSHA256
    }

    public static var cloud: ServerConfig { ServerConfig(baseURL: NetricsCloud.baseURL, kind: .cloud) }

    /** An API path below the base URL, e.g. "/v1/server". */
    public func endpoint(_ path: String) -> URL {
        URL(string: baseURL.absoluteString + path)!
    }

    /** What the settings and pairing screens show. */
    public var displayName: String {
        switch kind {
        case .cloud: return "netrics cloud"
        case .custom: return ServerAddress.display(baseURL)
        }
    }
}

public enum ServerAddress {
    /**
     * Reads what the user typed: "netrics.example.com", "http://nas.local:3000/",
     * "https://example.com/netrics". Without a scheme HTTPS is assumed. The
     * query, fragment and a trailing slash are dropped; nil when it is not a
     * usable http(s) address.
     */
    public static func parse(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") {
            text = "https://" + text
        }
        guard var components = URLComponents(string: text),
            let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let host = components.host, !host.isEmpty,
            components.user == nil, components.password == nil
        else {
            return nil
        }
        components.scheme = scheme
        components.host = host.lowercased()
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") {
            components.path.removeLast()
        }
        return components.url
    }

    /** "nas.local:3000" or "https://example.com" without noise. */
    public static func display(_ url: URL) -> String {
        var text = url.absoluteString
        if text.hasPrefix("https://") {
            text.removeFirst("https://".count)
        }
        return text
    }
}
