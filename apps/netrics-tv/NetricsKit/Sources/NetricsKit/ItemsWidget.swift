import Foundation

// The latest-items widget (#810, #811; deviceItemsDataSchema and
// itemsWidgetOptionsSchema in packages/contracts): the newest records of a
// model, newest first, each with an optional image that is one of the
// payload's `images`. The server sends it only to builds that ask with
// `features=items`; older builds get a text widget in its place.
//
// Item images ride the payload's `images`, so the existing download,
// `touch` and `evict(keeping:)` paths keep them for offline playback. An
// image the server cannot serve yet (a 404 races the payload) is retried
// with the next poll; until then, and for an item without an image, the
// widget shows a themed placeholder, never an error.

public struct ItemsWidgetOptions: Codable, Sendable, Equatable {
    public enum Layout: String, OpenAPIEnum {
        case grid, rotate, unknown
        /** A layout this build does not know (a newer server) shows as a grid. */
        public static var fallback: Layout { .unknown }
    }

    public var layout: Layout
    /** The newest items shown; a grid shows those that fit. 1…50. */
    public var count: Int
    /** Rotate: seconds per item. 3…60. */
    public var rotateSeconds: Int
    public var imageFit: ImageFit
    public var showTime: Bool

    public init(
        layout: Layout = .grid, count: Int = 6, rotateSeconds: Int = 8, imageFit: ImageFit = .cover,
        showTime: Bool = true
    ) {
        self.layout = layout
        self.count = min(max(count, 1), 50)
        self.rotateSeconds = min(max(rotateSeconds, 3), 60)
        self.imageFit = imageFit
        self.showTime = showTime
    }

    /** One item at a time; anything else is a grid. */
    public var rotates: Bool { layout == .rotate }

    private enum CodingKeys: String, CodingKey { case layout, count, rotateSeconds, imageFit, showTime }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The server's default fit for items is cover (the image widget's is contain).
        let fit = c.lenient(String.self, .imageFit).flatMap(ImageFit.init(rawValue:)) ?? .cover
        self.init(
            layout: c.lenient(Layout.self, .layout) ?? .grid, count: c.lenient(Int.self, .count) ?? 6,
            rotateSeconds: c.lenient(Int.self, .rotateSeconds) ?? 8, imageFit: fit,
            showTime: c.lenient(Bool.self, .showTime) ?? true)
    }
}

/** One record: its title, subtitle and time as stored, and its image by id. */
public struct ItemsWidgetItem: Codable, Sendable, Equatable {
    public var title: String?
    public var subtitle: String?
    /** ISO date ("2026-11-20") or timestamp, as stored. */
    public var time: String?
    /** One of the payload's `images`; nil without one (or when the payload does not list it). */
    public var imageId: String?

    public init(title: String?, subtitle: String?, time: String?, imageId: String?) {
        self.title = title
        self.subtitle = subtitle
        self.time = time
        self.imageId = imageId
    }

    private enum CodingKeys: String, CodingKey { case title, subtitle, time, imageId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.lenient(String.self, .title)
        subtitle = c.lenient(String.self, .subtitle)
        time = c.lenient(String.self, .time)
        imageId = c.lenient(String.self, .imageId)
    }

    public func encode(to encoder: Encoder) throws {
        // Explicit nulls, as the server sends them.
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        try c.encode(subtitle, forKey: .subtitle)
        try c.encode(time, forKey: .time)
        try c.encode(imageId, forKey: .imageId)
    }
}

/** A latest-items widget's data: newest first. */
public struct ItemsWidgetData: Codable, Sendable, Equatable {
    /** The most items the server sends (CUSTOM_API_IMAGE_NEWEST_MAX). */
    public static let maxItems = 50

    /** ok or no_data. */
    public var status: DeviceTileStatus
    public var items: [ItemsWidgetItem]
    /** ADR 0025; nil without freshness. */
    public var freshness: WidgetFreshness?

    public init(status: DeviceTileStatus = .ok, items: [ItemsWidgetItem], freshness: WidgetFreshness? = nil) {
        self.status = status
        self.items = items
        self.freshness = freshness
    }

    private enum CodingKeys: String, CodingKey { case status, items, freshness }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(DeviceTileStatus.self, .status) ?? .ok
        // A damaged item is dropped, not the widget.
        items = Array(try c.decode(LossyArray<ItemsWidgetItem>.self, forKey: .items).elements.prefix(Self.maxItems))
        freshness = c.lenient(WidgetFreshness.self, .freshness)
    }

    /** The same data with every image id the payload does not list set to nil (a placeholder). */
    public func keepingImages(_ known: Set<String>) -> ItemsWidgetData {
        var copy = self
        copy.items = items.map { item in
            var item = item
            if let id = item.imageId, !known.contains(id) { item.imageId = nil }
            return item
        }
        return copy
    }
}

