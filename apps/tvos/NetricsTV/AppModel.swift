import Foundation
import NetricsKit
import Observation
import UIKit

/**
 * The app's state: which server this TV uses (Keychain), and the device
 * client that pairs and polls it. A new TV starts pairing with netrics cloud
 * at once; until it is paired it can switch to its own server and back. Once
 * paired, the server changes only by unpairing (ADR 0010).
 */
@MainActor
@Observable
final class AppModel {
    enum Route: Equatable {
        case launching
        /** No server yet: checking netrics cloud, retrying until it answers. */
        case connectingCloud
        /** The user's own server: address and transport setting. */
        case ownServer
        case running
    }

    private(set) var route: Route = .launching
    private(set) var server: ServerConfig?
    private(set) var device = DeviceState()
    /** Shown on the server screen when the Keychain refuses to save. */
    var storageError: String?
    /** Why netrics cloud did not answer the last check, while retrying. */
    private(set) var cloudError: ServerCheckError?
    /** Seconds between checks of netrics cloud while it does not answer. */
    static let cloudRetryInterval: Duration = .seconds(10)

    private let store: any CredentialStore = KeychainCredentialStore()
    private let cache: any DashboardCache = FileDashboardCache.inCachesDirectory()
    /** Schema 2 images by SHA-256, next to the cached payload. */
    let images = FileImageCache.inCachesDirectory()
    private var client: DeviceClient?
    private var runTask: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?
    private var cloudTask: Task<Void, Never>?

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    func launch() {
        guard route == .launching else { return }
        if let server = store.loadServer() {
            start(server)
        } else if DebugLaunch.server != nil {
            route = .ownServer
        } else {
            connectToCloud()
        }
    }

    /** Checks netrics cloud and starts pairing; retries while it is unreachable. */
    func connectToCloud() {
        cloudTask?.cancel()
        cloudError = nil
        route = .connectingCloud
        cloudTask = Task { [weak self] in
            while !Task.isCancelled {
                let result = await ServerChecker.live.check(ServerConfig.cloud)
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
    func switchToOwnServer() {
        forgetServer()
        route = .ownServer
    }

    /** Not paired yet: drop the current server and pair with netrics cloud. */
    func switchToCloud() {
        forgetServer()
        connectToCloud()
    }

    /**
     * The TV's language (ADR 0016): the workspace's screen language from
     * the payload once there is one, else the Apple TV's system language.
     */
    var language: ScreenLanguage {
        device.payload?.language ?? .system()
    }

    /** True while the TV is not paired, so changing the server loses nothing. */
    var canSwitchServer: Bool {
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

    /** A server passed the check: remember it and start pairing. */
    func use(_ result: ServerCheckResult) {
        cloudTask?.cancel()
        cloudTask = nil
        do {
            try store.saveServer(result.config)
            storageError = nil
        } catch {
            // Still usable until the app restarts; say why it will ask again.
            storageError = L10n.tr(
                "This TV could not save the server in its Keychain (%@).", language, String(describing: error))
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
            appVersion: Self.appVersion)
        self.client = client
        device = DeviceState()
        route = .running
        updatesTask = Task { [weak self] in
            for await state in client.updates {
                self?.apply(state)
            }
        }
        runTask = Task { await client.run() }
    }

    private func apply(_ state: DeviceState) {
        device = state
        // A wall screen stays on while it shows a dashboard.
        UIApplication.shared.isIdleTimerDisabled = state.phase == .paired
    }

    private func stopClient() {
        runTask?.cancel()
        updatesTask?.cancel()
        runTask = nil
        updatesTask = nil
        client = nil
    }

    /** Settings → Unpair: clears Keychain and cache, then pairs with netrics cloud again. */
    func unpair() async {
        if let client {
            await client.unpair()
        }
        stopClient()
        store.clearAll()
        cache.clear()
        images.clear()
        server = nil
        device = DeviceState()
        UIApplication.shared.isIdleTimerDisabled = false
        connectToCloud()
    }
}
