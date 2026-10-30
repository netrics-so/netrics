import Foundation

// Device payload schema 2 (ADR 0015, section 7; deviceDashboardV2ResponseSchema
// in packages/contracts): slides of widgets on the 12 × 8 grid, the resolved
// theme, rotation and the images the dashboard references.
//
// Schema 3 (ADR 0017, section 9; deviceDashboardV3ResponseSchema) is schema
// 2's content plus the dashboard's primary format (widgets are placed in
// its grid), the custom layouts per slide and format, and this device's
// settings (rotation, display mode). The same type reads both; a schema 2
// payload is a `16x9` dashboard without custom layouts, rotation 0.
//
// Decoding is tolerant, as for schema 1: unknown fields are ignored, an
// unknown widget type (a newer server) or a widget whose fields this build
// cannot read becomes `.unsupported` and renders as an empty themed cell,
// and a damaged slide, widget or image entry is dropped instead of failing
// the whole payload. Only the envelope (version, slides) is required.

/** The payload schemas this app can render, newest first. */
public let supportedDashboardSchemas: [Int] = [3, 2, 1]

// MARK: Lossy containers

/** Decodes an array element by element, dropping the ones that fail. */
struct LossyArray<Element: Decodable>: Decodable {
    var elements: [Element]

    private struct Skip: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else {
                _ = try? container.decode(Skip.self)
            }
        }
        self.elements = elements
    }
}

extension KeyedDecodingContainer {
    /** The value, or nil when it is absent, null or of another shape. */
    func lenient<Value: Decodable>(_ type: Value.Type, _ key: Key) -> Value? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }

    func lossyArray<Value: Decodable>(_ type: Value.Type, _ key: Key) -> [Value] {
        lenient(LossyArray<Value>.self, key)?.elements ?? []
    }
}

// MARK: Theme

/** Which way is good for a change (metricBetterSchema). */
public enum MetricBetter: String, OpenAPIEnum {
    case higher, lower
    public static var fallback: MetricBetter { .higher }
}

public enum SlideTransition: String, OpenAPIEnum {
    case none, fade
    public static var fallback: SlideTransition { .fade }
}

/**
 * The theme's tokens as `#rrggbb` (ADR 0015, section 6). A token that is
 * missing or not a colour takes netrics Dark's value, so a newer or damaged
 * theme still renders readably.
 */
public struct ThemeTokens: Codable, Sendable, Equatable {
    public var background: String
    public var surface: String
    public var border: String
    public var text: String
    public var label: String
    public var muted: String
    public var accent: String
    public var up: String
    public var down: String
    public var warning: String
    public var chartLine: String
    public var chartFill: String
    /** 1, 1.15 or 1.3; never lowers a minimum (StudioLayout.effectiveFontScale). */
    public var fontScale: Double

    /** netrics Dark: today's TV palette and the default theme. */
    public static let netricsDark = ThemeTokens(
        background: "#07090c", surface: "#11141a", border: "#23272e", text: "#e6e9ed",
        label: "#c5cad3", muted: "#8a919c", accent: "#7aa2f7", up: "#9fd6a8", down: "#f0a3a3",
        warning: "#e3b341", chartLine: "#7aa2f7", chartFill: "#7aa2f7", fontScale: 1)

    public init(
        background: String, surface: String, border: String, text: String, label: String, muted: String,
        accent: String, up: String, down: String, warning: String, chartLine: String, chartFill: String,
        fontScale: Double
    ) {
        self.background = background
        self.surface = surface
        self.border = border
        self.text = text
        self.label = label
        self.muted = muted
        self.accent = accent
        self.up = up
        self.down = down
        self.warning = warning
        self.chartLine = chartLine
        self.chartFill = chartFill
        self.fontScale = fontScale
    }

    private enum CodingKeys: String, CodingKey {
        case background, surface, border, text, label, muted, accent, up, down, warning, chartLine, chartFill,
            fontScale
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self.netricsDark
        func color(_ key: CodingKeys, _ fallback: String) -> String {
            guard let value = c.lenient(String.self, key), ThemeColor.parse(value) != nil else { return fallback }
            return value.lowercased()
        }
        background = color(.background, d.background)
        surface = color(.surface, d.surface)
        border = color(.border, d.border)
        text = color(.text, d.text)
        label = color(.label, d.label)
        muted = color(.muted, d.muted)
        accent = color(.accent, d.accent)
        up = color(.up, d.up)
        down = color(.down, d.down)
        warning = color(.warning, d.warning)
        chartLine = color(.chartLine, d.chartLine)
        chartFill = color(.chartFill, d.chartFill)
        fontScale = StudioLayout.effectiveFontScale(c.lenient(Double.self, .fontScale))
    }
}

/** An sRGB colour from `#rrggbb`, components 0–1. */
public struct ThemeColor: Sendable, Equatable {
    public var red: Double
    public var green: Double
    public var blue: Double

    public static func parse(_ hex: String) -> ThemeColor? {
        let text = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
        guard text.count == 6, text.allSatisfy(\.isHexDigit), let value = UInt32(text, radix: 16) else {
            return nil
        }
        return ThemeColor(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255)
    }
}

public struct DashboardTheme: Codable, Sendable, Equatable {
    public var name: String
    public var tokens: ThemeTokens

    public init(name: String, tokens: ThemeTokens) {
        self.name = name
        self.tokens = tokens
    }

    public static let fallback = DashboardTheme(name: "netrics Dark", tokens: .netricsDark)

    private enum CodingKeys: String, CodingKey { case name, tokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(String.self, .name) ?? Self.fallback.name
        tokens = c.lenient(ThemeTokens.self, .tokens) ?? .netricsDark
    }
}

public struct SlideRotationSettings: Codable, Sendable, Equatable {
    /** False: only the first slide is shown. */
    public var autoAdvance: Bool
    public var transition: SlideTransition

    public init(autoAdvance: Bool = true, transition: SlideTransition = .fade) {
        self.autoAdvance = autoAdvance
        self.transition = transition
    }

    private enum CodingKeys: String, CodingKey { case autoAdvance, transition }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        autoAdvance = c.lenient(Bool.self, .autoAdvance) ?? true
        transition = c.lenient(SlideTransition.self, .transition) ?? .fade
    }
}

// MARK: Widget options

public enum WidgetAlign: String, OpenAPIEnum {
    case start, center, end
    public static var fallback: WidgetAlign { .start }
}

