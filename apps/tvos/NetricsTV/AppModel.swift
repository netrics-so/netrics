import Foundation
import NetricsKit
import Observation
import UIKit

/**
 * The app's state: which server this TV uses (Keychain), and the device
 * client that pairs and polls it. The server changes only by unpairing
 * (ADR 0010).
 */
@MainActor
@Observable
final class AppModel {
    enum Route: Equatable {
        case launching
        case serverChoice
        case running
    }

    private(set) var route: Route = .launching
    private(set) var server: ServerConfig?
    private(set) var device = DeviceState()
    /** Shown on the server screen when the Keychain refuses to save. */
    var storageError: String?

    private let store: any CredentialStore = KeychainCredentialStore()
    private let cache: any DashboardCache = FileDashboardCache.inCachesDirectory()
    private var client: DeviceClient?
    private var runTask: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    func launch() {
        guard route == .launching else { return }
        if let server = store.loadServer() {
            start(server)
        } else {
            route = .serverChoice
        }
    }

    /** A server passed the check: remember it and start pairing. */
    func use(_ result: ServerCheckResult) {
        do {
            try store.saveServer(result.config)
            storageError = nil
        } catch {
            // Still usable until the app restarts; say why it will ask again.
            storageError = "This TV could not save the server in its Keychain (\(error))."
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
            server: server, transport: transport, store: store, cache: cache,
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

    /** Settings → Unpair: clears Keychain and cache, back to the server choice. */
    func unpair() async {
        if let client {
            await client.unpair()
        }
        stopClient()
        store.clearAll()
        cache.clear()
        server = nil
        device = DeviceState()
        UIApplication.shared.isIdleTimerDisabled = false
        route = .serverChoice
    }
}
