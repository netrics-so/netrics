import Foundation
import Testing

@testable import NetricsKit

/**
 * #410: the cache moves from the app's own Caches directory into the App
 * Group container. A paired Apple TV must keep its last dashboard and its
 * images across that move, so it still starts offline.
 */
@Suite struct CacheLocationTests {
    let root: URL
    let legacy: URL
    let shared: URL
    let hash = String(repeating: "a", count: 64)
    let otherHash = String(repeating: "b", count: 64)

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "netrics-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        legacy = root.appending(path: "app/Library/Caches/netrics", directoryHint: .isDirectory)
        shared = root.appending(path: "group/Library/Caches/netrics", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
    }

    private func entry(_ name: String) -> CachedDashboard {
        CachedDashboard(etag: "\"\(name)\"", payload: dashboard(name), updatedAt: T0)
    }

    @Test func movesDashboardAndImagesIntoTheSharedFolder() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        FileDashboardCache.inFolder(legacy).save(entry("Before"))
        let oldImages = FileImageCache.inFolder(legacy, now: { T0 })
        oldImages.store(Data("png".utf8), sha256: hash)

        CacheLocation.migrate(from: legacy, to: shared)

        #expect(FileDashboardCache.inFolder(shared).load() == entry("Before"))
        let images = FileImageCache.inFolder(shared)
        #expect(images.data(hash) == Data("png".utf8))
        // The last use (the file's modification date) survives for eviction.
        let moved = try FileManager.default.attributesOfItem(atPath: images.fileURL(hash)!.path)
        #expect((moved[.modificationDate] as? Date) == T0)
        // The old folder is gone, so the move runs once.
        #expect(!FileManager.default.fileExists(atPath: legacy.path))
    }

    @Test func keepsWhatTheSharedFolderAlreadyHasAndMergesImages() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        FileDashboardCache.inFolder(legacy).save(entry("Old"))
        FileImageCache.inFolder(legacy).store(Data("old".utf8), sha256: hash)
        FileDashboardCache.inFolder(shared).save(entry("New"))
        FileImageCache.inFolder(shared).store(Data("new".utf8), sha256: otherHash)

        CacheLocation.migrate(from: legacy, to: shared)

        #expect(FileDashboardCache.inFolder(shared).load() == entry("New"))
        let images = FileImageCache.inFolder(shared)
        #expect(images.data(hash) == Data("old".utf8))
        #expect(images.data(otherHash) == Data("new".utf8))
        #expect(!FileManager.default.fileExists(atPath: legacy.path))
    }

    @Test func doesNothingWithoutAnOldFolderOrWhenBothAreTheSame() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        FileDashboardCache.inFolder(legacy).save(entry("Same"))
        CacheLocation.migrate(from: legacy, to: legacy)
        #expect(FileDashboardCache.inFolder(legacy).load() == entry("Same"))

        let missing = root.appending(path: "nowhere", directoryHint: .isDirectory)
        CacheLocation.migrate(from: missing, to: shared)
        #expect(!FileManager.default.fileExists(atPath: shared.path))
    }

    @Test func withoutAnAppGroupTheCacheStaysInTheAppsCaches() {
        #expect(CacheLocation.resolve(appGroup: nil) == CacheLocation.appCaches())
        #expect(CacheLocation.resolve(appGroup: "") == CacheLocation.appCaches())
        #expect(CacheLocation.appCaches().lastPathComponent == "netrics")
    }
}