public struct MetricWidgetOptions: Codable, Sendable, Equatable {
    public var showSparkline = true
    public var showChange = true

    public init(showSparkline: Bool = true, showChange: Bool = true) {
        self.showSparkline = showSparkline
        self.showChange = showChange
    }

    private enum CodingKeys: String, CodingKey { case showSparkline, showChange }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showSparkline = c.lenient(Bool.self, .showSparkline) ?? true
        showChange = c.lenient(Bool.self, .showChange) ?? true
    }
}

public struct LineWidgetOptions: Codable, Sendable, Equatable {
    public var showPrevious = true
    public var showAxis = true

    public init(showPrevious: Bool = true, showAxis: Bool = true) {
        self.showPrevious = showPrevious
        self.showAxis = showAxis
    }

    private enum CodingKeys: String, CodingKey { case showPrevious, showAxis }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showPrevious = c.lenient(Bool.self, .showPrevious) ?? true
        showAxis = c.lenient(Bool.self, .showAxis) ?? true
    }
}

public struct BarWidgetOptions: Codable, Sendable, Equatable {
    public var groupBy: String
    public var limit: Int

    public init(groupBy: String = "resource", limit: Int = 5) {
        self.groupBy = groupBy
        self.limit = limit
    }

    private enum CodingKeys: String, CodingKey { case groupBy, limit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groupBy = c.lenient(String.self, .groupBy) ?? "resource"
        limit = c.lenient(Int.self, .limit) ?? 5
    }
}

/** A table's options (ADR 0019 section 6). */
public struct TableWidgetOptions: Codable, Sendable, Equatable {
    public var groupBy: String
    public var limit: Int
    public var showChange: Bool
    public var showOthers: Bool

    public init(groupBy: String = "resource", limit: Int = 5, showChange: Bool = true, showOthers: Bool = false) {
        self.groupBy = groupBy
        self.limit = limit
        self.showChange = showChange
        self.showOthers = showOthers
    }

    private enum CodingKeys: String, CodingKey { case groupBy, limit, showChange, showOthers }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groupBy = c.lenient(String.self, .groupBy) ?? "resource"
        limit = min(max(c.lenient(Int.self, .limit) ?? 5, 1), 10)
        showChange = c.lenient(Bool.self, .showChange) ?? true
        showOthers = c.lenient(Bool.self, .showOthers) ?? false
    }
}

/** A compare widget's options (ADR 0019 section 10). */
public struct CompareWidgetOptions: Codable, Sendable, Equatable {
    public var format: CompareFormat
    /** Beside the ratio ("conversion"); nil shows the localized "ratio". */
    public var ratioLabel: String?
    public var showChange: Bool

    public init(format: CompareFormat = .percent, ratioLabel: String? = nil, showChange: Bool = true) {
        self.format = format
        self.ratioLabel = ratioLabel
        self.showChange = showChange
    }

    private enum CodingKeys: String, CodingKey { case format, ratioLabel, showChange }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = c.lenient(CompareFormat.self, .format) ?? .percent
        ratioLabel = c.lenient(String.self, .ratioLabel).flatMap { $0.isEmpty ? nil : $0 }
        showChange = c.lenient(Bool.self, .showChange) ?? true
    }
}

public enum ImageFit: String, OpenAPIEnum {
    case contain, cover
    public static var fallback: ImageFit { .contain }
}

public struct ImageWidgetOptions: Codable, Sendable, Equatable {
    public var fit: ImageFit
    public var align: WidgetAlign

    public init(fit: ImageFit = .contain, align: WidgetAlign = .center) {
        self.fit = fit
        self.align = align
    }

    private enum CodingKeys: String, CodingKey { case fit, align }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fit = c.lenient(ImageFit.self, .fit) ?? .contain
        align = c.lenient(WidgetAlign.self, .align) ?? .center
    }
}

public struct TextWidgetOptions: Codable, Sendable, Equatable {
    public var size: StudioTextSize
    public var align: WidgetAlign

    public init(size: StudioTextSize = .body, align: WidgetAlign = .start) {
        self.size = size
        self.align = align
    }

    private enum CodingKeys: String, CodingKey { case size, align }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        size = c.lenient(String.self, .size).flatMap(StudioTextSize.init(rawValue:)) ?? .body
        align = c.lenient(WidgetAlign.self, .align) ?? .start
    }
}

/**
 * A countdown's options (ADR 0019 section 8) as the server resolves them:
 * the zone and `targetAt`, the target as an instant. Screens count down to
 * `targetAt` from their own clock.
 */
public struct CountdownWidgetOptions: Codable, Sendable, Equatable {
    /** The local target as set, "YYYY-MM-DDTHH:mm". */
    public var target: String
    /** The target's zone, resolved by the server. */
    public var timeZone: String?
    public var targetAt: Date
    /** The target line below the time left. */
    public var showTarget: Bool
    /** Shown at the target; nil shows "Now" in the screen's language. */
    public var doneText: String?

    public init(
        target: String, timeZone: String? = nil, targetAt: Date, showTarget: Bool = true, doneText: String? = nil
    ) {
        self.target = target
        self.timeZone = timeZone
        self.targetAt = targetAt
        self.showTarget = showTarget
        self.doneText = doneText
    }

    private enum CodingKeys: String, CodingKey { case target, timeZone, targetAt, showTarget, doneText }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = c.lenient(String.self, .target) ?? ""
        timeZone = c.lenient(String.self, .timeZone)
        // Without a readable instant the widget is an empty themed cell.
        guard let at = c.lenient(String.self, .targetAt).flatMap(ISODate.parse) else {
            throw DecodingError.dataCorruptedError(
                forKey: .targetAt, in: c, debugDescription: "countdown without targetAt")
        }
        targetAt = at
        showTarget = c.lenient(Bool.self, .showTarget) ?? true
        let text = c.lenient(String.self, .doneText)?.trimmingCharacters(in: .whitespacesAndNewlines)
        doneText = text?.isEmpty == false ? text : nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(target, forKey: .target)
        try c.encodeIfPresent(timeZone, forKey: .timeZone)
        try c.encode(ISODate.format(targetAt), forKey: .targetAt)
        try c.encode(showTarget, forKey: .showTarget)
        try c.encodeIfPresent(doneText, forKey: .doneText)
    }
}