/**
 * The item shown at `date` when rotating: index = floor(seconds since slide
 * start / rotateSeconds) mod count. 0 before the start, without items or
 * without a period.
 */
public func itemsRotationIndex(itemCount: Int, rotateSeconds: Int, slideStartedAt: Date, at date: Date) -> Int {
    guard itemCount > 1, rotateSeconds > 0 else { return 0 }
    let elapsed = date.timeIntervalSince(slideStartedAt)
    guard elapsed > 0 else { return 0 }
    let step = Int((elapsed / Double(rotateSeconds)).rounded(.down))
    return step % itemCount
}

/** The grid of a latest-items widget, as the web lays it out (`itemsGridLayout`). */
public enum ItemsLayout {
    /** The smallest tile of a grid in units: a readable title over an image. */
    public static let tileMinWidth = 240.0
    /** The smallest image of a tile in units; a grid adds no row below it. */
    public static let imageMinHeight = 96.0
    /** Between tiles, in units. */
    public static let gap = 16.0

    public struct Grid: Sendable, Equatable {
        public var columns: Int
        public var rows: Int
        /** Items shown: at most columns × rows and `count`. */
        public var shown: Int

        public init(columns: Int, rows: Int, shown: Int) {
            self.columns = columns
            self.rows = rows
            self.shown = shown
        }
    }

    /**
     * How many items a grid shows in a content box (units): columns of at
     * least `tileMinWidth`, rows of an image of at least `imageMinHeight`
     * over the text lines, never more than `count` nor the items there
     * are. Extra items are left out, never shrunk. Always at least one.
     */
    public static func grid(width: Double, height: Double, textHeight: Double, count: Int, items: Int) -> Grid {
        let wanted = max(1, min(count, items))
        let fitColumns = max(1, Int(((width + gap) / (tileMinWidth + gap)).rounded(.down)))
        let tile = imageMinHeight + textHeight
        let fitRows = max(1, Int(((height + gap) / (tile + gap)).rounded(.down)))
        let columns = min(fitColumns, wanted)
        let rows = min(fitRows, (wanted + columns - 1) / columns)
        return Grid(columns: columns, rows: rows, shown: min(wanted, columns * rows))
    }

    /** The text lines under each tile's image in units: the title, a subtitle when any item has one, the time. */
    public static func textHeight(body: Double, cell: Double, subtitles: Bool, showTime: Bool) -> Double {
        body * StudioRender.lineHeight + (subtitles ? cell * StudioRender.lineHeight : 0)
            + (showTime ? cell * StudioRender.lineHeight : 0)
    }
}

/** The widget's words. */
public enum ItemsText {
    /**
     * An item's time as shown: a calendar day as the date ("Nov 20, 2026"),
     * a timestamp relative to `now` ("2 hr. ago", "yesterday"); text that is
     * neither as stored. Web: `itemTime`.
     */
    public static func time(_ time: String?, now: Date, language: ScreenLanguage, timeZone: TimeZone = .current)
        -> String?
    {
        guard let time, !time.isEmpty else { return nil }
        if time.wholeMatch(of: /[0-9]{4}-[0-9]{2}-[0-9]{2}/) != nil {
            return DataFormat.date(time, type: "date", language: language, timeZone: timeZone) ?? time
        }
        guard let date = ISODate.parse(time) else { return time }
        return relative(date, now: now, language: language)
    }

    /**
     * A time relative to `now` as the web words an item's (#835):
     * `relativeTimeIn(…, "short")`, Intl.RelativeTimeFormat with numeric
     * "auto". The unit is the web's (seconds under 45 are "now", then
     * minutes, hours, days), and named days read "yesterday", "gestern",
     * "vorgestern" where the web says so instead of "1 day ago".
     */
    static func relative(_ date: Date, now: Date, language: ScreenLanguage) -> String {
        let delta = Int(date.timeIntervalSince(now).rounded(.toNearestOrAwayFromZero))
        let absolute = abs(delta)
        let sign = delta < 0 ? -1 : 1
        func count(_ size: Int) -> Int { sign * Int((Double(absolute) / Double(size)).rounded(.toNearestOrAwayFromZero)) }
        var components = DateComponents()
        if absolute < 45 {
            components.second = 0
        } else if absolute < 3600 {
            components.minute = count(60)
        } else if absolute < 86_400 {
            components.hour = count(3600)
        } else {
            components.day = count(86_400)
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = language.locale
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .short
        return formatter.localizedString(from: components)
    }

    /** "3 items", "1 Eintrag". */
    public static func count(_ count: Int, language: ScreenLanguage) -> String {
        KitStrings.text(count == 1 ? .itemsOne : .itemsOther, language, count)
    }
}
