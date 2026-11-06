import Foundation

/**
 * Where the dashboard and image caches live (ADR 0021, section 4):
 * `Library/Caches/netrics` in the app's App Group container, so a later
 * widget extension reads the same cache without a re-pairing. Builds without
 * the App Group entitlement (unsigned CI builds) keep the app's own
 * `Caches/netrics`.
 *
 * Until #410 the tvOS app kept the cache in its own Caches directory. The
 * first launch with the App Group moves it into the container, so a paired
 * TV still starts offline with its last dashboard and images.
 */
public enum CacheLocation {
    /** The cache folder's name, in either place. */
    public static let folder = "netrics"

    /** The Info.plist key that carries the App Group identifier (from the build setting `NETRICS_APP_GROUP`). */
    public static let appGroupInfoKey = "NetricsAppGroup"

    /**
     * The cache folder for this app: in the App Group container when the
     * group is set and the system grants it (moving the old folder there
     * first), else in the app's own Caches directory.
     */
    public static func resolve(appGroup: String?, fileManager: FileManager = .default) -> URL {
        let legacy = appCaches(fileManager)
        guard let appGroup, !appGroup.isEmpty,
            let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else {
            return legacy
        }
        let shared = container.appending(path: "Library/Caches", directoryHint: .isDirectory)
            .appending(path: folder, directoryHint: .isDirectory)
        migrate(from: legacy, to: shared, fileManager: fileManager)
        return shared
    }

    /** `Caches/netrics` in the app's own container: the place before #410. */
    public static func appCaches(_ fileManager: FileManager = .default) -> URL {
        fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: folder, directoryHint: .isDirectory)
    }

    /**
     * Moves an old cache folder into the new place: every entry the new
     * place lacks is moved (copied when a move fails), folders are merged,
     * and an entry the new place already has wins, being newer. The old
     * folder is removed afterwards, so this runs once. A cache that cannot
     * be carried over is only a cache: the next poll fills it again.
     */
    public static func migrate(from legacy: URL, to shared: URL, fileManager: FileManager = .default) {
        guard legacy.standardizedFileURL.path != shared.standardizedFileURL.path,
            fileManager.fileExists(atPath: legacy.path)
        else {
            return
        }
        merge(from: legacy, to: shared, fileManager: fileManager)
        try? fileManager.removeItem(at: legacy)
    }

    private static func merge(from source: URL, to target: URL, fileManager: FileManager) {
        try? fileManager.createDirectory(at: target, withIntermediateDirectories: true)
        let entries = (try? fileManager.contentsOfDirectory(at: source, includingPropertiesForKeys: nil)) ?? []
        for entry in entries {
            let destination = target.appending(path: entry.lastPathComponent)
            if fileManager.fileExists(atPath: destination.path) {
                if isDirectory(entry, fileManager), isDirectory(destination, fileManager) {
                    merge(from: entry, to: destination, fileManager: fileManager)
                }
                continue
            }
            if (try? fileManager.moveItem(at: entry, to: destination)) == nil {
                try? fileManager.copyItem(at: entry, to: destination)
            }
        }
    }

    private static func isDirectory(_ url: URL, _ fileManager: FileManager) -> Bool {
        var directory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }
}