public struct ClockWidgetOptions: Codable, Sendable, Equatable {
    public var showDate: Bool
    public var hour12: Bool
    /** Resolved by the server; nil falls back to the workspace's zone. */
    public var timeZone: String?
    /** Short ("Sat 4 Oct") or long ("Saturday, 4 October"); unknown → short. */
    public var dateStyle: ClockDateStyle
    /** The zone line ("Berlin · UTC+2"). */
    public var showZone: Bool

    public init(
        showDate: Bool = true, hour12: Bool = false, timeZone: String? = nil, dateStyle: ClockDateStyle = .short,
        showZone: Bool = false
    ) {
        self.showDate = showDate
        self.hour12 = hour12
        self.timeZone = timeZone
        self.dateStyle = dateStyle
        self.showZone = showZone
    }

    private enum CodingKeys: String, CodingKey { case showDate, hour12, timeZone, dateStyle, showZone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showDate = c.lenient(Bool.self, .showDate) ?? true
        hour12 = c.lenient(Bool.self, .hour12) ?? false
        timeZone = c.lenient(String.self, .timeZone)
        dateStyle = c.lenient(String.self, .dateStyle).flatMap(ClockDateStyle.init(rawValue:)) ?? .short
        showZone = c.lenient(Bool.self, .showZone) ?? false
    }
}

// MARK: Widget data

/** A metric widget's data: a schema 1 tile without id and label. */
public struct MetricWidgetData: Codable, Sendable, Equatable {
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    public var value: Double?
    public var unit: String?
    public var change: TileChange
    public var spark: [Double?]
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?
    public var better: MetricBetter

    public init(
        period: MetricPeriod, aggregation: MetricAggregation, value: Double?, unit: String?, change: TileChange,
        spark: [Double?], status: DeviceTileStatus, updatedAt: String?, conversion: TileConversion? = nil,
        better: MetricBetter = .higher
    ) {
        self.period = period
        self.aggregation = aggregation
        self.value = value
        self.unit = unit
        self.change = change
        self.spark = spark
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
        self.better = better
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, value, unit, change, spark, status, updatedAt, conversion, better
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period) ?? .unknown
        aggregation = c.lenient(MetricAggregation.self, .aggregation) ?? .unknown
        value = c.lenient(Double.self, .value)
        unit = c.lenient(String.self, .unit)
        change = c.lenient(TileChange.self, .change) ?? TileChange(previousValue: nil, delta: nil, ratio: nil)
        spark = c.lenient([Double?].self, .spark) ?? []
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
        better = c.lenient(MetricBetter.self, .better) ?? .higher
    }

    /** The same numbers as a schema 1 tile, for the shared formatting. */
    public func tile(id: String, label: String) -> DeviceTile {
        DeviceTile(
            id: id, label: label, period: period, aggregation: aggregation, value: value, unit: unit,
            change: change, spark: spark, status: status, updatedAt: updatedAt, conversion: conversion)
    }
}

/**
 * A line widget's data: `buckets[i]` starts point i, `values[i]` is its
 * value and `previous[i]` the previous period's (empty when hidden). Null
 * is a gap.
 */
public struct LineWidgetData: Codable, Sendable, Equatable {
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    public var value: Double?
    public var unit: String?
    public var change: TileChange
    public var buckets: [String]
    public var values: [Double?]
    public var previous: [Double?]
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?
    public var better: MetricBetter

    public init(
        period: MetricPeriod, aggregation: MetricAggregation, value: Double?, unit: String?, change: TileChange,
        buckets: [String], values: [Double?], previous: [Double?], status: DeviceTileStatus, updatedAt: String?,
        conversion: TileConversion? = nil, better: MetricBetter = .higher
    ) {
        self.period = period
        self.aggregation = aggregation
        self.value = value
        self.unit = unit
        self.change = change
        self.buckets = buckets
        self.values = values
        self.previous = previous
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
        self.better = better
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, value, unit, change, buckets, values, previous, status, updatedAt, conversion,
            better
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period) ?? .unknown
        aggregation = c.lenient(MetricAggregation.self, .aggregation) ?? .unknown
        value = c.lenient(Double.self, .value)
        unit = c.lenient(String.self, .unit)
        change = c.lenient(TileChange.self, .change) ?? TileChange(previousValue: nil, delta: nil, ratio: nil)
        buckets = c.lenient([String].self, .buckets) ?? []
        values = c.lenient([Double?].self, .values) ?? []
        previous = c.lenient([Double?].self, .previous) ?? []
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
        better = c.lenient(MetricBetter.self, .better) ?? .higher
    }
}

public struct BarEntry: Codable, Sendable, Equatable {
    public var key: String?
    public var label: String
    public var value: Double

    public init(key: String? = nil, label: String, value: Double) {
        self.key = key
        self.label = label
        self.value = value
    }
}

public struct BarOthers: Codable, Sendable, Equatable {
    public var label: String
    public var value: Double
    public var groups: Int?

    public init(label: String, value: Double, groups: Int? = nil) {
        self.label = label
        self.value = value
        self.groups = groups
    }
}

/** A bar widget's data: the largest groups, largest first, and the rest. */
public struct BarWidgetData: Codable, Sendable, Equatable {
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    public var unit: String?
    public var groupBy: String?
    public var bars: [BarEntry]
    public var others: BarOthers?
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?

    public init(
        period: MetricPeriod, aggregation: MetricAggregation, unit: String?, groupBy: String?, bars: [BarEntry],
        others: BarOthers?, status: DeviceTileStatus, updatedAt: String?, conversion: TileConversion? = nil
    ) {
        self.period = period
        self.aggregation = aggregation
        self.unit = unit
        self.groupBy = groupBy
        self.bars = bars
        self.others = others
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, unit, groupBy, bars, others, status, updatedAt, conversion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period) ?? .unknown
        aggregation = c.lenient(MetricAggregation.self, .aggregation) ?? .unknown
        unit = c.lenient(String.self, .unit)
        groupBy = c.lenient(String.self, .groupBy)
        bars = c.lossyArray(BarEntry.self, .bars)
        others = c.lenient(BarOthers.self, .others)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
    }
}

/** A table's column heads in the payload's language. */
public struct TableColumnHeads: Codable, Sendable, Equatable {
    public var label: String
    public var value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case label, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.lenient(String.self, .label) ?? ""
        value = c.lenient(String.self, .value) ?? ""
    }
}

/** A table row: a group's value and its value over the previous window. */
public struct TableRow: Codable, Sendable, Equatable {
    public var key: String?
    public var label: String
    public var value: Double
    public var previousValue: Double?
    public var ratio: Double?

