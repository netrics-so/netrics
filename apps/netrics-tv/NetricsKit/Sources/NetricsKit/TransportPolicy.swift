import Foundation

// Transport security (ADR 0010). HTTPS with a valid certificate by default.
// The "Allow insecure connections" setting, off by default, allows plain
// HTTP to local-network hosts and a self-signed certificate pinned on first
// use. Plain HTTP to a public host is refused even with the setting on.

public enum HostClassifier {
    /**
     * Whether a host is on the local network: private IPv4 ranges
     * (10/8, 172.16/12, 192.168/16), loopback, IPv4 link-local, IPv6
     * loopback, unique-local (fc00::/7) and link-local (fe80::/10),
     * `localhost` and `.local` (mDNS) names. Other names count as public,
     * whatever they resolve to.
     */
    public static func isLocalNetwork(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") {
            host = String(host.dropFirst().dropLast())
        }
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if host.isEmpty {
            return false
        }
        if let octets = ipv4Octets(host) {
            return isLocalIPv4(octets)
        }
        if host.contains(":") {
            return isLocalIPv6(host)
        }
        return host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local")
    }

    static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isASCII),
                part.allSatisfy(\.isNumber), let value = Int(part), value <= 255
            else { return nil }
            octets.append(value)
        }
        return octets
    }

    static func isLocalIPv4(_ octets: [Int]) -> Bool {
        switch (octets[0], octets[1]) {
        case (10, _), (127, _): return true
        case (172, 16...31): return true
        case (192, 168): return true
        case (169, 254): return true
        default: return false
        }
    }

    static func isLocalIPv6(_ rawHost: String) -> Bool {
        // Drop a zone index (fe80::1%en0).
        let host = rawHost.split(separator: "%").first.map(String.init) ?? rawHost
        guard let groups = ipv6Groups(host) else { return false }
        if groups == [0, 0, 0, 0, 0, 0, 0, 1] {
            return true  // ::1
        }
        let first = groups[0]
        if first & 0xFE00 == 0xFC00 {
            return true  // fc00::/7 unique local
        }
        if first & 0xFFC0 == 0xFE80 {
            return true  // fe80::/10 link local
        }
        // IPv4-mapped (::ffff:a.b.c.d) follows the IPv4 rules.
        if groups[0..<5].allSatisfy({ $0 == 0 }) && groups[5] == 0xFFFF {
            let octets = [groups[6] >> 8, groups[6] & 0xFF, groups[7] >> 8, groups[7] & 0xFF]
            return isLocalIPv4(octets)
        }
        return false
    }

    /** The eight 16-bit groups of an IPv6 address, or nil. */
    static func ipv6Groups(_ host: String) -> [Int]? {
        var text = host
        var tail: [Int]? = nil
        // A trailing dotted IPv4 part (::ffff:192.168.1.2) stands for two groups.
        if let lastColon = text.lastIndex(of: ":"), text[lastColon...].contains(".") {
            guard let octets = ipv4Octets(String(text[text.index(after: lastColon)...])) else { return nil }
            tail = [octets[0] << 8 | octets[1], octets[2] << 8 | octets[3]]
            text = String(text[...lastColon]) + "0:0"
        }
        let halves = text.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func parse(_ part: String) -> [Int]? {
            if part.isEmpty { return [] }
            var result: [Int] = []
            for group in part.split(separator: ":", omittingEmptySubsequences: false) {
                guard (1...4).contains(group.count), let value = Int(group, radix: 16) else { return nil }
                result.append(value)
            }
            return result
        }
        guard let head = parse(halves[0]) else { return nil }
        var groups = head
        if halves.count == 2 {
            guard let rest = parse(halves[1]) else { return nil }
            let missing = 8 - head.count - rest.count
            guard missing >= 1 else { return nil }
            groups = head + Array(repeating: 0, count: missing) + rest
        }
        guard groups.count == 8 else { return nil }
        if let tail {
            groups = Array(groups.dropLast(2)) + tail
        }
        return groups
    }
}

public struct TransportPolicy: Sendable, Equatable, Codable {
    /** The "Allow insecure connections" setting (not recommended). */
    public var allowInsecureConnections: Bool

    public init(allowInsecureConnections: Bool = false) {
        self.allowInsecureConnections = allowInsecureConnections
    }

    /** Throws when a request to this URL must not be sent. */
    public func validate(_ url: URL) throws(TransportError) {
        guard let scheme = url.scheme?.lowercased(), let host = url.host(percentEncoded: false), !host.isEmpty
        else {
            throw .invalidURL(url.absoluteString)
        }
        switch scheme {
        case "https":
            return
        case "http":
            guard HostClassifier.isLocalNetwork(host) else {
                throw .plainHTTPToPublicHost(host)
            }
            guard allowInsecureConnections else {
                throw .plainHTTPNotAllowed(host)
            }
        default:
            throw .invalidURL(url.absoluteString)
        }
    }
}

/** What to do with a server's TLS certificate. */
public enum TrustDecision: Sendable, Equatable {
    /** The system accepted it and nothing is pinned. */
    case useSystemTrust
    /** It matches the pinned certificate. */
    case acceptPinned
    /** First use of a self-signed certificate: trust and pin it. */
    case acceptAndPin(String)
    case rejectUntrusted
    case rejectChanged
}

public enum CertificatePinning {
    /**
     * - A pinned certificate must match exactly, even if the system would
     *   trust a new one: a change stops the app with a warning.
     * - Without a pin, a certificate the system trusts is used as is.
     * - A certificate the system rejects is accepted only with the setting
     *   on and only while checking the server (trust on first use); it is
     *   then pinned by its SHA-256.
     */
    public static func decide(
        systemTrusted: Bool,
        leafSHA256: String?,
        pinned: String?,
        allowSelfSigned: Bool,
        pinOnFirstUse: Bool
    ) -> TrustDecision {
        if let pinned {
            guard let leafSHA256 else { return .rejectChanged }
            return normalize(leafSHA256) == normalize(pinned) ? .acceptPinned : .rejectChanged
        }
        if systemTrusted {
            return .useSystemTrust
        }
        if allowSelfSigned, pinOnFirstUse, let leafSHA256 {
            return .acceptAndPin(normalize(leafSHA256))
        }
        return .rejectUntrusted
    }

    public static func normalize(_ fingerprint: String) -> String {
        fingerprint.lowercased().filter { $0.isHexDigit }
    }

    /** "AB:CD:…" for display. */
    public static func display(_ fingerprint: String) -> String {
        let hex = normalize(fingerprint).uppercased()
        var pairs: [String] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            pairs.append(String(hex[index..<next]))
            index = next
        }
        return pairs.joined(separator: ":")
    }
}
