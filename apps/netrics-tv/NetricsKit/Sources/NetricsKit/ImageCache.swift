import CryptoKit
import Foundation
import Synchronization

/**
 * The images of schema 2 payloads (logo, slide backgrounds, image widgets),
 * stored by their SHA-256 next to the cached payload (ADR 0015, section 7).
 * The bytes under one hash never change, so an image is downloaded once.
 * Beyond the budget (50 MB) the least recently used images that the
 * current payload does not reference are evicted; referenced ones stay, so
 * an offline start shows every image it showed before.
 */
public protocol ImageCache: Sendable {
    /** Whether the bytes for this hash are stored. */
    func contains(_ sha256: String) -> Bool
    /** Stores verified bytes under their hash. */
    func store(_ data: Data, sha256: String)
    /** The stored bytes, or nil. */
    func data(_ sha256: String) -> Data?
    /** Marks the images as used now (least recently used order). */
    func touch(_ hashes: Set<String>, at date: Date)
    /** Evicts unreferenced images, least recently used first, beyond the budget. */
    func evict(keeping referenced: Set<String>, budget: Int)
    func clear()
}

public enum ImageCacheLimits {
    /** ADR 0015: least recently used beyond 50 MB is evicted. */
    public static let budget = 50 * 1024 * 1024
    /** The server caps images at 1 MiB; anything far larger is refused. */
    public static let maxImageBytes = 4 * 1024 * 1024
    public static let contentTypes: Set<String> = ["image/png", "image/jpeg", "image/webp"]
}

public enum ImageHash {
    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /** 64 lower-case hex digits: safe as a file name. */
    public static func isValid(_ hash: String) -> Bool {
        hash.count == 64 && hash.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

/** Which entries to evict: unreferenced, oldest use first, until within budget. */
enum ImageEviction {
    struct Entry: Equatable {
        var sha256: String
        var size: Int
        var lastUsed: Date
    }

    static func victims(_ entries: [Entry], keeping referenced: Set<String>, budget: Int) -> [String] {
        var total = entries.reduce(0) { $0 + $1.size }
        guard total > budget else { return [] }
        var victims: [String] = []
        let candidates = entries.filter { !referenced.contains($0.sha256) }
            .sorted { ($0.lastUsed, $0.sha256) < ($1.lastUsed, $1.sha256) }
        for entry in candidates where total > budget {
            victims.append(entry.sha256)
            total -= entry.size
        }
        return victims
    }
}

public final class InMemoryImageCache: ImageCache {
    private struct Item {
        var data: Data
        var lastUsed: Date
    }

    private let items = Mutex<[String: Item]>([:])
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    public var hashes: Set<String> { items.withLock { Set($0.keys) } }

    public func contains(_ sha256: String) -> Bool { items.withLock { $0[sha256] != nil } }

    public func store(_ data: Data, sha256: String) {
        let date = now()
        items.withLock { $0[sha256] = Item(data: data, lastUsed: date) }
    }

    public func data(_ sha256: String) -> Data? { items.withLock { $0[sha256]?.data } }

    public func touch(_ hashes: Set<String>, at date: Date) {
        items.withLock {
            for hash in hashes where $0[hash] != nil {
                $0[hash]?.lastUsed = date
            }
        }
    }

    public func evict(keeping referenced: Set<String>, budget: Int) {
        items.withLock { items in
            let entries = items.map { ImageEviction.Entry(sha256: $0.key, size: $0.value.data.count, lastUsed: $0.value.lastUsed) }
            for hash in ImageEviction.victims(entries, keeping: referenced, budget: budget) {
                items[hash] = nil
            }
        }
    }

    public func clear() { items.withLock { $0 = [:] } }
}

/**
 * Files in Caches/netrics/images, named by hash; the file's modification
 * date records its last use. The system may purge the directory; missing
 * images are then fetched again.
 */
public final class FileImageCache: ImageCache {
    public let directory: URL
    private let now: @Sendable () -> Date

    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    public static func inCachesDirectory() -> FileImageCache {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return FileImageCache(directory: caches.appending(path: "netrics/images"))
    }

    /** Where the image with this hash is stored (it may not exist). */
    public func fileURL(_ sha256: String) -> URL? {
        guard ImageHash.isValid(sha256) else { return nil }
        return directory.appending(path: "\(sha256).img")
    }

    public func contains(_ sha256: String) -> Bool {
        guard let url = fileURL(sha256) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    public func store(_ data: Data, sha256: String) {
        guard let url = fileURL(sha256) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard (try? data.write(to: url, options: .atomic)) != nil else { return }
        try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
    }

    public func data(_ sha256: String) -> Data? {
        guard let url = fileURL(sha256) else { return nil }
        return try? Data(contentsOf: url)
    }

    public func touch(_ hashes: Set<String>, at date: Date) {
        for hash in hashes {
            guard let url = fileURL(hash), FileManager.default.fileExists(atPath: url.path) else { continue }
            try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }
    }

    public func evict(keeping referenced: Set<String>, budget: Int) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard
            let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: keys)
        else { return }
        var entries: [ImageEviction.Entry] = []
        for file in files where file.pathExtension == "img" {
            let values = try? file.resourceValues(forKeys: Set(keys))
            entries.append(
                ImageEviction.Entry(
                    sha256: file.deletingPathExtension().lastPathComponent,
                    size: values?.fileSize ?? 0,
                    lastUsed: values?.contentModificationDate ?? .distantPast))
        }
        for hash in ImageEviction.victims(entries, keeping: referenced, budget: budget) {
            if let url = fileURL(hash) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    public func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}