    public init(key: String? = nil, label: String, value: Double, previousValue: Double? = nil, ratio: Double? = nil) {
        self.key = key
        self.label = label
        self.value = value
        self.previousValue = previousValue
        self.ratio = ratio
    }
}

/** A table widget's data (ADR 0019 section 6). */
public struct TableWidgetData: Codable, Sendable, Equatable {
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    public var unit: String?
    public var groupBy: String?
    public var columns: TableColumnHeads
    public var rows: [TableRow]
    public var others: BarOthers?
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?
    public var better: MetricBetter

    public init(
        period: MetricPeriod, aggregation: MetricAggregation, unit: String?, groupBy: String?,
        columns: TableColumnHeads, rows: [TableRow], others: BarOthers?, status: DeviceTileStatus,
        updatedAt: String?, conversion: TileConversion? = nil, better: MetricBetter = .higher
    ) {
        self.period = period
        self.aggregation = aggregation
        self.unit = unit
        self.groupBy = groupBy
        self.columns = columns
        self.rows = rows
        self.others = others
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
        self.better = better
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, unit, groupBy, columns, rows, others, status, updatedAt, conversion, better
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period) ?? .unknown
        aggregation = c.lenient(MetricAggregation.self, .aggregation) ?? .unknown
        unit = c.lenient(String.self, .unit)
        groupBy = c.lenient(String.self, .groupBy)
        columns = c.lenient(TableColumnHeads.self, .columns) ?? TableColumnHeads(label: "", value: "")
        rows = c.lossyArray(TableRow.self, .rows)
        others = c.lenient(BarOthers.self, .others)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
        better = c.lenient(MetricBetter.self, .better) ?? .higher
    }
}

/** A status board's options (ADR 0019 section 7). */
public struct StatusWidgetOptions: Codable, Sendable, Equatable {
    /** nil: every source of the workspace. */
    public var connectionIds: [String]?
    public var showAge: Bool

    public init(connectionIds: [String]? = nil, showAge: Bool = true) {
        self.connectionIds = connectionIds
        self.showAge = showAge
    }

    private enum CodingKeys: String, CodingKey { case connectionIds, showAge }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionIds = c.lenient([String].self, .connectionIds)
        showAge = c.lenient(Bool.self, .showAge) ?? true
    }
}

/** A source's health on a status board; an unknown one shows a muted dot. */
public enum StatusItemStatus: String, OpenAPIEnum {
    case ok, stale, backfilling
    case authFailed = "auth_failed"
    case outage

    public static var fallback: StatusItemStatus { .backfilling }
}

/** One source on a status board. */
public struct StatusItem: Codable, Sendable, Equatable {
    public var connectionId: String
    public var name: String
    public var status: StatusItemStatus
    /** The last successful sync (ISO 8601); the age is computed on screen. */
    public var lastSuccessAt: String?

    public init(connectionId: String, name: String, status: StatusItemStatus, lastSuccessAt: String?) {
        self.connectionId = connectionId
        self.name = name
        self.status = status
        self.lastSuccessAt = lastSuccessAt
    }

    private enum CodingKeys: String, CodingKey { case connectionId, name, status, lastSuccessAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionId = try c.decode(String.self, forKey: .connectionId)
        name = try c.decode(String.self, forKey: .name)
        status = c.lenient(StatusItemStatus.self, .status) ?? .fallback
        lastSuccessAt = c.lenient(String.self, .lastSuccessAt)
    }
}

/** A status board's data: attention first, then by name (the server sorts). */
public struct StatusWidgetData: Codable, Sendable, Equatable {
    public var status: DeviceTileStatus
    public var items: [StatusItem]

    public init(status: DeviceTileStatus = .ok, items: [StatusItem]) {
        self.status = status
        self.items = items
    }

    private enum CodingKeys: String, CodingKey { case status, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        items = c.lossyArray(StatusItem.self, .items)
    }
}

/** One side of a compare widget: its metric's name, value and unit. */
public struct CompareOperand: Codable, Sendable, Equatable {
    public var label: String
    public var value: Double?
    public var unit: String?

    public init(label: String, value: Double?, unit: String?) {
        self.label = label
        self.value = value
        self.unit = unit
    }

    private enum CodingKeys: String, CodingKey { case label, value, unit }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.lenient(String.self, .label) ?? ""
        value = c.lenient(Double.self, .value)
        unit = c.lenient(String.self, .unit)
    }
}

/** A compare widget's ratio: A ÷ B now and over the previous period. */
public struct CompareRatio: Codable, Sendable, Equatable {
    public var value: Double?
    public var previousValue: Double?
    public var format: CompareFormat

    public init(value: Double?, previousValue: Double?, format: CompareFormat) {
        self.value = value
        self.previousValue = previousValue
        self.format = format
    }

    private enum CodingKeys: String, CodingKey { case value, previousValue, format }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = c.lenient(Double.self, .value).flatMap { $0.isFinite ? $0 : nil }
        previousValue = c.lenient(Double.self, .previousValue).flatMap { $0.isFinite ? $0 : nil }
        format = c.lenient(CompareFormat.self, .format) ?? .percent
    }
}

/**
 * A compare widget's data (ADR 0019 section 10). `unit` is the ratio's: nil
 * (unitless) or the currency of an amount per unit ("EUR_minor").
 */
public struct CompareWidgetData: Codable, Sendable, Equatable {
    public var period: MetricPeriod
    public var aggregation: MetricAggregation
    public var unit: String?
    public var numerator: CompareOperand
    public var denominator: CompareOperand
    public var ratio: CompareRatio
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?
    public var better: MetricBetter

    public init(
        period: MetricPeriod, aggregation: MetricAggregation, unit: String?, numerator: CompareOperand,
        denominator: CompareOperand, ratio: CompareRatio, status: DeviceTileStatus, updatedAt: String?,
        conversion: TileConversion? = nil, better: MetricBetter = .higher
    ) {
        self.period = period
        self.aggregation = aggregation
        self.unit = unit
        self.numerator = numerator
        self.denominator = denominator
        self.ratio = ratio
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
        self.better = better
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, unit, numerator, denominator, ratio, status, updatedAt, conversion, better
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period) ?? .unknown
        aggregation = c.lenient(MetricAggregation.self, .aggregation) ?? .unknown
        unit = c.lenient(String.self, .unit)
        numerator = c.lenient(CompareOperand.self, .numerator) ?? CompareOperand(label: "", value: nil, unit: nil)
        denominator =
            c.lenient(CompareOperand.self, .denominator) ?? CompareOperand(label: "", value: nil, unit: nil)
        ratio = c.lenient(CompareRatio.self, .ratio) ?? CompareRatio(value: nil, previousValue: nil, format: .percent)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
        better = c.lenient(MetricBetter.self, .better) ?? .higher
    }
}

