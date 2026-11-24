import Foundation

// The state widget (#875, ADR 0019 section 15; deviceStateDataSchema and
// deviceStateOptionsSchema in packages/contracts, service-state.ts in
// packages/domain): the state of services, servers, deployments or health
// checks as one of six fixed states, one item or a list with everything
// not healthy first. The server maps each source value to a state and
// sorts; this build draws them. It asks with `features=state`; older builds
// get a text widget in its place.

/** One of the fixed states; a state this build does not know is `unknown`. */
public enum ServiceState: String, OpenAPIEnum, CaseIterable {
    case up, down, failed, building, sleeping, unknown
    public static var fallback: ServiceState { .unknown }

    /** Lower is more urgent (web: `serviceStateRank`). */
    public func rank(rolledBack: Bool = false) -> Int {
        switch self {
        case .down: return 0
        case .failed: return 1
        case .unknown: return 2
        case .building: return 3
        case .sleeping: return 4
        case .up: return rolledBack ? 5 : 6
        }
    }

    /** The colour beside the word and icon, never alone (web: `serviceStateTone`). */
    public func tone(rolledBack: Bool = false) -> StatusTone {
        switch self {
        case .up: return rolledBack ? .warning : .up
        case .down, .failed: return .down
        case .unknown: return .warning
        case .building, .sleeping: return .muted
        }
    }

    /** The SF Symbol drawn beside the word: a distinct shape per state. */
    public var symbol: String {
        switch self {
        case .up: return "checkmark.circle.fill"
        case .down: return "xmark.octagon.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .building: return "arrow.triangle.2.circlepath"
        case .sleeping: return "moon.zzz.fill"
        case .unknown: return "questionmark.circle.fill"
        }
    }

    /** "Up", "Online". */
    public func word(_ language: ScreenLanguage) -> String {
        let key: KitText
        switch self {
        case .up: key = .stateUp
        case .down: key = .stateDown
        case .failed: key = .stateFailed
        case .building: key = .stateBuilding
        case .sleeping: key = .stateSleeping
        case .unknown: key = .stateUnknown
        }
        return KitStrings.text(key, language)
    }
}

public struct StateWidgetOptions: Codable, Sendable, Equatable {
    public enum Layout: String, OpenAPIEnum {
        case list, single, unknown
        /** A layout this build does not know (a newer server) shows as a list. */
        public static var fallback: Layout { .unknown }
    }

    public var layout: Layout
    /** Single: the item's name the server chose by; nil for the most urgent. */
    public var item: String?
    /** List: the most items the server sends. 1…20. */
    public var limit: Int
    public var showChanged: Bool

    public init(layout: Layout = .list, item: String? = nil, limit: Int = 8, showChanged: Bool = true) {
        self.layout = layout
        self.item = item
        self.limit = min(max(limit, 1), StateWidgetData.maxItems)
        self.showChanged = showChanged
    }

    /** One item; anything else is a list. */
    public var single: Bool { layout == .single }

    private enum CodingKeys: String, CodingKey { case layout, item, limit, showChanged }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            layout: c.lenient(Layout.self, .layout) ?? .list, item: c.lenient(String.self, .item),
            limit: c.lenient(Int.self, .limit) ?? 8, showChanged: c.lenient(Bool.self, .showChanged) ?? true)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(layout, forKey: .layout)
        try c.encode(item, forKey: .item)
        try c.encode(limit, forKey: .limit)
        try c.encode(showChanged, forKey: .showChanged)
    }
}

/** One service, server, deployment or check. */
public struct StateWidgetItem: Codable, Sendable, Equatable {
    public var name: String?
    public var state: ServiceState
    /** A qualifier on up: production serves an older build. */
    public var rolledBack: Bool
    /** ISO date or timestamp of the last change, as stored. */
    public var changedAt: String?

    public init(name: String?, state: ServiceState, rolledBack: Bool = false, changedAt: String? = nil) {
        self.name = name
        self.state = state
        self.rolledBack = state == .up && rolledBack
        self.changedAt = changedAt
    }

    private enum CodingKeys: String, CodingKey { case name, state, rolledBack, changedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: c.lenient(String.self, .name), state: c.lenient(ServiceState.self, .state) ?? .unknown,
            rolledBack: c.lenient(Bool.self, .rolledBack) ?? false, changedAt: c.lenient(String.self, .changedAt))
    }

    public func encode(to encoder: Encoder) throws {
        // Explicit nulls, as the server sends them.
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(state, forKey: .state)
        try c.encode(rolledBack, forKey: .rolledBack)
        try c.encode(changedAt, forKey: .changedAt)
    }

    /** Whether it asks for attention: anything but a plain up. */
    public var healthy: Bool { state == .up && !rolledBack }
}

