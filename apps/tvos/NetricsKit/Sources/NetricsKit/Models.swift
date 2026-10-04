import Foundation

// Codable mirrors of the device API schemas in packages/contracts
// ("Devices and pairing") and packages/contracts/openapi.json. Field names
// match the JSON exactly. Timestamps stay ISO 8601 strings, as the server
// sent them; `ISODate.parse` reads them.

/** The device API version this app speaks (DEVICE_API_VERSION). */
public let supportedDeviceAPIVersions: Set<Int> = [1]

/** GET /v1/server */
public struct ServerInfo: Codable, Sendable, Equatable {
    public var product: String
    public var deviceApiVersion: Int
    public var version: String
    public var pairingUrl: String
    /**
     * The dashboard payload schemas the server answers (ADR 0015, section
     * 7). Absent before schema 2: such a server answers schema 1 only.
     */
    public var dashboardSchemas: [Int]?

    public init(
        product: String, deviceApiVersion: Int, version: String, pairingUrl: String, dashboardSchemas: [Int]? = nil
    ) {
        self.product = product
        self.deviceApiVersion = deviceApiVersion
        self.version = version
        self.pairingUrl = pairingUrl
        self.dashboardSchemas = dashboardSchemas
    }

    private enum CodingKeys: String, CodingKey { case product, deviceApiVersion, version, pairingUrl, dashboardSchemas }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        product = try c.decode(String.self, forKey: .product)
        deviceApiVersion = try c.decode(Int.self, forKey: .deviceApiVersion)
        version = try c.decode(String.self, forKey: .version)
        pairingUrl = try c.decode(String.self, forKey: .pairingUrl)
        // A shape this build does not understand means: schema 1 only.
        dashboardSchemas = (try? c.decodeIfPresent([Int].self, forKey: .dashboardSchemas)) ?? nil
    }

    /** The newest dashboard schema both this app and the server speak. */
    public var preferredDashboardSchema: Int {
        let offered = Set(dashboardSchemas ?? [1])
        return supportedDashboardSchemas.first { offered.contains($0) } ?? 1
    }
}

/** POST /v1/device/pairings */
public struct CreatePairingResponse: Codable, Sendable, Equatable {
    public var pairingId: String
    /** Shown on the TV as XXXX-XXXX. */
    public var code: String
    public var pollSecret: String
    public var expiresAt: String
    public var pollIntervalSeconds: Int
    public var pairingUrl: String
    /** pairingUrl with the code filled in, for the QR code. */
    public var approveUrl: String

    public init(
        pairingId: String, code: String, pollSecret: String, expiresAt: String,
        pollIntervalSeconds: Int, pairingUrl: String, approveUrl: String
    ) {
        self.pairingId = pairingId
        self.code = code
        self.pollSecret = pollSecret
        self.expiresAt = expiresAt
        self.pollIntervalSeconds = pollIntervalSeconds
        self.pairingUrl = pairingUrl
        self.approveUrl = approveUrl
    }
}

/** Body of POST /v1/device/pairings/poll */
public struct PollPairingRequest: Codable, Sendable, Equatable {
    public var pairingId: String
    public var pollSecret: String
}

public struct DeviceCredentials: Codable, Sendable, Equatable {
    public var accessToken: String
    public var accessTokenExpiresAt: String
    public var refreshToken: String
    public var refreshTokenExpiresAt: String

    public init(
        accessToken: String, accessTokenExpiresAt: String,
        refreshToken: String, refreshTokenExpiresAt: String
    ) {
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshToken = refreshToken
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }

    /** Whether every field is present (a damaged store means: pair again). */
    public var isComplete: Bool {
        !accessToken.isEmpty && !refreshToken.isEmpty
            && ISODate.parse(accessTokenExpiresAt) != nil
            && ISODate.parse(refreshTokenExpiresAt) != nil
    }
}

public struct DeviceSummary: Codable, Sendable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/** POST /v1/device/pairings/poll: pending, or approved with credentials. */
public enum PollPairingResponse: Codable, Sendable, Equatable {
    case pending(expiresAt: String)
    case approved(device: DeviceSummary, credentials: DeviceCredentials)