/** A goal widget's options (ADR 0019 section 5). */
public struct GaugeWidgetOptions: Codable, Sendable, Equatable {
    /** "9 days left" in progress, "2 days early" once reached. */
    public var showTimeLeft: Bool

    public init(showTimeLeft: Bool = true) {
        self.showTimeLeft = showTimeLeft
    }

    private enum CodingKeys: String, CodingKey { case showTimeLeft }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showTimeLeft = c.lenient(Bool.self, .showTimeLeft) ?? true
    }
}

/** The goal a goal widget shows. */
public struct GoalReference: Codable, Sendable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/**
 * A goal widget's data (ADR 0019 section 5): the goal's metric fields and
 * where the goal stands. `goal` nil: the goal was deleted ("Goal deleted").
 * Screens word the time left from `periodEnd`, `reachedAt` and their clock.
 */
public struct GaugeWidgetData: Codable, Sendable, Equatable {
    /** The goal's period; nil when the goal was deleted. */
    public var period: MetricPeriod?
    public var aggregation: MetricAggregation?
    public var unit: String?
    public var status: DeviceTileStatus
    public var updatedAt: String?
    public var conversion: TileConversion?
    public var better: MetricBetter
    public var goal: GoalReference?
    public var value: Double?
    public var target: Double?
    /** value ÷ target, not clipped. */
    public var progress: Double?
    public var reachedAt: String?
    /** Exclusive end of the period, ISO 8601 with the zone's offset. */
    public var periodEnd: String?

    public init(
        period: MetricPeriod?, aggregation: MetricAggregation?, unit: String?, status: DeviceTileStatus,
        updatedAt: String?, conversion: TileConversion? = nil, better: MetricBetter = .higher, goal: GoalReference?,
        value: Double?, target: Double?, progress: Double?, reachedAt: String?, periodEnd: String?
    ) {
        self.period = period
        self.aggregation = aggregation
        self.unit = unit
        self.status = status
        self.updatedAt = updatedAt
        self.conversion = conversion
        self.better = better
        self.goal = goal
        self.value = value
        self.target = target
        self.progress = progress
        self.reachedAt = reachedAt
        self.periodEnd = periodEnd
    }

    private enum CodingKeys: String, CodingKey {
        case period, aggregation, unit, status, updatedAt, conversion, better, goal, value, target, progress
        case reachedAt, periodEnd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = c.lenient(MetricPeriod.self, .period)
        aggregation = c.lenient(MetricAggregation.self, .aggregation)
        unit = c.lenient(String.self, .unit)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        conversion = c.lenient(TileConversion.self, .conversion)
        better = c.lenient(MetricBetter.self, .better) ?? .higher
        goal = c.lenient(GoalReference.self, .goal)
        value = c.lenient(Double.self, .value)
        target = c.lenient(Double.self, .target)
        progress = c.lenient(Double.self, .progress)
        reachedAt = c.lenient(String.self, .reachedAt)
        periodEnd = c.lenient(String.self, .periodEnd)
    }
}

/** A latest review's options (ADR 0019 section 12). */
public struct ReviewWidgetOptions: Codable, Sendable, Equatable {
    public var minRating: Int
    public var requireText: Bool
    public var showAuthor: Bool

    public init(minRating: Int = 1, requireText: Bool = true, showAuthor: Bool = true) {
        self.minRating = minRating
        self.requireText = requireText
        self.showAuthor = showAuthor
    }

    private enum CodingKeys: String, CodingKey { case minRating, requireText, showAuthor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        minRating = min(max(c.lenient(Int.self, .minRating) ?? 1, 1), 5)
        requireText = c.lenient(Bool.self, .requireText) ?? true
        showAuthor = c.lenient(Bool.self, .showAuthor) ?? true
    }
}

/** The review a latest-review widget shows. */
public struct WidgetReview: Codable, Sendable, Equatable {
    public var rating: Int
    public var title: String?
    public var body: String?
    /** The nickname; nil with "Show author" off. */
    public var author: String?
    /** ISO 3166-1 alpha-2. */
    public var territory: String?
    public var createdAt: String

    public init(
        rating: Int, title: String? = nil, body: String? = nil, author: String? = nil, territory: String? = nil,
        createdAt: String
    ) {
        self.rating = rating
        self.title = title
        self.body = body
        self.author = author
        self.territory = territory
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case rating, title, body, author, territory, createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rating = c.lenient(Int.self, .rating) ?? 0
        title = c.lenient(String.self, .title)
        body = c.lenient(String.self, .body)
        author = c.lenient(String.self, .author)
        territory = c.lenient(String.self, .territory)
        createdAt = c.lenient(String.self, .createdAt) ?? ""
    }
}

/** A latest-review widget's data (ADR 0019 section 12). */
public struct ReviewWidgetData: Codable, Sendable, Equatable {
    public var status: DeviceTileStatus
    public var updatedAt: String?
    /** Nil: no review matches (the status says why). */
    public var review: WidgetReview?

    public init(status: DeviceTileStatus, updatedAt: String? = nil, review: WidgetReview? = nil) {
        self.status = status
        self.updatedAt = updatedAt
        self.review = review
    }

    private enum CodingKeys: String, CodingKey { case status, updatedAt, review }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        updatedAt = c.lenient(String.self, .updatedAt)
        review = c.lenient(WidgetReview.self, .review)
    }
}

// MARK: Widgets and slides

public enum WidgetContent: Sendable, Equatable {
    case metric(MetricWidgetOptions, MetricWidgetData)
    case line(LineWidgetOptions, LineWidgetData)
    case bar(BarWidgetOptions, BarWidgetData)
    case table(TableWidgetOptions, TableWidgetData)
    /** The app's icon (one of the payload's images), options and data. */
    case review(imageId: String?, ReviewWidgetOptions, ReviewWidgetData)
    case status(StatusWidgetOptions, StatusWidgetData)
    case compare(CompareWidgetOptions, CompareWidgetData)
    case image(imageId: String, ImageWidgetOptions)
    case text(String, TextWidgetOptions)
    case clock(ClockWidgetOptions)
    case countdown(CountdownWidgetOptions)
    case gauge(GaugeWidgetOptions, GaugeWidgetData)
    /** A type this build does not know, or fields it cannot read. */
    case unsupported
}

