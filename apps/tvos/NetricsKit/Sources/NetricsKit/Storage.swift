import Foundation
import Security
import Synchronization

/**
 * Where the TV keeps its server and device credentials: the Keychain in the
 * app, memory in tests. Unpairing clears everything.
 */
public protocol CredentialStore: Sendable {
    func loadServer() -> ServerConfig?
    func saveServer(_ server: ServerConfig) throws
    func loadCredentials() -> DeviceCredentials?
    func saveCredentials(_ credentials: DeviceCredentials) throws
    func loadDevice() -> DeviceSummary?
    func saveDevice(_ device: DeviceSummary) throws
    /** Credentials and device, after a revocation; the server stays. */
    func clearCredentials()
    /** Everything, when unpairing. */
    func clearAll()
}

public final class InMemoryCredentialStore: CredentialStore {
    public struct Contents: Sendable, Equatable {
        public var server: ServerConfig?
        public var credentials: DeviceCredentials?
        public var device: DeviceSummary?
    }

    private let contents: Mutex<Contents>

    public init(server: ServerConfig? = nil, credentials: DeviceCredentials? = nil, device: DeviceSummary? = nil) {
        contents = Mutex(Contents(server: server, credentials: credentials, device: device))
    }

    public var snapshot: Contents { contents.withLock { $0 } }

    public func loadServer() -> ServerConfig? { contents.withLock { $0.server } }
    public func saveServer(_ server: ServerConfig) { contents.withLock { $0.server = server } }
    public func loadCredentials() -> DeviceCredentials? { contents.withLock { $0.credentials } }
    public func saveCredentials(_ credentials: DeviceCredentials) {
        contents.withLock { $0.credentials = credentials }
    }
    public func loadDevice() -> DeviceSummary? { contents.withLock { $0.device } }
    public func saveDevice(_ device: DeviceSummary) { contents.withLock { $0.device = device } }
    public func clearCredentials() {
        contents.withLock {
            $0.credentials = nil
            $0.device = nil
        }
    }
    public func clearAll() { contents.withLock { $0 = Contents() } }
}

public struct KeychainError: Error, Sendable, Equatable {
    public let status: OSStatus
}

/**
 * Generic-password items in this device's Keychain, readable after the
 * first unlock (the TV runs unattended) and never synced or backed up.
 */
public final class KeychainCredentialStore: CredentialStore {
    private let service: String

    private enum Account: String, CaseIterable {
        case server, credentials, device
    }

    public init(service: String = "tv.netrics.device") {
        self.service = service
    }

    public func loadServer() -> ServerConfig? { read(.server) }
    public func saveServer(_ server: ServerConfig) throws { try write(server, to: .server) }
    public func loadCredentials() -> DeviceCredentials? {
        guard let credentials: DeviceCredentials = read(.credentials), credentials.isComplete else { return nil }
        return credentials
    }
    public func saveCredentials(_ credentials: DeviceCredentials) throws { try write(credentials, to: .credentials) }
    public func loadDevice() -> DeviceSummary? { read(.device) }
    public func saveDevice(_ device: DeviceSummary) throws { try write(device, to: .device) }

    public func clearCredentials() {
        delete(.credentials)
        delete(.device)
    }

    public func clearAll() {
        for account in Account.allCases {
            delete(account)
        }
    }

    private func query(_ account: Account) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    private func read<Value: Decodable>(_ account: Account) -> Value? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else {
            return nil
        }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    private func write<Value: Encodable>(_ value: Value, to account: Account) throws {
        let data = try JSONEncoder().encode(value)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    private func delete(_ account: Account) {
        SecItemDelete(query(account) as CFDictionary)
    }
}

/**
 * The last dashboard, for an offline start: schema 1 or 2, with the ETag
 * that belongs to that schema's answer.
 */
public struct CachedDashboard: Codable, Sendable, Equatable {
    public var etag: String?
    public var payload: DashboardPayload
    public var updatedAt: Date

    public init(etag: String?, payload: DashboardPayload, updatedAt: Date) {
        self.etag = etag
        self.payload = payload
        self.updatedAt = updatedAt
    }

    public init(etag: String?, payload: DeviceDashboard, updatedAt: Date) {
        self.init(etag: etag, payload: .v1(payload), updatedAt: updatedAt)
    }
}

public protocol DashboardCache: Sendable {
    func load() -> CachedDashboard?
    func save(_ entry: CachedDashboard)
    func clear()
}

public final class InMemoryDashboardCache: DashboardCache {
    private let entry: Mutex<CachedDashboard?>

    public init(_ entry: CachedDashboard? = nil) {
        self.entry = Mutex(entry)
    }

    public func load() -> CachedDashboard? { entry.withLock { $0 } }
    public func save(_ entry: CachedDashboard) { self.entry.withLock { $0 = entry } }
    public func clear() { entry.withLock { $0 = nil } }
}

/**
 * A JSON file in the Caches directory. The system may purge it; the app
 * then waits for the network, as on a first start.
 */
public final class FileDashboardCache: DashboardCache {
    private let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func inCachesDirectory() -> FileDashboardCache {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return FileDashboardCache(fileURL: caches.appending(path: "netrics/dashboard.json"))
    }

    public func load() -> CachedDashboard? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        // A damaged cache is ignored; the next fetch replaces it.
        return try? Self.decoder.decode(CachedDashboard.self, from: data)
    }

    public func save(_ entry: CachedDashboard) {
        guard let data = try? Self.encoder.encode(entry) else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
    }

    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