    private enum CodingKeys: String, CodingKey {
        case status, expiresAt, device, credentials
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "pending":
            self = .pending(expiresAt: try container.decode(String.self, forKey: .expiresAt))
        case "approved":
            self = .approved(
                device: try container.decode(DeviceSummary.self, forKey: .device),
                credentials: try container.decode(DeviceCredentials.self, forKey: .credentials)
            )
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: container, debugDescription: "Unknown status \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pending(let expiresAt):
            try container.encode("pending", forKey: .status)
            try container.encode(expiresAt, forKey: .expiresAt)
        case .approved(let device, let credentials):
            try container.encode("approved", forKey: .status)
            try container.encode(device, forKey: .device)
            try container.encode(credentials, forKey: .credentials)
        }
    }
}

/** Body of POST /v1/device/token */
public struct RefreshDeviceTokenRequest: Codable, Sendable, Equatable {
    public var refreshToken: String
}

/** POST /v1/device/token */
public struct RefreshDeviceTokenResponse: Codable, Sendable, Equatable {
    public var credentials: DeviceCredentials
}

/** GET /v1/device/me */
public struct DeviceSelfResponse: Codable, Sendable, Equatable {
    public struct Device: Codable, Sendable, Equatable {
        public var id: String
        public var name: String
        public var dashboardId: String?
    }

    public var device: Device
}

/// An enum from the API that tolerates values a newer server may add.
public protocol OpenAPIEnum: RawRepresentable, Codable, Sendable, Equatable
where RawValue == String {
    static var fallback: Self { get }
}

extension OpenAPIEnum {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }
}

public enum MetricPeriod: String, OpenAPIEnum {
    case today
    case last7Days = "last_7_days"
    case last30Days = "last_30_days"
    case thisMonth = "this_month"
    case last90Days = "last_90_days"
    case last12Months = "last_12_months"
    // A period a newer server adds: no period label, "vs previous period".
    case unknown

    public static var fallback: MetricPeriod { .unknown }
}

public enum MetricAggregation: String, OpenAPIEnum {
    case sum, avg, min, max, last, unknown

    public static var fallback: MetricAggregation { .unknown }
}

/**
 * How a tile's numbers can be trusted: ok (fresh), stale, auth_failed and
 * outage (the connection is failing), no_data (nothing to show).
 */
public enum DeviceTileStatus: String, OpenAPIEnum {
    case ok, stale
    case authFailed = "auth_failed"
    case outage
    case noData = "no_data"

    // An unknown status shows the numbers without a notice.
    public static var fallback: DeviceTileStatus { .ok }
}

public struct TileChange: Codable, Sendable, Equatable {
    public var previousValue: Double?
    /** value − previousValue; null when there is nothing to compare. */
    public var delta: Double?
    /** delta ÷ |previousValue|; null against zero or missing data. */
    public var ratio: Double?

    public init(previousValue: Double?, delta: Double?, ratio: Double?) {
        self.previousValue = previousValue
        self.delta = delta
        self.ratio = ratio
    }

    private enum CodingKeys: String, CodingKey { case previousValue, delta, ratio }

    public func encode(to encoder: Encoder) throws {
        // Explicit nulls, as the server sends them.
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(previousValue, forKey: .previousValue)
        try container.encode(delta, forKey: .delta)
        try container.encode(ratio, forKey: .ratio)
    }
}

/**
 * How a converted amount came about (#191): the value is in
 * `displayCurrency`, approximately, at ECB reference rates; amounts in
 * `unconverted` currencies are not part of it. Absent from older servers.
 */
public struct TileConversion: Codable, Sendable, Equatable {
    public struct Unconverted: Codable, Sendable, Equatable {
        public var currency: String
        /** Minor units of `currency`; null without data this period. */
        public var value: Double?

        public init(currency: String, value: Double?) {
            self.currency = currency
            self.value = value
        }
    }

    public var displayCurrency: String
    /** E.g. "ECB euro foreign exchange reference rates". */
    public var source: String
    public var unconverted: [Unconverted]

    public init(displayCurrency: String, source: String, unconverted: [Unconverted]) {
        self.displayCurrency = displayCurrency
        self.source = source
        self.unconverted = unconverted
    }
}