public struct DeviceWidget: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /** As sent, also for types this build does not know. */
    public var type: String
    public var placement: StudioPlacement
    /** Data widgets: the resolved label ("Downloads · Wurfel"); others: the title or nil. */
    public var label: String?
    public var content: WidgetContent
    /**
     * The type's minimum size (schema 3, ADR 0019 section 2); nil on schema
     * 2 and older servers. A type this build does not know reflows with it.
     */
    public var minimum: StudioMinimum?

    public init(
        id: String, type: String, placement: StudioPlacement, label: String?, content: WidgetContent,
        minimum: StudioMinimum? = nil
    ) {
        self.id = id
        self.type = type
        self.placement = placement
        self.label = label
        self.content = content
        self.minimum = minimum
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, x, y, w, h, min, label, options, data, imageId, text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Without an id and a place on the grid a widget cannot be drawn.
        id = try c.decode(String.self, forKey: .id)
        placement = StudioPlacement(
            x: try c.decode(Int.self, forKey: .x), y: try c.decode(Int.self, forKey: .y),
            w: try c.decode(Int.self, forKey: .w), h: try c.decode(Int.self, forKey: .h))
        // Inside the largest grid here; the payload then keeps only the
        // widgets inside its primary format's grid (12 × 8 for schema 2).
        let largest = StudioLayout.screenFormatMaxGrid
        guard placement.x >= 0, placement.y >= 0, placement.w >= 1, placement.h >= 1,
            placement.x + placement.w <= largest.columns, placement.y + placement.h <= largest.rows
        else {
            throw DecodingError.dataCorruptedError(forKey: .x, in: c, debugDescription: "Outside the grid")
        }
        type = c.lenient(String.self, .type) ?? ""
        label = c.lenient(String.self, .label)
        content = Self.content(type: type, c)
        minimum = c.lenient(StudioMinimum.self, .min).flatMap { $0.w >= 1 && $0.h >= 1 ? $0 : nil }
    }

    private static func content(type: String, _ c: KeyedDecodingContainer<CodingKeys>) -> WidgetContent {
        switch type {
        case "metric":
            guard let data = c.lenient(MetricWidgetData.self, .data) else { return .unsupported }
            return .metric(c.lenient(MetricWidgetOptions.self, .options) ?? .init(), data)
        case "line":
            guard let data = c.lenient(LineWidgetData.self, .data) else { return .unsupported }
            return .line(c.lenient(LineWidgetOptions.self, .options) ?? .init(), data)
        case "bar":
            guard let data = c.lenient(BarWidgetData.self, .data) else { return .unsupported }
            return .bar(c.lenient(BarWidgetOptions.self, .options) ?? .init(), data)
        case "table":
            guard let data = c.lenient(TableWidgetData.self, .data) else { return .unsupported }
            return .table(c.lenient(TableWidgetOptions.self, .options) ?? .init(), data)
        case "status":
            guard let data = c.lenient(StatusWidgetData.self, .data) else { return .unsupported }
            return .status(c.lenient(StatusWidgetOptions.self, .options) ?? .init(), data)
        case "compare":
            guard let data = c.lenient(CompareWidgetData.self, .data) else { return .unsupported }
            return .compare(c.lenient(CompareWidgetOptions.self, .options) ?? .init(), data)
        case "review":
            guard let data = c.lenient(ReviewWidgetData.self, .data) else { return .unsupported }
            return .review(
                imageId: c.lenient(String.self, .imageId), c.lenient(ReviewWidgetOptions.self, .options) ?? .init(),
                data)
        case "image":
            guard let imageId = c.lenient(String.self, .imageId) else { return .unsupported }
            return .image(imageId: imageId, c.lenient(ImageWidgetOptions.self, .options) ?? .init())
        case "text":
            guard let text = c.lenient(String.self, .text) else { return .unsupported }
            return .text(text, c.lenient(TextWidgetOptions.self, .options) ?? .init())
        case "clock":
            return .clock(c.lenient(ClockWidgetOptions.self, .options) ?? .init())
        case "countdown":
            guard let options = c.lenient(CountdownWidgetOptions.self, .options) else { return .unsupported }
            return .countdown(options)
        case "gauge":
            guard let data = c.lenient(GaugeWidgetData.self, .data) else { return .unsupported }
            return .gauge(c.lenient(GaugeWidgetOptions.self, .options) ?? .init(), data)
        default:
            return .unsupported
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(placement.x, forKey: .x)
        try c.encode(placement.y, forKey: .y)
        try c.encode(placement.w, forKey: .w)
        try c.encode(placement.h, forKey: .h)
        try c.encodeIfPresent(minimum, forKey: .min)
        try c.encode(label, forKey: .label)
        switch content {
        case .metric(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .line(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .bar(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .table(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .status(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .compare(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .gauge(let options, let data):
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .review(let imageId, let options, let data):
            try c.encode(imageId, forKey: .imageId)
            try c.encode(options, forKey: .options)
            try c.encode(data, forKey: .data)
        case .image(let imageId, let options):
            try c.encode(imageId, forKey: .imageId)
            try c.encode(options, forKey: .options)
        case .text(let text, let options):
            try c.encode(text, forKey: .text)
            try c.encode(options, forKey: .options)
        case .clock(let options):
            try c.encode(options, forKey: .options)
        case .countdown(let options):
            try c.encode(options, forKey: .options)
        case .unsupported:
            break
        }
    }
}

public struct SlideBackground: Codable, Sendable, Equatable {
    public var imageId: String
    /** 0–80: per cent of the theme background laid over the image. */
    public var dim: Int

    public init(imageId: String, dim: Int) {
        self.imageId = imageId
        self.dim = dim
    }

    private enum CodingKeys: String, CodingKey { case imageId, dim }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        imageId = try c.decode(String.self, forKey: .imageId)
        dim = min(max(c.lenient(Int.self, .dim) ?? 40, 0), 100)
    }
}

public struct DeviceSlide: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String?
    public var durationSec: Int
    public var background: SlideBackground?
    public var widgets: [DeviceWidget]
    /** Schema 3: the custom layouts of formats other than the primary; the others are auto. */
    public var layouts: [DeviceSlideLayout]

    public init(
        id: String, name: String?, durationSec: Int, background: SlideBackground?, widgets: [DeviceWidget],
        layouts: [DeviceSlideLayout] = []
    ) {
        self.id = id
        self.name = name
        self.durationSec = durationSec
        self.background = background
        self.widgets = widgets
        self.layouts = layouts
    }

    /** The dashboard default (ADR 0015): used when a duration is missing. */
    public static let defaultDurationSec = 20

    private enum CodingKeys: String, CodingKey { case id, name, durationSec, background, widgets, layouts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name)
        let duration = c.lenient(Int.self, .durationSec) ?? Self.defaultDurationSec
        durationSec = duration > 0 ? duration : Self.defaultDurationSec
        background = c.lenient(SlideBackground.self, .background)
        widgets = c.lossyArray(DeviceWidget.self, .widgets)
        layouts = c.lossyArray(DeviceSlideLayout.self, .layouts)
    }

    /** The custom layout for `format`, if the slide has one. */
    public func layout(_ format: ScreenFormat) -> DeviceSlideLayout? {
        layouts.first { $0.format == format }
    }
}

/** A widget's place in a custom layout (deviceLayoutPlacementSchema). */
public struct DeviceLayoutPlacement: Codable, Sendable, Equatable {
    public var widgetId: String
    /** 0-based page (continuation pages). */
    public var page: Int
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    /** Not shown in this format. */
    public var hidden: Bool

    public init(widgetId: String, page: Int, x: Int, y: Int, w: Int, h: Int, hidden: Bool = false) {
        self.widgetId = widgetId
        self.page = page
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.hidden = hidden
    }

    private enum CodingKeys: String, CodingKey { case widgetId, page, x, y, w, h, hidden }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        widgetId = try c.decode(String.self, forKey: .widgetId)
        page = try c.decode(Int.self, forKey: .page)
        x = try c.decode(Int.self, forKey: .x)
        y = try c.decode(Int.self, forKey: .y)
        w = try c.decode(Int.self, forKey: .w)
        h = try c.decode(Int.self, forKey: .h)
        hidden = c.lenient(Bool.self, .hidden) ?? false
    }
}

/**
 * A slide's custom layout in one format (deviceSlideLayoutSchema). A
 * layout of a format this build does not know is dropped (that format is
 * never this screen's).
 */
public struct DeviceSlideLayout: Codable, Sendable, Equatable {
    public var format: ScreenFormat
    public var pages: Int
    public var placements: [DeviceLayoutPlacement]

    public init(format: ScreenFormat, pages: Int, placements: [DeviceLayoutPlacement]) {
        self.format = format
        self.pages = pages
        self.placements = placements
    }

    private enum CodingKeys: String, CodingKey { case format, pages, placements }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decode(ScreenFormat.self, forKey: .format)
        pages = c.lenient(Int.self, .pages) ?? 1
        placements = c.lossyArray(DeviceLayoutPlacement.self, .placements)
    }

    /** As the layout functions take it. */
    public var custom: CustomLayout {
        CustomLayout(
            pages: pages,
            placements: placements.map {
                CustomPlacement(
                    id: $0.widgetId, page: $0.page, x: $0.x, y: $0.y, w: $0.w, h: $0.h, hidden: $0.hidden,
                    autoPlaced: false)
            })
    }
}

/**
 * A device's rotation setting (ADR 0017, section 7): the whole rendering
 * after pairing turns by this many degrees, clockwise, so a TV mounted on
 * its side shows an upright dashboard. Anything else reads as 0.
 */
public enum ScreenRotation: Int, Codable, Sendable, Equatable, CaseIterable {
    case none = 0
    case quarter = 90
    case half = 180
    case threeQuarters = 270

    public init(from decoder: Decoder) throws {
        let value = try? decoder.singleValueContainer().decode(Int.self)
        self = value.flatMap(ScreenRotation.init(rawValue:)) ?? .none
    }

    /** A quarter turn either way: the screen's sides swap. */
    public var swapsSides: Bool { self == .quarter || self == .threeQuarters }

    /** The size the rendering has once turned: 1920 × 1080 at 90° is 1080 × 1920. */
    public func viewport(_ screen: StudioCanvas) -> StudioCanvas {
        swapsSides ? StudioCanvas(width: screen.height, height: screen.width) : screen
    }
}

/** Schema 3: this device's settings (#276). tvOS is always screen view. */
public struct DeviceDisplaySettings: Codable, Sendable, Equatable {
    public var rotation: ScreenRotation
    public var displayMode: DisplayMode

    public init(rotation: ScreenRotation = .none, displayMode: DisplayMode = .screen) {
        self.rotation = rotation
        self.displayMode = displayMode
    }

    private enum CodingKeys: String, CodingKey { case rotation, displayMode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rotation = c.lenient(ScreenRotation.self, .rotation) ?? .none
        displayMode = c.lenient(DisplayMode.self, .displayMode) ?? .screen
    }
}

/** An image the payload references; fetched with the device token. */
public struct DeviceImage: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /** Lower-case hex; the cache key. */
    public var sha256: String
    public var contentType: String
    public var width: Int
    public var height: Int
    public var bytes: Int
    /** Relative to the server: /v1/device/images/:id?v=<sha256>. */
    public var url: String

    public init(id: String, sha256: String, contentType: String, width: Int, height: Int, bytes: Int, url: String) {
        self.id = id
        self.sha256 = sha256
        self.contentType = contentType
        self.width = width
        self.height = height
        self.bytes = bytes
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case id, sha256, contentType, width, height, bytes, url }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let hash = try c.decode(String.self, forKey: .sha256).lowercased()
        // The hash names a file in the cache: nothing but 64 hex digits.
        guard hash.count == 64, hash.allSatisfy(\.isHexDigit) else {
            throw DecodingError.dataCorruptedError(forKey: .sha256, in: c, debugDescription: "Not a SHA-256")
        }
        sha256 = hash
        url = try c.decode(String.self, forKey: .url)
        contentType = c.lenient(String.self, .contentType) ?? "application/octet-stream"
        width = c.lenient(Int.self, .width) ?? 0
        height = c.lenient(Int.self, .height) ?? 0
        bytes = c.lenient(Int.self, .bytes) ?? 0
    }
}