/**
 * Every matching item per state (web: `serviceStateCounts`): the single
 * form's summary and the tone of "+N more"; `rolledBack` counts the ups
 * with the qualifier (they are in `up` too).
 */
public struct ServiceStateCounts: Codable, Sendable, Equatable {
    public var up = 0, down = 0, failed = 0, building = 0, sleeping = 0, unknown = 0, rolledBack = 0

    public init() {}

    public init(items: [StateWidgetItem]) {
        for item in items {
            self[item.state] += 1
            if item.state == .up && item.rolledBack { rolledBack += 1 }
        }
    }

    public subscript(state: ServiceState) -> Int {
        get {
            switch state {
            case .up: return up
            case .down: return down
            case .failed: return failed
            case .building: return building
            case .sleeping: return sleeping
            case .unknown: return unknown
            }
        }
        set {
            switch state {
            case .up: up = newValue
            case .down: down = newValue
            case .failed: failed = newValue
            case .building: building = newValue
            case .sleeping: sleeping = newValue
            case .unknown: unknown = newValue
            }
        }
    }

    public var total: Int { ServiceState.allCases.reduce(0) { $0 + self[$1] } }

    /** Items in `state` (with `rolledBack` for up: those with or without the qualifier). */
    func count(_ state: ServiceState, rolledBack: Bool) -> Int {
        state == .up ? (rolledBack ? self.rolledBack : up - self.rolledBack) : self[state]
    }

    private enum CodingKeys: String, CodingKey { case up, down, failed, building, sleeping, unknown, rolledBack }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        up = max(0, c.lenient(Int.self, .up) ?? 0)
        down = max(0, c.lenient(Int.self, .down) ?? 0)
        failed = max(0, c.lenient(Int.self, .failed) ?? 0)
        building = max(0, c.lenient(Int.self, .building) ?? 0)
        sleeping = max(0, c.lenient(Int.self, .sleeping) ?? 0)
        unknown = max(0, c.lenient(Int.self, .unknown) ?? 0)
        rolledBack = max(0, c.lenient(Int.self, .rolledBack) ?? 0)
    }
}

/** A state widget's data: not healthy first, as the server sorted it. */
public struct StateWidgetData: Codable, Sendable, Equatable {
    /** The most items the server sends (STATE_LIST_MAX). */
    public static let maxItems = 20

    /** ok, no_data or stale (a last valid snapshot or an overdue source). */
    public var status: DeviceTileStatus
    public var items: [StateWidgetItem]
    /** Every matching item, also those beyond the list's limit. */
    public var total: Int
    /** Every matching item per state; from the items when the server sent none. */
    public var counts: ServiceStateCounts
    /** ADR 0025; nil without freshness. */
    public var freshness: WidgetFreshness?

    public init(
        status: DeviceTileStatus = .ok, items: [StateWidgetItem], total: Int? = nil,
        counts: ServiceStateCounts? = nil, freshness: WidgetFreshness? = nil
    ) {
        self.status = status
        self.items = items
        self.total = max(total ?? items.count, items.count)
        self.counts = counts ?? ServiceStateCounts(items: items)
        self.freshness = freshness
    }

    private enum CodingKeys: String, CodingKey { case status, items, total, counts, freshness }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A damaged item is dropped, not the widget.
        let items = Array(
            try c.decode(LossyArray<StateWidgetItem>.self, forKey: .items).elements.prefix(Self.maxItems))
        self.init(
            status: c.lenient(DeviceTileStatus.self, .status) ?? .ok, items: items,
            total: c.lenient(Int.self, .total), counts: c.lenient(ServiceStateCounts.self, .counts),
            freshness: c.lenient(WidgetFreshness.self, .freshness))
    }
}

/** What the widget shows besides its layout (web: lib/studio-state.ts). */
public enum StateBoard {
    /**
     * How many rows a list shows and what "+N more" says (web:
     * `serviceStateRowsShown`): all items when they fit, else capacity − 1
     * items and "+N more", counting the items the server left out beyond
     * its limit (`total − shown`). Capacity 0 shows nothing.
     */
    public static func rowsShown(items: Int, total: Int, capacity: Int) -> (rows: Int, more: Int) {
        let all = max(total, items)
        if capacity <= 0 { return (0, 0) }
        if all <= capacity && items == all { return (items, 0) }
        let rows = min(items, capacity - 1)
        return (rows, all - rows)
    }

    /** Items in display order (web: `sortServiceStateItems`); the server already sends them so. */
    public static func sorted(_ items: [StateWidgetItem]) -> [StateWidgetItem] {
        items.enumerated().sorted { left, right in
            let a = left.element
            let b = right.element
            let rank = a.state.rank(rolledBack: a.rolledBack) - b.state.rank(rolledBack: b.rolledBack)
            if rank != 0 { return rank < 0 }
            if (a.name == nil) != (b.name == nil) { return b.name == nil }
            let l = (a.name ?? "").lowercased()
            let r = (b.name ?? "").lowercased()
            if l != r { return l < r }
            if a.name != b.name { return (a.name ?? "") < (b.name ?? "") }
            return left.offset < right.offset
        }.map(\.element)
    }

