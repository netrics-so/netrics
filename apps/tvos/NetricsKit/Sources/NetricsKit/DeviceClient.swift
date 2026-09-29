import Foundation

// The TV's side of the device API (ADR 0010, ADR 0011): pairing, credential
// storage and rotation, the dashboard poll with ETags, heartbeats and
// backoff. It follows the browser kiosk (apps/web/src/lib/kiosk-client.ts)
// rule for rule:
//
// - a new token pair is persisted before it is used;
// - one refresh at a time; concurrent callers share its outcome;
// - refresh 2 minutes before the access token expires, and once after a 401;
// - a 401 on refresh means revoked: clear the credentials and pair again;
// - the last dashboard stays on screen (and on disk) through outages;
// - failures back off 5 s, 10 s, 20 s, 40 s, then 60 s.
//
// The client is driven by `tick()`, which does the next step and returns
// how long to wait before the following one. `run()` loops over it with
// real sleeps; tests call `tick()` with a manual clock.

public enum DevicePhase: Sendable, Equatable {
    /** Reading the stored credentials. */
    case starting
    /** Showing a code. */
    case pairing
    /** Showing the dashboard. */
    case paired
    /** The pinned certificate changed: nothing is sent until unpaired. */
    case blocked(String)
    /** Unpaired by the user; the app returns to the server choice. */
    case unpaired
}

public struct PairingDisplay: Sendable, Equatable {
    public var code: String
    public var pairingUrl: String
    public var approveUrl: String
    public var expiresAt: String
}

public struct DeviceState: Sendable, Equatable {
    public var phase: DevicePhase = .starting
    public var pairing: PairingDisplay?
    /** The last dashboard the API returned; kept through outages. */
    public var dashboard: DeviceDashboard?
    /** When the API last confirmed the dashboard (200 or 304). */
    public var updatedAt: Date?
    /** The latest request failed; the screen shows the last known state. */
    public var offline = false
    public var lastError: String?
    public var device: DeviceSummary?

    public init() {}
}

public struct HTTPStatusError: Error, Sendable, Equatable, LocalizedError {
    public let status: Int
    public var errorDescription: String? { "HTTP \(status)" }
}

public struct UnexpectedResponseError: Error, Sendable, Equatable, LocalizedError {
    public let what: String
    public var errorDescription: String? { "Unexpected \(what) response" }
}

enum RefreshOutcome: Sendable, Equatable {
    case ok, revoked, failed
}

