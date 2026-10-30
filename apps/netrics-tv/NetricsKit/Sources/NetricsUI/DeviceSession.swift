import Foundation
import NetricsKit
import Observation

/**
 * The app's state on every platform (ADR 0010, ADR 0021): which server this
 * device uses (Keychain), and the device client that pairs and polls it. A
 * new device starts pairing with netrics cloud at once; until it is paired it
 * can switch to its own server and back. Once paired, the server changes only
 * by unpairing.
 *
 * The tvOS and the iPhone and iPad apps share it and differ only in their
 * screens and in the platform they report (#406).
 */
@MainActor
@Observable
public final class DeviceSession {
    public enum Route: Equatable, Sendable {
        case launching
        /** No server yet: checking netrics cloud, retrying until it answers. */
        case connectingCloud
        /** The user's own server: address and transport setting. */
        case ownServer
        case running
    }

    public private(set) var route: Route = .launching
    public private(set) var server: ServerConfig?
    public private(set) var device = DeviceState()
    /** Shown on the server screen when the Keychain refuses to save. */
    public var storageError: String?
    /** Why netrics cloud did not answer the last check, while retrying. */
    public private(set) var cloudError: ServerCheckError?
    /** Seconds between checks of netrics cloud while it does not answer. */
    public static let cloudRetryInterval: Duration = .seconds(10)
    /** The screen in points and its scale, as the root view measures it (unrotated). */
    public private(set) var screen = StudioCanvas(width: 0, height: 0)
    public private(set) var screenScale = 1.0

    /** What the device reports when it pairs and in its heartbeat (#406). */
    public let platform: DevicePlatform
    private let store: any CredentialStore
    private let checker: ServerChecker
    private let cache: any DashboardCache
    /** Schema 2 images by SHA-256, next to the cached payload. */
    public let images: FileImageCache

    private var client: DeviceClient?
    private var runTask: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?
    private var cloudTask: Task<Void, Never>?

    /**
     * `appGroup`: the App Group that holds the caches (Info.plist's
     * `NetricsAppGroup`); a cache from before #410 moves there once.
     */
    public init(
        platform: DevicePlatform,
        appGroup: String?,
        store: any CredentialStore = KeychainCredentialStore(),
        checker: ServerChecker = .live
    ) {
        self.platform = platform
        self.store = store
        self.checker = checker
        let folder = CacheLocation.resolve(appGroup: appGroup)
        cache = FileDashboardCache.inFolder(folder)
        images = FileImageCache.inFolder(folder)
    }

    public static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    /** An Apple TV, for the texts that name the device ("This TV"). */
    public var isTV: Bool { platform == .tvos }

    public func launch() {
        guard route == .launching else { return }
        #if DEBUG
            if let path = DebugLaunch.payload {
                showFixture(path)
                return
            }
        #endif
        if let server = store.loadServer() {
            start(server)
        } else if DebugLaunch.server != nil {
            route = .ownServer
        } else {
            connectToCloud()
        }
    }