/** GET /v1/device/dashboard?schema=2 and ?schema=3 */
public struct DeviceDashboardV2: Codable, Sendable, Equatable {
    public struct Info: Codable, Sendable, Equatable {
        public var id: String
        public var name: String
        public var showHeader: Bool
        public var logoImageId: String?

        public init(id: String, name: String, showHeader: Bool = true, logoImageId: String? = nil) {
            self.id = id
            self.name = name
            self.showHeader = showHeader
            self.logoImageId = logoImageId
        }

        private enum CodingKeys: String, CodingKey { case id, name, showHeader, logo }
        private struct Logo: Codable { var imageId: String }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.lenient(String.self, .name) ?? ""
            showHeader = c.lenient(Bool.self, .showHeader) ?? true
            logoImageId = c.lenient(Logo.self, .logo)?.imageId
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
            try c.encode(showHeader, forKey: .showHeader)
            try c.encode(logoImageId.map { Logo(imageId: $0) }, forKey: .logo)
        }
    }

    /** The schemas this type reads. */
    public static let schemas: Set<Int> = [2, 3]

    public var version: String
    /** 2 or 3. */
    public var schema: Int
    public var refreshAfterSec: Int
    public var timeZone: String
    /** The format widgets are placed in; `16x9` in schema 2. */
    public var primaryFormat: ScreenFormat
    /** This device's rotation and mode; the defaults in schema 2. */
    public var device: DeviceDisplaySettings
    /** Null when no dashboard is assigned; slides is then empty. */
    public var dashboard: Info?
    public var theme: DashboardTheme
    public var rotation: SlideRotationSettings
    /** Enabled slides only, in order. */
    public var slides: [DeviceSlide]
    public var images: [DeviceImage]
    /** The language of the labels (ADR 0016); nil from servers before it (English). */
    public var locale: String?

    public init(
        version: String, refreshAfterSec: Int = 60, timeZone: String = "UTC", dashboard: Info?,
        theme: DashboardTheme = .fallback, rotation: SlideRotationSettings = .init(), slides: [DeviceSlide],
        images: [DeviceImage] = [], locale: String? = nil, schema: Int = 2,
        primaryFormat: ScreenFormat = .widescreen, device: DeviceDisplaySettings = .init()
    ) {
        self.locale = locale
        self.version = version
        self.schema = schema
        self.primaryFormat = primaryFormat
        self.device = device
        self.refreshAfterSec = refreshAfterSec
        self.timeZone = timeZone
        self.dashboard = dashboard
        self.theme = theme
        self.rotation = rotation
        self.slides = slides
        self.images = images
    }

    private enum CodingKeys: String, CodingKey {
        case version, schema, refreshAfterSec, timeZone, locale, primaryFormat, device, dashboard, theme, rotation,
            slides, images
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        schema = try c.decode(Int.self, forKey: .schema)
        guard Self.schemas.contains(schema) else {
            throw DecodingError.dataCorruptedError(forKey: .schema, in: c, debugDescription: "Schema \(schema)")
        }
        if schema >= 3 {
            // A format this build does not know (a newer server) is laid
            // out as 16x9: widgets outside that grid are left out.
            primaryFormat = c.lenient(ScreenFormat.self, .primaryFormat) ?? .widescreen
            device = c.lenient(DeviceDisplaySettings.self, .device) ?? .init()
        } else {
            primaryFormat = .widescreen
            device = .init()
        }
        refreshAfterSec = c.lenient(Int.self, .refreshAfterSec) ?? 60
        timeZone = c.lenient(String.self, .timeZone) ?? "UTC"
        locale = c.lenient(String.self, .locale)
        dashboard = c.lenient(Info.self, .dashboard)
        theme = c.lenient(DashboardTheme.self, .theme) ?? .fallback
        rotation = c.lenient(SlideRotationSettings.self, .rotation) ?? .init()
        let primary = primaryFormat
        let customLayouts = schema >= 3
        slides = try c.decode(LossyArray<DeviceSlide>.self, forKey: .slides).elements.map { slide in
            var slide = slide
            slide.widgets = slide.widgets.filter { StudioLayout.isInsideFormatGrid($0.placement, format: primary) }
            if !customLayouts { slide.layouts = [] }
            return slide
        }
        images = c.lossyArray(DeviceImage.self, .images)
    }

    /** The language of the labels; English when the server sent none. */
    public var language: ScreenLanguage { ScreenLanguage(tag: locale) }

    /** The image with this id, if the payload lists it. */
    public func image(_ id: String?) -> DeviceImage? {
        guard let id else { return nil }
        return images.first { $0.id == id }
    }
}