public actor DeviceClient {
    /** Refresh the access token this long before it expires. */
    public static let refreshMargin: TimeInterval = 2 * 60
    public static let heartbeatInterval: Duration = .seconds(5 * 60)
    /** The first heartbeat, once the TV has settled after pairing or launch. */
    public static let firstHeartbeat: Duration = .seconds(10)
    public static let backoffMin: Duration = .seconds(5)
    public static let backoffMax: Duration = .seconds(60)
    static let defaultRefreshAfterSeconds = 60
    static let maxErrorLength = 500

    /** 5 s, 10 s, 20 s, 40 s, then 60 s for every further failure. */
    public static func backoff(failures: Int) -> Duration {
        let exponent = max(failures - 1, 0)
        let seconds = min(5.0 * pow(2.0, Double(min(exponent, 10))), 60)
        return .seconds(seconds)
    }

    public let server: ServerConfig
    private let transport: any HTTPTransport
    private let store: any CredentialStore
    private let cache: any DashboardCache
    private let appVersion: String
    private let now: @Sendable () -> Date

    public private(set) var state = DeviceState()
    public nonisolated let updates: AsyncStream<DeviceState>
    private let continuation: AsyncStream<DeviceState>.Continuation

    private var credentials: DeviceCredentials?
    private var etag: String?
    private var pairingSecret: PollPairingRequest?
    private var pollInterval: Duration = .seconds(5)
    private var failures = 0
    private var startedAt = Date()
    private var running = false
    // Bumped on every phase change and on stop: late responses of an earlier
    // phase are dropped instead of acting on the new one.
    private var epoch = 0
    private var refreshing: Task<RefreshOutcome, any Error>?

    public init(
        server: ServerConfig,
        transport: any HTTPTransport,
        store: any CredentialStore,
        cache: any DashboardCache,
        appVersion: String,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.server = server
        self.transport = transport
        self.store = store
        self.cache = cache
        self.appVersion = appVersion
        self.now = now
        (updates, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16))
    }

    deinit {
        continuation.finish()
    }

    // MARK: Lifecycle

    /** Reads the stored credentials and the cached dashboard. */
    public func start() {
        guard !running else { return }
        running = true
        epoch += 1
        startedAt = now()
        credentials = store.loadCredentials()
        guard credentials != nil else {
            enterPairing()
            return
        }
        let cached = cache.load()
        etag = cached?.etag
        failures = 0
        var next = state
        next.phase = .paired
        next.pairing = nil
        next.dashboard = cached?.payload
        next.updatedAt = cached?.updatedAt
        next.offline = false
        next.lastError = nil
        next.device = store.loadDevice()
        publish(next)
    }

    public func stop() {
        running = false
        epoch += 1
    }

    /** Forgets the server and the device on this TV (settings → Unpair). */
    public func unpair() {
        running = false
        epoch += 1
        credentials = nil
        etag = nil
        pairingSecret = nil
        store.clearAll()
        cache.clear()
        var next = DeviceState()
        next.phase = .unpaired
        publish(next)
    }

    /**
     * Runs the client until the task is cancelled, it is unpaired or a
     * certificate change blocks it: the main loop and the heartbeat.
     */
    public func run() async {
        start()
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                while !Task.isCancelled {
                    guard let delay = await self.tick() else { return }
                    try? await Task.sleep(for: delay)
                }
            }
            group.addTask {
                try? await Task.sleep(for: Self.firstHeartbeat)
                while !Task.isCancelled, await self.isRunning {
                    let sent = await self.sendHeartbeat()
                    try? await Task.sleep(for: sent ? Self.heartbeatInterval : Self.firstHeartbeat)
                }
            }
        }
        stop()
    }

    var isRunning: Bool { running }

    /** Does the next step; returns the wait before the next one, nil to stop. */
    public func tick() async -> Duration? {
        if !running {
            return nil
        }
        switch state.phase {
        case .starting:
            start()
            return .zero
        case .pairing:
            if state.pairing == nil || pairingSecret == nil {
                return await startPairing()
            }
            return await pollPairing()
        case .paired:
            return await fetchDashboard()
        case .blocked, .unpaired:
            return nil
        }
    }

    // MARK: State

    private func publish(_ next: DeviceState) {
        state = next
        continuation.yield(next)
    }

    private func update(_ change: (inout DeviceState) -> Void) {
        var next = state
        change(&next)
        publish(next)
    }

    /** After a phase change during an await: go on with the new phase, or stop. */
    private func superseded() -> Duration? {
        running ? .zero : nil
    }

    private func describe(_ error: any Error) -> String {
        let text: String
        if let error = error as? LocalizedError, let description = error.errorDescription {
            text = description
        } else {
            text = String(describing: error)
        }
        return String(text.prefix(Self.maxErrorLength))
    }

    // MARK: HTTP

    private func send(
        _ method: String, _ path: String, body: (any Encodable)? = nil, headers: [String: String] = [:]
    ) async throws -> HTTPResponse {
        let url = server.endpoint(path)
        try server.policy.validate(url)
        var allHeaders = ["accept": "application/json"]
        var data: Data?
        if let body {
            allHeaders["content-type"] = "application/json"
            data = try JSONEncoder().encode(body)
        }
        allHeaders.merge(headers) { _, new in new }
        return try await transport.send(HTTPRequest(url: url, method: method, headers: allHeaders, body: data))
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ response: HTTPResponse, _ what: String) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: response.body)
        } catch {
            throw UnexpectedResponseError(what: what)
        }
    }

    private func block() -> Duration? {
        epoch += 1
        running = false
        update {
            $0.phase = .blocked(
                "The server's certificate has changed. This can mean someone is intercepting the connection. Unpair this TV and set up the server again if you replaced the certificate."
            )
            $0.offline = true
            $0.lastError = describe(TransportError.certificateChanged)
        }
        return nil
    }

    // MARK: Pairing

    private func enterPairing() {
        epoch += 1
        credentials = nil
        etag = nil
        pairingSecret = nil
        store.clearCredentials()
        cache.clear()
        failures = 0
        update {
            $0.phase = .pairing
            $0.pairing = nil
            $0.dashboard = nil
            $0.updatedAt = nil
            $0.offline = false
            $0.device = nil
        }
    }

    private func startPairing() async -> Duration? {
        let at = epoch
        do {
            let response = try await send("POST", "/v1/device/pairings")
            guard response.isSuccess else { throw HTTPStatusError(status: response.status) }
            let pairing = try decode(CreatePairingResponse.self, response, "pairing")
            guard at == epoch else { return superseded() }
            failures = 0
            pairingSecret = PollPairingRequest(pairingId: pairing.pairingId, pollSecret: pairing.pollSecret)
            pollInterval = .seconds(max(pairing.pollIntervalSeconds, 1))
            update {
                $0.pairing = PairingDisplay(
                    code: pairing.code, pairingUrl: pairing.pairingUrl,
                    approveUrl: pairing.approveUrl, expiresAt: pairing.expiresAt)
                $0.offline = false
                $0.lastError = nil
            }
            return pollInterval
        } catch TransportError.certificateChanged {
            return block()
        } catch {
            guard at == epoch else { return superseded() }
            failures += 1
            update {
                $0.offline = true
                $0.lastError = describe(error)
            }
            return Self.backoff(failures: failures)
        }
    }

    private func pollPairing() async -> Duration? {
        let at = epoch
        guard let secret = pairingSecret, let pairing = state.pairing else {
            return await startPairing()
        }
        if let expiresAt = ISODate.parse(pairing.expiresAt), now() >= expiresAt {
            // Expired unclaimed: show a fresh code.
            update { $0.pairing = nil }
            return await startPairing()
        }
        do {
            let response = try await send("POST", "/v1/device/pairings/poll", body: secret)
            guard at == epoch else { return superseded() }
            if response.status == 404 || response.status == 410 {
                update { $0.pairing = nil }
                return await startPairing()
            }
            guard response.isSuccess else { throw HTTPStatusError(status: response.status) }
            let result = try decode(PollPairingResponse.self, response, "pairing poll")
            failures = 0
            switch result {
            case .approved(let device, let credentials):
                enterPaired(credentials, device: device)
                return await fetchDashboard()
            case .pending:
                update {
                    $0.offline = false
                    $0.lastError = nil
                }
                return pollInterval
            }
        } catch TransportError.certificateChanged {
            return block()
        } catch {
            guard at == epoch else { return superseded() }
            failures += 1
            update {
                $0.offline = true
                $0.lastError = describe(error)
            }
            return max(Self.backoff(failures: failures), pollInterval)
        }
    }

    // MARK: Paired: credentials, dashboard, heartbeat

    private func persistCredentials(_ next: DeviceCredentials) {
        // Stored before first use: a crash after the server rotated the pair
        // must not leave only the retired refresh token behind.
        try? store.saveCredentials(next)
        credentials = next
    }

    private func enterPaired(_ next: DeviceCredentials, device: DeviceSummary) {
        epoch += 1
        persistCredentials(next)
        try? store.saveDevice(device)
        cache.clear()
        etag = nil
        pairingSecret = nil
        failures = 0
        update {
            $0.phase = .paired
            $0.pairing = nil
            $0.dashboard = nil
            $0.updatedAt = nil
            $0.offline = false
            $0.lastError = nil
            $0.device = device
        }
    }

    /** One refresh at a time; concurrent callers share its outcome. */
    func refresh() async throws -> RefreshOutcome {
        if let refreshing {
            return try await refreshing.value
        }
        let task = Task { try await self.doRefresh() }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private func doRefresh() async throws -> RefreshOutcome {
        let at = epoch
        // Another client of this store may have rotated the pair already:
        // use its tokens rather than presenting a retired refresh token.
        if let stored = store.loadCredentials(), let current = credentials,
            stored.refreshToken != current.refreshToken,
            let expiry = ISODate.parse(stored.accessTokenExpiresAt),
            expiry.timeIntervalSince(now()) > Self.refreshMargin
        {
            credentials = stored
            return .ok
        }
        guard let current = credentials else {
            return .revoked
        }
        let response = try await send(
            "POST", "/v1/device/token", body: RefreshDeviceTokenRequest(refreshToken: current.refreshToken))
        guard at == epoch else { return .failed }
        if response.status == 401 {
            return .revoked
        }
        guard response.isSuccess else { throw HTTPStatusError(status: response.status) }
        let body = try decode(RefreshDeviceTokenResponse.self, response, "token")
        guard at == epoch else { return .failed }
        persistCredentials(body.credentials)
        return .ok
    }

    private func needsRefresh() -> Bool {
        guard let credentials else { return false }
        guard let expiry = ISODate.parse(credentials.accessTokenExpiresAt) else { return true }
        return expiry.timeIntervalSince(now()) <= Self.refreshMargin
    }

    private func fetchDashboard() async -> Duration? {
        let at = epoch
        do {
            if needsRefresh() {
                let outcome = try await refresh()
                guard at == epoch else { return superseded() }
                if outcome == .revoked {
                    enterPairing()
                    return await startPairing()
                }
            }
            var response = try await getDashboard()
            guard at == epoch else { return superseded() }
            if response.status == 401 {
                // Expired early or rotated elsewhere: one refresh, one retry.
                let outcome = try await refresh()
                guard at == epoch else { return superseded() }
                if outcome == .revoked {
                    enterPairing()
                    return await startPairing()
                }
                response = try await getDashboard()
                guard at == epoch else { return superseded() }
                if response.status == 401 {
                    // A fresh token refused: the device was revoked.
                    enterPairing()
                    return await startPairing()
                }
            }
            let confirmedAt = now()
            if response.status == 304, let dashboard = state.dashboard {
                failures = 0
                update {
                    $0.updatedAt = confirmedAt
                    $0.offline = false
                    $0.lastError = nil
                }
                cache.save(CachedDashboard(etag: etag, payload: dashboard, updatedAt: confirmedAt))
                return refreshAfter(dashboard)
            }
            guard response.isSuccess else { throw HTTPStatusError(status: response.status) }
            let payload = try decode(DeviceDashboard.self, response, "dashboard")
            failures = 0
            etag = response.header("etag") ?? "\"\(payload.version)\""
            cache.save(CachedDashboard(etag: etag, payload: payload, updatedAt: confirmedAt))
            update {
                $0.dashboard = payload
                $0.updatedAt = confirmedAt
                $0.offline = false
                $0.lastError = nil
            }
            return refreshAfter(payload)
        } catch TransportError.certificateChanged {
            return block()
        } catch {
            guard at == epoch else { return superseded() }
            failures += 1
            update {
                $0.offline = true
                $0.lastError = describe(error)
            }
            return Self.backoff(failures: failures)
        }
    }

    private func getDashboard() async throws -> HTTPResponse {
        var headers = ["authorization": "Bearer \(credentials?.accessToken ?? "")"]
        if let etag, state.dashboard != nil {
            headers["if-none-match"] = etag
        }
        return try await send("GET", "/v1/device/dashboard", headers: headers)
    }

    private func refreshAfter(_ dashboard: DeviceDashboard) -> Duration {
        .seconds(dashboard.refreshAfterSec > 0 ? dashboard.refreshAfterSec : Self.defaultRefreshAfterSeconds)
    }

    /**
     * Reports version, uptime and the last error (best effort; the dashboard
     * loop reports outages), and picks up a renamed device. Returns whether
     * the TV was paired.
     */
    @discardableResult
    public func sendHeartbeat() async -> Bool {
        guard running, state.phase == .paired, let credentials else { return false }
        let at = epoch
        let uptime = max(Int(now().timeIntervalSince(startedAt)), 0)
        let version = String(appVersion.prefix(50))
        let body = DeviceHeartbeatRequest(
            appVersion: version.isEmpty ? "tvos" : version,
            uptimeSeconds: uptime,
            lastError: state.lastError
        )
        let authorization = ["authorization": "Bearer \(credentials.accessToken)"]
        _ = try? await send("POST", "/v1/device/heartbeat", body: body, headers: authorization)
        if let response = try? await send("GET", "/v1/device/me", headers: authorization),
            response.isSuccess,
            let me = try? JSONDecoder().decode(DeviceSelfResponse.self, from: response.body),
            at == epoch
        {
            let device = DeviceSummary(id: me.device.id, name: me.device.name)
            if device != state.device {
                try? store.saveDevice(device)
                update { $0.device = device }
            }
        }
        return true
    }
}