public struct DeviceTile: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    /** Raw number; formatted with `unit`. Null without data. */
    public var value: Double?
    /** "count", "percent", "<ISO 4217>_minor", …; null when the tile could not load. */
    public var unit: String?
    public var change: TileChange
    /** One point per bucket, oldest first; null = gap. */
    public var spark: [Double?]
    public var status: DeviceTileStatus
    /** The connection's last successful sync. */
    public var updatedAt: String?
    /** Set when the value was converted into a display currency (#191). */
    public var conversion: TileConversion?

    public init(
        id: String, label: String, period: MetricPeriod, aggregation: MetricAggregation,
        value: Double?, unit: String?, change: TileChange, spark: [Double?],
        status: DeviceTileStatus, updatedAt: String?, conversion: TileConversion? = nil
    ) {
        self.id = id
        self.label = label
        self.period = period
        self.aggregation = aggregation
        self.value = value
        self.unit = unit
        self.change = change
        self.spark = spark
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, period, aggregation, value, unit, change, spark, status, updatedAt, conversion
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        period = try container.decode(MetricPeriod.self, forKey: .period)
        aggregation = try container.decode(MetricAggregation.self, forKey: .aggregation)
        value = try container.decodeIfPresent(Double.self, forKey: .value)
        unit = try container.decodeIfPresent(String.self, forKey: .unit)
        change = try container.decode(TileChange.self, forKey: .change)
        spark = try container.decode([Double?].self, forKey: .spark)
        status = try container.decode(DeviceTileStatus.self, forKey: .status)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        // Optional extra (#191): absent from older servers, and a shape this
        // build does not understand only drops the marking, never the tile.
        conversion = (try? container.decodeIfPresent(TileConversion.self, forKey: .conversion)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        try container.encode(period.rawValue, forKey: .period)
        try container.encode(aggregation.rawValue, forKey: .aggregation)
        try container.encode(value, forKey: .value)
        try container.encode(unit, forKey: .unit)
        try container.encode(change, forKey: .change)
        try container.encode(spark, forKey: .spark)
        try container.encode(status.rawValue, forKey: .status)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(conversion, forKey: .conversion)
    }
}

/** GET /v1/device/dashboard */
public struct DeviceDashboard: Codable, Sendable, Equatable {
    public struct Info: Codable, Sendable, Equatable {
        public var id: String
        public var name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    /** Hash of the content; also the ETag. */
    public var version: String
    public var refreshAfterSec: Int
    /** The workspace's time zone, which the buckets follow. */
    public var timeZone: String
    /** Null when no dashboard is assigned; tiles is then empty. */
    public var dashboard: Info?
    public var tiles: [DeviceTile]

    public init(version: String, refreshAfterSec: Int, timeZone: String, dashboard: Info?, tiles: [DeviceTile]) {
        self.version = version
        self.refreshAfterSec = refreshAfterSec
        self.timeZone = timeZone
        self.dashboard = dashboard
        self.tiles = tiles
    }

    private enum CodingKeys: String, CodingKey { case version, refreshAfterSec, timeZone, dashboard, tiles }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(refreshAfterSec, forKey: .refreshAfterSec)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encode(dashboard, forKey: .dashboard)
        try container.encode(tiles, forKey: .tiles)
    }
}

/** Body of POST /v1/device/heartbeat */
public struct DeviceHeartbeatRequest: Codable, Sendable, Equatable {
    public var appVersion: String
    public var uptimeSeconds: Int
    public var lastError: String?

    public init(appVersion: String, uptimeSeconds: Int, lastError: String?) {
        self.appVersion = appVersion
        self.uptimeSeconds = uptimeSeconds
        self.lastError = lastError
    }

    private enum CodingKeys: String, CodingKey { case appVersion, uptimeSeconds, lastError }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(uptimeSeconds, forKey: .uptimeSeconds)
        try container.encode(lastError, forKey: .lastError)
    }
}

/** ISO 8601 timestamps as the API writes them (with or without milliseconds). */
public enum ISODate {
    public static func parse(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }

    public static func format(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