/**
 * What the dashboard endpoint answered: schema 1 (an older server, or one
 * that does not list 2) or schema 2 or 3 (`.v2`, one type for both).
 * Encoded as the payload itself, so a cache file written by an older build
 * reads as schema 1.
 */
public enum DashboardPayload: Codable, Sendable, Equatable {
    case v1(DeviceDashboard)
    /** Schema 2 or 3 (see `DeviceDashboardV2.schema`). */
    case v2(DeviceDashboardV2)

    public var schema: Int {
        switch self {
        case .v1: return 1
        case .v2(let payload): return payload.schema
        }
    }

    public var version: String {
        switch self {
        case .v1(let payload): return payload.version
        case .v2(let payload): return payload.version
        }
    }

    public var refreshAfterSec: Int {
        switch self {
        case .v1(let payload): return payload.refreshAfterSec
        case .v2(let payload): return payload.refreshAfterSec
        }
    }

    public var timeZone: String {
        switch self {
        case .v1(let payload): return payload.timeZone
        case .v2(let payload): return payload.timeZone
        }
    }

    /** The language the server labelled the payload in (ADR 0016). */
    public var language: ScreenLanguage {
        switch self {
        case .v1(let payload): return payload.language
        case .v2(let payload): return payload.language
        }
    }

    /** Whether a dashboard is assigned to this TV. */
    public var hasDashboard: Bool {
        switch self {
        case .v1(let payload): return payload.dashboard != nil
        case .v2(let payload): return payload.dashboard != nil
        }
    }

    private enum SchemaKey: String, CodingKey { case schema }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: SchemaKey.self)
        if let schema = c.lenient(Int.self, .schema), schema != 1 {
            self = .v2(try DeviceDashboardV2(from: decoder))
        } else {
            self = .v1(try DeviceDashboard(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .v1(let payload): try payload.encode(to: encoder)
        case .v2(let payload): try payload.encode(to: encoder)
        }
    }
}
