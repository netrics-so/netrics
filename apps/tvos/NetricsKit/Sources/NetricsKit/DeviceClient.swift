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
// Schema 2 (ADR 0015, section 7): the client asks for `?schema=2` only
// when the server's info lists it (checked before the first poll and every
// few hours), and sends a cached ETag only with the schema it belongs to.
// After a schema 2 payload it downloads the images it does not have yet,
// verified by their SHA-256, with the device token.
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
    /** The last dashboard the API returned (schema 1 or 2); kept through outages. */
    public var payload: DashboardPayload?
    /** Hashes of the payload's images that are on disk and can be shown. */
    public var storedImages: Set<String> = []
    /** When the API last confirmed the dashboard (200 or 304). */
    public var updatedAt: Date?
    /** The latest request failed; the screen shows the last known state. */
    public var offline = false
    public var lastError: String?
    public var device: DeviceSummary?

    public init() {}

    /** The schema 1 payload, when the server answered schema 1. */
    public var dashboard: DeviceDashboard? {
        get {
            if case .v1(let payload) = payload { return payload }
            return nil
        }
        set { payload = newValue.map { .v1($0) } }
    }

    /** The schema 2 payload, when the server answered schema 2. */
    public var dashboardV2: DeviceDashboardV2? {
        if case .v2(let payload) = payload { return payload }
        return nil
    }
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
    /** The heartbeat's appVersion field accepts at most this many characters. */
    public static let maxAppVersionLength = 50
    public static let backoffMin: Duration = .seconds(5)
    public static let backoffMax: Duration = .seconds(60)
    static let defaultRefreshAfterSeconds = 60
    /** How often the server's dashboard schemas are checked again (an upgraded server). */
    public static let schemaRecheckInterval: TimeInterval = 6 * 60 * 60
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
    private let images: any ImageCache
    private let appVersion: String
    private let now: @Sendable () -> Date

    public private(set) var state = DeviceState()
    public nonisolated let updates: AsyncStream<DeviceState>
    private let continuation: AsyncStream<DeviceState>.Continuation

    private var credentials: DeviceCredentials?
    private var etag: String?
    /** The schema the server answers, from its info; nil until known. */
    private var serverSchema: Int?
    private var schemaCheckedAt: Date?
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
        images: any ImageCache = InMemoryImageCache(),
        appVersion: String,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.server = server
        self.transport = transport
        self.store = store
        self.cache = cache
        self.images = images
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
        next.payload = cached?.payload
        next.storedImages = storedImages(cached?.payload)
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
        images.clear()
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
            // English here; the app shows it in its language (KitStrings.translate).
            $0.phase = .blocked(KitStrings.text(.certificateChangedBlocked))
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
        images.clear()
        failures = 0
        update {
            $0.phase = .pairing
            $0.pairing = nil
            $0.payload = nil
            $0.storedImages = []
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
        images.clear()
        etag = nil
        pairingSecret = nil
        failures = 0
        update {
            $0.phase = .paired
            $0.pairing = nil
            $0.payload = nil
            $0.storedImages = []
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
            if needsSchemaCheck() {
                try await checkServerSchema()
                guard at == epoch else { return superseded() }
            }
            let schema = requestSchema()
            var response = try await getDashboard(schema: schema)
            guard at == epoch else { return superseded() }
            if response.status == 401 {
                // Expired early or rotated elsewhere: one refresh, one retry.
                let outcome = try await refresh()
                guard at == epoch else { return superseded() }
                if outcome == .revoked {
                    enterPairing()
                    return await startPairing()
                }
                response = try await getDashboard(schema: schema)
                guard at == epoch else { return superseded() }
                if response.status == 401 {
                    // A fresh token refused: the device was revoked.
                    enterPairing()
                    return await startPairing()
                }
            }
            let confirmedAt = now()
            if response.status == 304, let payload = state.payload, payload.schema == schema {
                failures = 0
                update {
                    $0.updatedAt = confirmedAt
                    $0.offline = false
                    $0.lastError = nil
                }
                cache.save(CachedDashboard(etag: etag, payload: payload, updatedAt: confirmedAt))
                await syncImages(payload, epoch: at)
                return refreshAfter(payload)
            }
            guard response.isSuccess else { throw HTTPStatusError(status: response.status) }
            // An older server ignores ?schema=2 and answers schema 1: read
            // whichever schema the body is.
            let payload = try decode(DashboardPayload.self, response, "dashboard")
            failures = 0
            etag = response.header("etag") ?? "\"\(payload.version)\""
            if payload.schema != schema {
                // The server answers another schema than it listed: follow it.
                serverSchema = payload.schema
            }
            cache.save(CachedDashboard(etag: etag, payload: payload, updatedAt: confirmedAt))
            let stored = storedImages(payload)
            update {
                $0.payload = payload
                $0.storedImages = stored
                $0.updatedAt = confirmedAt
                $0.offline = false
                $0.lastError = nil
            }
            await syncImages(payload, epoch: at)
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

    private func getDashboard(schema: Int) async throws -> HTTPResponse {
        var headers = ["authorization": "Bearer \(credentials?.accessToken ?? "")"]
        // An ETag names one schema's answer: never offer it for the other.
        if let etag, let payload = state.payload, payload.schema == schema {
            headers["if-none-match"] = etag
        }
        let path = schema == 1 ? "/v1/device/dashboard" : "/v1/device/dashboard?schema=\(schema)"
        return try await send("GET", path, headers: headers)
    }

    private func refreshAfter(_ payload: DashboardPayload) -> Duration {
        .seconds(payload.refreshAfterSec > 0 ? payload.refreshAfterSec : Self.defaultRefreshAfterSeconds)
    }

    // MARK: Schema negotiation

    private func needsSchemaCheck() -> Bool {
        guard let checkedAt = schemaCheckedAt, serverSchema != nil else { return true }
        return now().timeIntervalSince(checkedAt) >= Self.schemaRecheckInterval
    }

    /**
     * Reads `dashboardSchemas` from the server's info. A failed check is
     * not an outage: the poll goes on with what is known and checks again
     * on the next one. Only a changed certificate stops the client.
     */
    private func checkServerSchema() async throws {
        let response: HTTPResponse
        do {
            response = try await send("GET", "/v1/server")
        } catch TransportError.certificateChanged {
            throw TransportError.certificateChanged
        } catch {
            return
        }
        guard response.isSuccess, let info = try? JSONDecoder().decode(ServerInfo.self, from: response.body)
        else { return }
        serverSchema = info.preferredDashboardSchema
        schemaCheckedAt = now()
    }

    /** The schema to ask for: the server's, else the cached payload's, else 1. */
    func requestSchema() -> Int {
        serverSchema ?? state.payload?.schema ?? 1
    }

    // MARK: Images

    private func storedImages(_ payload: DashboardPayload?) -> Set<String> {
        guard case .v2(let v2) = payload else { return [] }
        return Set(v2.images.map(\.sha256).filter { images.contains($0) })
    }

    /**
     * Downloads the payload's images that are not stored yet, then marks
     * them used and evicts unreferenced ones beyond the budget. A failed
     * image is retried with the next poll; it never fails the dashboard.
     */
    private func syncImages(_ payload: DashboardPayload, epoch at: Int) async {
        guard case .v2(let v2) = payload else { return }
        let referenced = Set(v2.images.map(\.sha256))
        for image in v2.images where !images.contains(image.sha256) {
            guard at == epoch, let data = await fetchImage(image) else { continue }
            images.store(data, sha256: image.sha256)
            guard at == epoch else { return }
            update { $0.storedImages.insert(image.sha256) }
        }
        guard at == epoch else { return }
        images.touch(referenced, at: now())
        images.evict(keeping: referenced, budget: ImageCacheLimits.budget)
    }

    /** The image's URL on this server; nil for anything but a device image path. */
    func imageURL(_ image: DeviceImage) -> URL? {
        // Relative to the server, and only below the device image route:
        // the bearer token must never go to another host or path.
        guard image.url.hasPrefix("/v1/device/images/"), !image.url.contains(".."),
            !image.url.contains("//"), !image.url.contains("@"), !image.url.contains("\\")
        else { return nil }
        let url = server.endpoint(image.url)
        guard url.host() == server.baseURL.host(), url.scheme == server.baseURL.scheme else { return nil }
        return url
    }

    private func fetchImage(_ image: DeviceImage) async -> Data? {
        guard let url = imageURL(image), let token = credentials?.accessToken else { return nil }
        do {
            try server.policy.validate(url)
            let response = try await transport.send(
                HTTPRequest(url: url, headers: ["authorization": "Bearer \(token)", "accept": "image/*"]))
            guard response.isSuccess, response.body.count <= ImageCacheLimits.maxImageBytes else { return nil }
            // Stored only when the bytes are the ones the payload names.
            guard ImageHash.sha256(response.body) == image.sha256 else { return nil }
            return response.body
        } catch {
            return nil
        }
    }

    /**
     * What the TV reports as its app version: "tvos <version>" (#125), the
     * counterpart of the browser kiosk's "web <version>", so the TV list can
     * tell the two apart. "tvos" alone when the bundle carries no version.
     */
    public static func reportedAppVersion(_ version: String) -> String {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let reported = trimmed.isEmpty ? "tvos" : "tvos \(trimmed)"
        return String(reported.prefix(maxAppVersionLength))
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
        let body = DeviceHeartbeatRequest(
            appVersion: Self.reportedAppVersion(appVersion),
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