    /** "Up", "Up · rolled back" ("Online · zurückgesetzt"). */
    public static func stateText(_ item: StateWidgetItem, language: ScreenLanguage) -> String {
        let word = item.state.word(language)
        return item.rolledBack ? "\(word) · \(KitStrings.text(.stateRolledBack, language))" : word
    }

    /** A list row's age of the last change ("3 h"); nil without one. */
    public static func age(_ changedAt: String?, now: Date, language: ScreenLanguage) -> String? {
        guard let changedAt, StudioLayout.statusAge(changedAt, now: now) != nil else { return nil }
        return StatusBoard.ageText(changedAt, now: now, language: language)
    }

    /** "Changed 3 hours ago" ("Geändert vor 3 Stunden"); nil without a readable time. */
    public static func changed(_ changedAt: String?, now: Date, language: ScreenLanguage) -> String? {
        guard let changedAt, ISODate.parse(changedAt) != nil else { return nil }
        return KitStrings.text(.stateChanged, language, RelativeTime.describe(changedAt, now: now, language: language))
    }

    /**
     * The freshness footer (ADR 0025): the overdue warning, else the
     * longest form that fits one line of `width` units at `size`; nil
     * without freshness.
     */
    public static func footer(
        _ data: StateWidgetData, now: Date, language: ScreenLanguage, width: Double, size: Double,
        timeZone: TimeZone = .current
    ) -> (text: String, warning: Bool)? {
        guard let freshness = data.freshness else { return nil }
        let text = FreshnessText(language: language, timeZone: timeZone, region: .autoupdatingCurrent)
        if let warning = text.overdueWarning(freshness, status: data.status, now: now) { return (warning, true) }
        let forms = text.footer(freshness, status: data.status, now: now)
        guard let last = forms.last else { return nil }
        let fit = forms.first { StudioLayout.wrappedLineCount($0, maxWidth: width, fontSize: size) <= 1 }
        return (fit ?? last, false)
    }

    /** Every state from the most to the least urgent, a rollback as its own. */
    static let urgency: [(ServiceState, Bool)] = ServiceState.allCases
        .flatMap { $0 == .up ? [($0, true), ($0, false)] : [($0, false)] }
        .sorted { $0.0.rank(rolledBack: $0.1) < $1.0.rank(rolledBack: $1.1) }

    /** The most urgent state that has items; nil without items. */
    public static func summaryState(_ counts: ServiceStateCounts) -> (ServiceState, Bool)? {
        urgency.first { counts.count($0.0, rolledBack: $0.1) > 0 }
    }

    /**
     * The single form's summary when no item is chosen (web:
     * `serviceStateSummary`): "All 5 up" ("Alle 5 online"), else the most
     * urgent state and its count, "2 of 5 down" ("2 von 5 offline"); nil
     * without items.
     */
    public static func summaryText(_ counts: ServiceStateCounts, language: ScreenLanguage) -> String? {
        guard let (state, rolledBack) = summaryState(counts) else { return nil }
        if state == .up && !rolledBack { return KitStrings.text(.stateSummaryAllUp, language, counts.total) }
        let word: KitText
        switch state {
        case .up: word = rolledBack ? .stateLowerRolledBack : .stateLowerUp
        case .down: word = .stateLowerDown
        case .failed: word = .stateLowerFailed
        case .building: word = .stateLowerBuilding
        case .sleeping: word = .stateLowerSleeping
        case .unknown: word = .stateLowerUnknown
        }
        return KitStrings.text(
            .stateSummaryWorst, language, counts.count(state, rolledBack: rolledBack), counts.total,
            KitStrings.text(word, language))
    }

    /**
     * The tone of "+N more" (web: `serviceStateHiddenTone`): the most urgent
     * item not shown, also one the server left out; nil when nothing is hidden.
     */
    public static func hiddenTone(_ counts: ServiceStateCounts, shown: [StateWidgetItem]) -> StatusTone? {
        let seen = ServiceStateCounts(items: shown)
        var left = ServiceStateCounts()
        for state in ServiceState.allCases { left[state] = max(0, counts[state] - seen[state]) }
        left.rolledBack = max(0, counts.rolledBack - seen.rolledBack)
        guard let (state, rolledBack) = summaryState(left) else { return nil }
        return state.tone(rolledBack: rolledBack)
    }

    /** What VoiceOver reads for an item: "api, Failed". */
    public static func accessibilityText(_ item: StateWidgetItem, language: ScreenLanguage) -> String {
        [item.name, stateText(item, language: language)].compactMap { $0 }.joined(separator: ", ")
    }
}