    #if DEBUG
        /** Debug builds: a payload file shown as if paired, with no server and nothing stored in the Keychain. */
        private func showFixture(_ path: String) {
            var state = DeviceState()
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                state.payload = try JSONDecoder().decode(DashboardPayload.self, from: data)
            } catch {
                state.phase = .blocked("Debug payload \(path): \(error)")
                device = state
                route = .running
                return
            }
            if let folder = DebugLaunch.images, case .v2(let payload) = state.payload {
                for image in payload.images {
                    let file = URL(fileURLWithPath: folder).appendingPathComponent(image.sha256)
                    guard let bytes = try? Data(contentsOf: file) else { continue }
                    images.store(bytes, sha256: image.sha256)
                    state.storedImages.insert(image.sha256)
                }
            }
            state.phase = .paired
            state.updatedAt = Date()
            device = state
            route = .running
        }
    #endif

    /** Checks netrics cloud and starts pairing; retries while it is unreachable. */
    public func connectToCloud() {
        cloudTask?.cancel()
        cloudError = nil
        route = .connectingCloud
        cloudTask = Task { [weak self, checker] in
            while !Task.isCancelled {
                let result = await checker.check(ServerConfig.cloud)
                guard let self, !Task.isCancelled, self.route == .connectingCloud else { return }
                switch result {
                case .success(let checked):
                    self.use(checked)
                    return
                case .failure(let failure):
                    self.cloudError = failure
                }
                try? await Task.sleep(for: Self.cloudRetryInterval)
            }
        }
    }

    /** Not paired yet: drop the current server and enter the user's own. */
    public func switchToOwnServer() {
        forgetServer()
        route = .ownServer
    }

    /** Not paired yet: drop the current server and pair with netrics cloud. */
    public func switchToCloud() {
        forgetServer()
        connectToCloud()
    }

    /**
     * The device's language (ADR 0016): the workspace's screen language from
     * the payload once there is one, else the system language.
     */
    public var language: ScreenLanguage {
        device.payload?.language ?? .system()
    }

    /** True while the device is not paired, so changing the server loses nothing. */
    public var canSwitchServer: Bool {
        route != .running || device.phase != .paired
    }

    private func forgetServer() {
        cloudTask?.cancel()
        cloudTask = nil
        stopClient()
        store.clearAll()
        cache.clear()
        images.clear()
        server = nil
        device = DeviceState()
        storageError = nil
    }

    /**
     * "Your own server": checks the address with the transport setting and
     * uses the server when it passes; else the reason, in the device's language.
     */
    public func checkOwnServer(address: String, allowInsecure: Bool) async -> ServerCheckError? {
        let result = await checker.check(address: address, kind: .custom, allowInsecure: allowInsecure)
        switch result {
        case .success(let checked):
            use(checked)
            return nil
        case .failure(let failure):
            return failure
        }
    }

    /** A server passed the check: remember it and start pairing. */
    public func use(_ result: ServerCheckResult) {
        cloudTask?.cancel()
        cloudTask = nil
        do {
            try store.saveServer(result.config)
            storageError = nil
        } catch {
            // Still usable until the app restarts; say why it will ask again.
            let tv = isTV
            storageError = L10n.tr(
                tv
                    ? "This TV could not save the server in its Keychain (%@)."
                    : "This device could not save the server in its Keychain (%@).",
                language, String(describing: error))
        }
        start(result.config)
    }

    private func start(_ server: ServerConfig) {
        stopClient()
        self.server = server
        let transport = URLSessionTransport(
            policy: server.policy,
            trust: CertificateTrust(
                pinned: server.pinnedCertificateSHA256,
                allowSelfSigned: server.policy.allowInsecureConnections,
                pinOnFirstUse: false
            )
        )
        let client = DeviceClient(
            server: server, transport: transport, store: store, cache: cache, images: images,
            appVersion: Self.appVersion,
            screen: { [weak self] in await self?.screenReport() },
            platform: platform)
        self.client = client
        device = DeviceState()
        route = .running
        updatesTask = Task { [weak self] in
            for await state in client.updates {
                self?.device = state
            }
        }
        runTask = Task { await client.run() }
    }

    /**
     * The app is in the foreground again: the client goes on at once with
     * the same pairing (or a new code when it expired) or the dashboard.
     */
    public func resume() {
        guard let client else { return }
        Task { await client.wake() }
    }

    /** The root view measured the screen (launch, or a new display mode or window size). */
    public func measured(_ width: Double, _ height: Double, scale: Double) {
        screen = StudioCanvas(width: width, height: height)
        screenScale = scale
    }

    /**
     * What the heartbeat reports (ADR 0017, section 7): the size after the
     * rotation setting, the format shown and screen view.
     */
    public func screenReport() -> DeviceScreenReport? {
        ScreenView.report(screen: screen, scale: screenScale, payload: device.dashboardV2)
    }

    private func stopClient() {
        runTask?.cancel()
        updatesTask?.cancel()
        runTask = nil
        updatesTask = nil
        client = nil
    }

    /** Settings → Unpair: revokes the device on the server, clears Keychain and cache, then pairs with netrics cloud again. */
    public func unpair() async {
        if let client {
            await client.unpair()
        }
        stopClient()
        store.clearAll()
        cache.clear()
        images.clear()
        server = nil
        device = DeviceState()
        connectToCloud()
    }
}

/**
 * Debug builds only: prefill "Your own server" from launch arguments, so a
 * simulator can be driven without a remote or a keyboard, e.g.
 * `xcrun simctl launch <udid> tv.netrics -NetricsDebugServer http://localhost:3190
 *  -NetricsDebugInsecure YES -NetricsDebugAutoConnect YES`, or show a payload
 * file as if paired (`-NetricsDebugPayload /path/payload.json`, optionally
 * `-NetricsDebugImages /path/images`), which compares renderings.
 */
public enum DebugLaunch {
    #if DEBUG
        public static var server: String? { UserDefaults.standard.string(forKey: "NetricsDebugServer") }
        public static var allowInsecure: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugInsecure") }
        public static var autoConnect: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugAutoConnect") }
        public static var openSettings: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugSettings") }
        /** A payload file (JSON) to show as if paired, without a server: screenshots of the rendering. */
        public static var payload: String? { UserDefaults.standard.string(forKey: "NetricsDebugPayload") }
        /** A folder of image files named by their SHA-256, stored for `payload`'s images. */
        public static var images: String? { UserDefaults.standard.string(forKey: "NetricsDebugImages") }
    #else
        public static let server: String? = nil
        public static let allowInsecure = false
        public static let autoConnect = false
        public static let openSettings = false
        public static let payload: String? = nil
        public static let images: String? = nil
    #endif
}
