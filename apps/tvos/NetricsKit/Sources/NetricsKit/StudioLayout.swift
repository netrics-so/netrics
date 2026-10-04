import Foundation

// Dashboard Studio layout and readability rules (ADR 0015, section 8), a
// port of packages/domain/src/studio-layout.ts. Both sides run the vectors in
// packages/domain/test-vectors/studio-layout.json (StudioLayoutTests), so
// keep the arithmetic in the same order as the TypeScript.
//
// Sizes are in canvas units: u = canvas height / 1080. Functions that take a
// canvas answer in canvas points; the type scale answers in units.

public enum StudioWidgetType: String, Sendable, Equatable, CaseIterable, Codable {
    case metric, line, bar, image, text, clock, table, status, compare

    /** Widgets with a title and resource line (bound to a metric). */
    public var isData: Bool {
        self == .metric || self == .line || self == .bar || self == .table || self == .compare
    }

    /**
     * Widgets that show a label, which labelFit checks (ADR 0019 section 2);
     * image, text and clock have none.
     */
    public var hasLabel: Bool { self != .image && self != .text && self != .clock }
}

/** A widget's cells: 0-based column and row, width and height in cells. */
public struct StudioPlacement: Sendable, Equatable, Codable {
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int

    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

public struct StudioCanvas: Sendable, Equatable, Codable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public struct StudioRect: Sendable, Equatable, Codable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct StudioFrame: Sendable, Equatable {
    /** Canvas points per unit. */
    public var unit: Double
    /** The header band, nil without the header. */
    public var header: StudioRect?
    /** The area the 12 × 8 cells and their gaps fill. */
    public var grid: StudioRect
}

/** Text roles of a widget; see widgetTypeScale. */
public enum StudioTextRole: String, Sendable, CaseIterable, Codable {
    case any, title, resource, change, axis, body, heading, display
    case valueMin, valueMax, clockMin, clockMax, date, zone
    case cell, columnHead, operand
}

public enum StudioFontWeight: String, Sendable, Codable {
    case regular, semibold, bold

    var factor: Double {
        switch self {
        case .regular: return 1
        case .semibold: return 1.05
        case .bold: return 1.08
        }
    }
}

public enum StudioTextSize: String, Sendable, Codable {
    case body, heading, display
}

public struct StudioTextSpan: Sendable, Equatable, Codable {
    public var text: String
    public var bold: Bool
    public var italic: Bool

    public init(text: String, bold: Bool, italic: Bool) {
        self.text = text
        self.bold = bold
        self.italic = italic
    }
}

public enum StudioTextBlock: Sendable, Equatable {
    case heading(level: Int, spans: [StudioTextSpan])
    case paragraph(lines: [[StudioTextSpan]])
}

public struct StudioLabelFit: Sendable, Equatable {
    public var fits: Bool
    public var titleLines: Int
    public var resourceLines: Int
}

/** How the clock shows the date: "Sat 4 Oct" or "Saturday, 4 October". */
public enum ClockDateStyle: String, Sendable, Codable {
    case short, long
}

/** The clock's sizes in units; nil for a part that is off or does not fit. */
public struct StudioClockLayout: Sendable, Equatable {
    public var time: Double
    public var date: Double?
    public var zone: Double?
    /** A part that is on does not fit. */
    public var hidden: Bool
}

public enum StudioLayout {
    public static let columns = 12
    public static let rows = 8
    public static let referenceCanvas = StudioCanvas(width: 1920, height: 1080)
    public static let headerBand = 0.07
    public static let padding = 32.0
    public static let gap = 16.0
    public static let widgetPadding = 24.0

    /** The smallest widget per type. */
    public static func minimumSize(_ type: StudioWidgetType) -> (w: Int, h: Int) {
        switch type {
        case .metric: return (3, 2)
        case .line, .bar: return (4, 3)
        case .image: return (1, 1)
        case .text, .clock: return (2, 1)
        case .table: return (4, 4)
        case .status: return (3, 3)
        case .compare: return (4, 3)
        }
    }

    // MARK: Grid → rect

    public static func canvasUnit(_ canvas: StudioCanvas) -> Double {
        canvas.height / referenceCanvas.height
    }

    public static func frame(canvas: StudioCanvas, showHeader: Bool) -> StudioFrame {
        let unit = canvasUnit(canvas)
        let headerHeight = showHeader ? canvas.height * headerBand : 0
        let pad = padding * unit
        return StudioFrame(
            unit: unit,
            header: showHeader ? StudioRect(x: 0, y: 0, width: canvas.width, height: headerHeight) : nil,
            grid: StudioRect(
                x: pad,
                y: headerHeight + pad,
                width: canvas.width - 2 * pad,
                height: canvas.height - headerHeight - 2 * pad))
    }

    /** A widget's rect in canvas points. */
    public static func widgetRect(_ placement: StudioPlacement, canvas: StudioCanvas, showHeader: Bool) -> StudioRect {
        let frame = frame(canvas: canvas, showHeader: showHeader)
        let grid = frame.grid
        let gap = self.gap * frame.unit
        let cellWidth = (grid.width - gap * Double(columns - 1)) / Double(columns)
        let cellHeight = (grid.height - gap * Double(rows - 1)) / Double(rows)
        return StudioRect(
            x: grid.x + Double(placement.x) * (cellWidth + gap),
            y: grid.y + Double(placement.y) * (cellHeight + gap),
            width: Double(placement.w) * cellWidth + Double(placement.w - 1) * gap,
            height: Double(placement.h) * cellHeight + Double(placement.h - 1) * gap)
    }

    // MARK: Placement rules

    public static func isInsideGrid(_ p: StudioPlacement) -> Bool {
        p.x >= 0 && p.y >= 0 && p.w >= 1 && p.h >= 1 && p.x + p.w <= columns && p.y + p.h <= rows
    }

    public static func meetsMinimumSize(_ type: StudioWidgetType, _ p: StudioPlacement) -> Bool {
        let minimum = minimumSize(type)
        return p.w >= minimum.w && p.h >= minimum.h
    }

    public static func overlap(_ a: StudioPlacement, _ b: StudioPlacement) -> Bool {
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    }

    /** Index pairs (i < j) of placements that overlap, in order. */
    public static func findOverlaps(_ placements: [StudioPlacement]) -> [[Int]] {
        var pairs: [[Int]] = []
        for i in placements.indices {
            for j in placements.indices where j > i && overlap(placements[i], placements[j]) {
                pairs.append([i, j])
            }
        }
        return pairs
    }

    // MARK: Type scale

    /** Minimum text sizes in units, before the theme's font scale. */
    public enum Minimum {
        public static let any = 24.0
        public static let title = 30.0
        public static let resource = 30.0
        public static let change = 28.0
        public static let axis = 24.0
        public static let body = 32.0
        public static let heading = 56.0
        public static let display = 96.0
        public static let value = 64.0
        public static let clock = 56.0
        /** The clock's zone line (ADR 0019, section 9). */
        public static let zone = 24.0
        /** Table rows (ADR 0019 section 13). */
        public static let cell = 28.0
        /** Table column heads, in caps. */
        public static let columnHead = 24.0
        /** A compare widget's two numbers (ADR 0019 section 10). */
        public static let operand = 48.0
    }

    /** A font scale never lowers a minimum: anything below 1 is 1. */
    public static func effectiveFontScale(_ fontScale: Double?) -> Double {
        guard let fontScale, fontScale.isFinite, fontScale > 1 else { return 1 }
        return fontScale
    }

    static func contentHeight(_ placement: StudioPlacement, showHeader: Bool) -> Double {
        widgetRect(placement, canvas: referenceCanvas, showHeader: showHeader).height - 2 * widgetPadding
    }

    /**
     * The text sizes of a widget of this type and size, in units: minimums
     * times the font scale; the value and the clock grow with the height.
     */
    public static func typeScale(
        _ type: StudioWidgetType, placement: StudioPlacement, fontScale: Double? = nil, showHeader: Bool = true
    ) -> [StudioTextRole: Double] {
        let scale = effectiveFontScale(fontScale)
        let any = Minimum.any * scale
        switch type {
        case .metric, .line, .bar:
            let share = type == .metric ? 0.36 : 0.2
            let valueMin = Minimum.value * scale
            var sizes: [StudioTextRole: Double] = [
                .any: any,
                .title: Minimum.title * scale,
                .resource: Minimum.resource * scale,
                .valueMin: valueMin,
                .valueMax: max(valueMin, contentHeight(placement, showHeader: showHeader) * share),
            ]
            if type == .metric {
                sizes[.change] = Minimum.change * scale
            } else {
                sizes[.axis] = Minimum.axis * scale
            }
            return sizes
        case .table:
            return [
                .any: any, .title: Minimum.title * scale, .resource: Minimum.resource * scale,
                .columnHead: Minimum.columnHead * scale, .cell: Minimum.cell * scale,
            ]
        case .status:
            return [
                .any: any, .title: Minimum.title * scale, .resource: Minimum.resource * scale,
                .cell: Minimum.cell * scale,
            ]
        case .compare:
            // The ratio is the value (ADR 0019 section 10).
            let valueMin = Minimum.value * scale
            return [
                .any: any,
                .title: Minimum.title * scale,
                .resource: Minimum.resource * scale,
                .change: Minimum.change * scale,
                .operand: Minimum.operand * scale,
                .valueMin: valueMin,
                .valueMax: max(valueMin, contentHeight(placement, showHeader: showHeader) * 0.3),
            ]
        case .image:
            return [.any: any]
        case .text:
            return [
                .any: any, .body: Minimum.body * scale, .heading: Minimum.heading * scale,
                .display: Minimum.display * scale,
            ]
        case .clock:
            let clockMin = Minimum.clock * scale
            return [
                .any: any,
                .clockMin: clockMin,
                .clockMax: max(clockMin, contentHeight(placement, showHeader: showHeader) * 0.6),
                .date: Minimum.title * scale,
                .zone: Minimum.zone * scale,
            ]
        }
    }

    /** A text widget's paragraph and heading sizes in units. */
    public static func textWidgetSizes(_ size: StudioTextSize, fontScale: Double? = nil)
        -> (paragraph: Double, heading1: Double, heading2: Double)
    {
        let scale = effectiveFontScale(fontScale)
        let base: Double
        switch size {
        case .body: base = Minimum.body
        case .heading: base = Minimum.heading
        case .display: base = Minimum.display
        }
        let paragraph = base * scale
        return (paragraph, max(paragraph * 1.5, Minimum.heading * scale), max(paragraph * 1.25, 40 * scale))
    }

    // MARK: Text measurement (conservative)

    static let narrow = Set("iljI|!.,:;'`".unicodeScalars)
    static let semiNarrow = Set("ftr()[]{}/\\-".unicodeScalars)
    static let wide = Set("MWmw@%&—".unicodeScalars)

    /** A glyph's advance in em, on the wide side; unknown ones a full em. */
    public static func glyphEm(_ scalar: Unicode.Scalar) -> Double {
        if scalar == " " { return 0.3 }
        if narrow.contains(scalar) { return 0.32 }
        if semiNarrow.contains(scalar) { return 0.42 }
        if wide.contains(scalar) { return 0.95 }
        switch scalar.value {
        case 0x41...0x5A: return 0.72
        case 0x30...0x39: return 0.62
        case 0x61...0x7A: return 0.6
        case 0x21...0x7E: return 0.6
        default: return 1
        }
    }

    /** Estimated width of one line of text, per Unicode code point. */
    public static func estimateTextWidth(_ text: String, fontSize: Double, weight: StudioFontWeight = .regular) -> Double {
        var em = 0.0
        for scalar in text.unicodeScalars {
            em += glyphEm(scalar)
        }
        return em * fontSize * weight.factor
    }

    /** Lines the text takes wrapped greedily at spaces; long words break. */
    public static func wrappedLineCount(
        _ text: String, maxWidth: Double, fontSize: Double, weight: StudioFontWeight = .regular
    ) -> Int {
        // Split at U+0020 by code point, as the TypeScript does.
        let words = text.unicodeScalars.split(separator: " ", omittingEmptySubsequences: true)
            .map { String(String.UnicodeScalarView($0)) }
        let space = estimateTextWidth(" ", fontSize: fontSize, weight: weight)
        var lines = 0
        var current = 0.0
        var empty = true
        for word in words {
            let width = estimateTextWidth(word, fontSize: fontSize, weight: weight)
            if !empty && current + space + width <= maxWidth {
                current = current + space + width
                continue
            }
            if !empty {
                lines += 1
                current = 0
                empty = true
            }
            if width <= maxWidth {
                current = width
                empty = false
                continue
            }
            for scalar in word.unicodeScalars {
                let charWidth = estimateTextWidth(String(scalar), fontSize: fontSize, weight: weight)
                if !empty && current + charWidth > maxWidth {
                    lines += 1
                    current = 0
                }
                current = current + charWidth
                empty = false
            }
        }
        if !empty { lines += 1 }
        return lines
    }

    /**
     * The largest size from max down to min at which the text fits on one
     * line, or nil (then a value switches to its compact form).
     */
    public static func fitTextSize(
        _ text: String, maxWidth: Double, min: Double, max: Double, weight: StudioFontWeight = .regular
    ) -> Double? {
        let widthAtOne = estimateTextWidth(text, fontSize: 1, weight: weight)
        let size = widthAtOne > 0 ? Swift.min(max, maxWidth / widthAtOne) : max
        return size >= min ? size : nil
    }

    // MARK: Clock (ADR 0019, section 9; clockLayout in the domain)

    /** The widest date of each style in English and German (CLOCK_DATE_SAMPLES). */
    public static func clockDateSample(_ style: ClockDateStyle) -> String {
        style == .long ? "Donnerstag, 10. September" : "Mo., 16. März"
    }

    static let zoneOffsetSample = "UTC\u{2212}00:00"

    /** "Buenos Aires" for "America/Argentina/Buenos_Aires"; nil for "UTC", "Etc/GMT+3". */
    public static func zoneCity(_ timeZone: String) -> String? {
        if timeZone.hasPrefix("Etc/") || !timeZone.contains("/") { return nil }
        let last = timeZone.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        let city = last.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        return city.isEmpty ? nil : city
    }

    /** The zone's offset from UTC in minutes at the date; nil for an unknown zone. */
    public static func zoneOffsetMinutes(_ timeZone: String, at date: Date) -> Int? {
        guard let zone = TimeZone(identifier: timeZone) else { return nil }
        return Int((Double(zone.secondsFromGMT(for: date)) / 60).rounded())
    }

    /** "UTC+2", "UTC+5:30", "UTC−3", "UTC". */
    public static func formatUtcOffset(_ minutes: Int) -> String {
        if minutes == 0 { return "UTC" }
        let sign = minutes > 0 ? "+" : "\u{2212}"
        let total = abs(minutes)
        let rest = total % 60
        return "UTC\(sign)\(total / 60)" + (rest == 0 ? "" : ":" + (rest < 10 ? "0\(rest)" : "\(rest)"))
    }

    /** The clock's zone line: "Berlin · UTC+2", "UTC" for Etc/UTC. */
    public static func zoneLabel(_ timeZone: String, at date: Date) -> String {
        let city = zoneCity(timeZone)
        guard let minutes = zoneOffsetMinutes(timeZone, at: date) else { return city ?? timeZone }
        let offset = formatUtcOffset(minutes)
        return city.map { "\($0) \u{00B7} \(offset)" } ?? offset
    }

    /** The widest zone line of the zone, for the fit. */
    public static func zoneLabelSample(_ timeZone: String) -> String {
        zoneCity(timeZone).map { "\($0) \u{00B7} \(zoneOffsetSample)" } ?? zoneOffsetSample
    }

    /**
     * The clock's content: the time at least 56 units and as large as fits,
     * the date (30, down to 24 for its widest sample) and the zone line
     * (24); when lines do not fit, the zone line goes first, then the date.
     */
    public static func clockLayout(
        placement: StudioPlacement, box: (width: Double, height: Double), fontScale: Double? = nil,
        showHeader: Bool = true, time: String, showDate: Bool, dateStyle: ClockDateStyle, zone: String?
    ) -> StudioClockLayout {
        let scale = effectiveFontScale(fontScale)
        let sizes = typeScale(.clock, placement: placement, fontScale: scale, showHeader: showHeader)
        let timeMin = sizes[.clockMin]!
        let dateSize = showDate
            ? fitTextSize(clockDateSample(dateStyle), maxWidth: box.width, min: sizes[.any]!, max: sizes[.date]!)
            : nil
        let zoneSize: Double? = zone.flatMap {
            estimateTextWidth(zoneLabelSample($0), fontSize: sizes[.zone]!) <= box.width ? sizes[.zone]! : nil
        }
        func linesHeight(_ date: Bool, _ zone: Bool) -> Double {
            (date ? (dateSize ?? 0) * 1.15 : 0) + (zone ? (zoneSize ?? 0) * 1.15 : 0)
        }
        func fits(_ date: Bool, _ zone: Bool) -> Bool {
            (!date || dateSize != nil) && (!zone || zoneSize != nil) && timeMin + linesHeight(date, zone) <= box.height
        }
        let wantZone = zone != nil
        let candidates: [(Bool, Bool)] = [(showDate, wantZone), (showDate, false), (false, false)]
        let chosen = candidates.first { fits($0.0, $0.1) } ?? (false, false)
        let used = linesHeight(chosen.0, chosen.1)
        let maximum = Swift.max(timeMin, Swift.min(sizes[.clockMax]!, box.height - used))
        // Widest digits, so the size does not change from minute to minute.
        let sample = String(time.map { $0.isASCII && $0.isNumber ? "0" : $0 })
        let size = fitTextSize(sample, maxWidth: box.width, min: timeMin, max: maximum, weight: .semibold) ?? timeMin
        return StudioClockLayout(
            time: size, date: chosen.0 ? dateSize : nil, zone: chosen.1 ? zoneSize : nil,
            hidden: chosen.0 != showDate || chosen.1 != wantZone)
    }

    // MARK: Label fit

    public static let labelMaxLines = 2

    /** "Downloads · Wurfel" → ("Downloads", "Wurfel"); otherwise all title. */
    public static func labelParts(_ label: String) -> (title: String, resource: String?) {
        let units = Array(label.utf16)
        let separator = Array(" · ".utf16)
        guard let at = indexOf(separator, in: units, from: 0) else { return (label, nil) }
        let title = trimWhitespace(string(units[0..<at]))
        let resource = trimWhitespace(string(units[(at + separator.count)...]))
        if title.isEmpty || resource.isEmpty { return (label, nil) }
        return (title, resource)
    }

    static func trimWhitespace(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /**
     * How a data widget's label wraps (title and resource line) at the
     * format's reference canvas (1080p at 16x9, the default). A stretched
     * screen only ever gives a cell more room than the reference (ADR 0017,
     * section 2).
     */
    public static func labelFit(
        _ label: String, type: StudioWidgetType, w: Int, h: Int, fontScale: Double? = nil,
        format: ScreenFormat = .widescreen
    ) -> StudioLabelFit {
        guard type.hasLabel else { return StudioLabelFit(fits: true, titleLines: 0, resourceLines: 0) }
        let scale = effectiveFontScale(fontScale)
        let rect = placementRect(
            StudioPlacement(x: 0, y: 0, w: w, h: h),
            frame: screenFrame(screen: format.spec.reference, format: format, showHeader: true))
        let width = rect.width - 2 * widgetPadding
        let parts = labelParts(label)
        let titleLines = wrappedLineCount(
            parts.title, maxWidth: width, fontSize: Minimum.title * scale, weight: .semibold)
        let resourceLines = parts.resource.map {
            wrappedLineCount($0, maxWidth: width, fontSize: Minimum.resource * scale, weight: .semibold)
        } ?? 0
        return StudioLabelFit(
            fits: titleLines <= labelMaxLines && resourceLines <= labelMaxLines,
            titleLines: titleLines,
            resourceLines: resourceLines)
    }

    /** Whether the widget shows its label without truncating it. */
    public static func fits(
        _ label: String, type: StudioWidgetType, w: Int, h: Int, fontScale: Double? = nil,
        format: ScreenFormat = .widescreen
    ) -> Bool {
        labelFit(label, type: type, w: w, h: h, fontScale: fontScale, format: format).fits
    }

    // MARK: Table (ADR 0019 section 6)

    /** Line height of a table's text, as STUDIO_LINE_HEIGHT. */
    static let tableLineHeight = 1.15

    /** A table's spacing in units. */
    public enum TableSpacing {
        /** Between the label, the subtitle, the column heads and the footer. */
        public static let stack = 8.0
        /** Above every row: the row pitch is the cell line plus this. */
        public static let rowGap = 12.0
        /** Between the label, value and change columns. */
        public static let columnGap = 16.0
    }

    /** The widest change the Δ column reserves room for. */
    public static let tableChangeSample = "+999 %"

    /** Below this share of the width the value column goes compact. */
    public static let tableMinLabelShare = 0.4

    public struct TableValueText: Sendable, Equatable {
        public var full: String
        public var compact: String
        public init(full: String, compact: String) {
            self.full = full
            self.compact = compact
        }
    }

    public struct TableSizes: Sendable, Equatable {
        public var title: Double
        public var resource: Double
        public var subtitle: Double
        public var columnHead: Double
        public var cell: Double
        public var cellMin: Double
    }

    public struct TableColumns: Sendable, Equatable {
        public var label: Double
        public var value: Double
        public var change: Double
        public var gap: Double
    }

    public struct TableLayout: Sendable, Equatable {
        public var sizes: TableSizes
        public var titleLines: Int
        public var resourceLines: Int
        public var headHeight: Double
        public var footerHeight: Double
        public var rowPitch: Double
        public var rowCapacity: Int
        public var columns: TableColumns
        public var compact: Bool
    }

    /**
     * A table widget's layout (tableLayout in the TypeScript): label,
     * subtitle, column heads, rows and footer in a content box in units.
     */
    public static func tableLayout(
        label: String, width inputWidth: Double, height: Double, fontScale: Double? = nil,
        values: [TableValueText] = [], showChange: Bool = true
    ) -> TableLayout {
        let scale = effectiveFontScale(fontScale)
        let sizes = TableSizes(
            title: Minimum.title * scale,
            resource: Minimum.resource * scale,
            subtitle: Minimum.any * scale,
            columnHead: Minimum.columnHead * scale,
            cell: Minimum.cell * scale,
            cellMin: Minimum.any * scale)
        let width = Swift.max(0, inputWidth)
        let parts = labelParts(label)
        let titleLines = Swift.min(
            labelMaxLines,
            Swift.max(1, wrappedLineCount(parts.title, maxWidth: width, fontSize: sizes.title, weight: .semibold)))
        let resourceLines = parts.resource.map {
            Swift.min(
                labelMaxLines,
                Swift.max(1, wrappedLineCount($0, maxWidth: width, fontSize: sizes.resource, weight: .semibold)))
        } ?? 0
        let headHeight =
            Double(titleLines) * sizes.title * tableLineHeight
            + Double(resourceLines) * sizes.resource * tableLineHeight
            + TableSpacing.stack
            + sizes.subtitle * tableLineHeight
            + TableSpacing.stack
            + sizes.columnHead * tableLineHeight
        let footerHeight = TableSpacing.stack + sizes.subtitle * tableLineHeight
        let rowPitch = sizes.cell * tableLineHeight + TableSpacing.rowGap
        let rowCapacity = Swift.max(0, Int(((height - headHeight - footerHeight) / rowPitch).rounded(.down)))

        let gap = TableSpacing.columnGap
        let change = showChange ? estimateTextWidth(tableChangeSample, fontSize: sizes.cell, weight: .semibold) : 0
        func widest(_ compactForm: Bool) -> Double {
            var result = 0.0
            for entry in values {
                let text = compactForm ? entry.compact : entry.full
                result = Swift.max(result, estimateTextWidth(text, fontSize: sizes.cell, weight: .semibold))
            }
            return result
        }
        func reserved(_ value: Double) -> Double {
            value + gap + (change > 0 ? change + gap : 0)
        }
        var value = widest(false)
        var compact = false
        if width - reserved(value) < width * tableMinLabelShare {
            let compactWidth = widest(true)
            if compactWidth < value {
                value = compactWidth
                compact = true
            }
        }
        return TableLayout(
            sizes: sizes, titleLines: titleLines, resourceLines: resourceLines, headHeight: headHeight,
            footerHeight: footerHeight, rowPitch: rowPitch, rowCapacity: rowCapacity,
            columns: TableColumns(label: Swift.max(0, width - reserved(value)), value: value, change: change, gap: gap),
            compact: compact)
    }

    /** Rows a table shows: its limit, its rows and the room, whichever is least. */
    public static func tableRowsShown(limit: Int, rows: Int, rowCapacity: Int) -> Int {
        Swift.max(0, Swift.min(limit, rows, rowCapacity))
    }

    /** A row label's size: shrunk down to cellMin, then truncated. */
    public static func tableRowLabel(_ text: String, labelWidth: Double, cell: Double, cellMin: Double)
        -> (size: Double, truncated: Bool)
    {
        if let size = fitTextSize(text, maxWidth: labelWidth, min: cellMin, max: cell) {
            return (size, false)
        }
        return (cellMin, true)
    }

    public enum TableChangeKind: String, Sendable, Equatable {
        case ratio, new, none
    }

    /** What a row's Δ shows: the ratio, "new", or "–". */
    public static func tableChangeKind(value: Double?, previousValue: Double?, ratio: Double?) -> TableChangeKind {
        if let ratio, ratio.isFinite { return .ratio }
        if let value, value != 0, previousValue == nil || previousValue == 0 { return .new }
        return .none
    }

    // MARK: Status board (ADR 0019 section 7)

    /** A status board's spacing in units. */
    public enum StatusSpacing {
        /** Between the rows and the footer. */
        public static let stack = 8.0
        /** Above every row: the row pitch is the cell line plus this. */
        public static let rowGap = 12.0
        /** Between the dot, the name and the age. */
        public static let columnGap = 16.0
        /** The health dot's diameter. */
        public static let dot = 14.0
    }

    /** The widest age the age column reserves room for. */
    public static let statusAgeSample = "99 m"

    public struct StatusSizes: Sendable, Equatable {
        public var title: Double
        public var resource: Double
        public var cell: Double
        public var cellMin: Double
        public var age: Double
        public var footer: Double
    }

    public struct StatusColumns: Sendable, Equatable {
        public var dot: Double
        public var name: Double
        public var age: Double
        public var gap: Double
    }

    public struct StatusLayout: Sendable, Equatable {
        public var sizes: StatusSizes
        public var titleLines: Int
        public var resourceLines: Int
        public var headHeight: Double
        public var footerHeight: Double
        public var rowPitch: Double
        /** Rows between the label and the footer ("+N more" included). */
        public var rowCapacity: Int
        public var columns: StatusColumns
    }

    /**
     * A status board's layout (statusLayout in the TypeScript): the label,
     * rows of a 14 u dot, the name (cell, 28 u) and the age (24 u), each a
     * cell line plus a 12 u gap, and the footer. A 3 × 3 board at 16:9
     * fits five rows at font scale 1 and three at 1.3.
     */
    public static func statusLayout(
        label: String, width inputWidth: Double, height: Double, fontScale: Double? = nil, showAge: Bool = true
    ) -> StatusLayout {
        let scale = effectiveFontScale(fontScale)
        let sizes = StatusSizes(
            title: Minimum.title * scale,
            resource: Minimum.resource * scale,
            cell: Minimum.cell * scale,
            cellMin: Minimum.any * scale,
            age: Minimum.any * scale,
            footer: Minimum.any * scale)
        let width = Swift.max(0, inputWidth)
        let parts = labelParts(label)
        let titleLines = Swift.min(
            labelMaxLines,
            Swift.max(1, wrappedLineCount(parts.title, maxWidth: width, fontSize: sizes.title, weight: .semibold)))
        let resourceLines = parts.resource.map {
            Swift.min(
                labelMaxLines,
                Swift.max(1, wrappedLineCount($0, maxWidth: width, fontSize: sizes.resource, weight: .semibold)))
        } ?? 0
        let headHeight =
            Double(titleLines) * sizes.title * tableLineHeight
            + Double(resourceLines) * sizes.resource * tableLineHeight
        let footerHeight = StatusSpacing.stack + sizes.footer * tableLineHeight
        let rowPitch = sizes.cell * tableLineHeight + StatusSpacing.rowGap
        let rowCapacity = Swift.max(0, Int(((height - headHeight - footerHeight) / rowPitch).rounded(.down)))
        let gap = StatusSpacing.columnGap
        let dot = StatusSpacing.dot * scale
        let age = showAge ? estimateTextWidth(statusAgeSample, fontSize: sizes.age, weight: .regular) : 0
        return StatusLayout(
            sizes: sizes, titleLines: titleLines, resourceLines: resourceLines, headHeight: headHeight,
            footerHeight: footerHeight, rowPitch: rowPitch, rowCapacity: rowCapacity,
            columns: StatusColumns(
                dot: dot, name: Swift.max(0, width - dot - gap - (age > 0 ? age + gap : 0)), age: age, gap: gap))
    }

    /**
     * Items a board lists and what "+N more" counts: all when they fit, else
     * the first rowCapacity − 1 and "+N more" for the rest.
     */
    public static func statusRowsShown(items: Int, rowCapacity: Int) -> (shown: Int, more: Int) {
        let count = Swift.max(0, items)
        let capacity = Swift.max(0, rowCapacity)
        if count <= capacity { return (count, 0) }
        if capacity == 0 { return (0, 0) }
        return (capacity - 1, count - (capacity - 1))
    }

    /** A name's size: shrunk down to cellMin, then truncated. */
    public static func statusRowLabel(_ text: String, nameWidth: Double, cell: Double, cellMin: Double)
        -> (size: Double, truncated: Bool)
    {
        tableRowLabel(text, labelWidth: nameWidth, cell: cell, cellMin: cellMin)
    }

    public enum StatusAgeUnit: String, Sendable, Equatable {
        case m, h, d
    }

    /**
     * The age of a last successful sync: whole minutes under an hour, whole
     * hours under a day, else whole days; nil without one (statusAge in the
     * TypeScript).
     */
    public static func statusAge(_ lastSuccessAt: String?, now: Date) -> (amount: Int, unit: StatusAgeUnit)? {
        guard let lastSuccessAt, let at = parseISODate(lastSuccessAt) else { return nil }
        let minutes = Swift.max(0, Int((now.timeIntervalSince(at) * 1000 / 60_000).rounded(.down)))
        if minutes < 60 { return (minutes, .m) }
        let hours = minutes / 60
        if hours < 24 { return (hours, .h) }
        return (hours / 24, .d)
    }

    /** An ISO 8601 timestamp, with or without fractional seconds. */
    static func parseISODate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }

    // MARK: Legacy layout (tile migration)

    public static let legacyMaxColumns = 4
    public static let legacyMaxRows = 4
    public static let legacyTilesPerSlide = 16

    /** tvGrid's columns and rows, restricted to 4 × 4 (first slide). */
    public static func legacyGrid(_ tiles: Int) -> (columns: Int, rows: Int) {
        let count = Swift.min(tiles, legacyTilesPerSlide)
        guard count > 1 else { return (1, 1) }
        let screenAspect = 16.0 / 9.0
        var best = (columns: 0, rows: 0, score: Double.infinity)
        for columns in 1...Swift.min(count, legacyMaxColumns) {
            let rows = (count + columns - 1) / columns
            if rows > legacyMaxRows { continue }
            let tileAspect = (screenAspect * Double(rows)) / Double(columns)
            let empty = columns * rows - count
            let score = abs(log(tileAspect / 1.2)) + 0.5 * Double(empty)
            if score < best.score {
                best = (columns, rows, score)
            }
        }
        return (best.columns, best.rows)
    }

    /** Placements for migrated tiles in reading order, one array per slide. */
    public static func legacyLayout(_ tiles: Int) -> [[StudioPlacement]] {
        let count = Swift.max(0, tiles)
        if count == 0 { return [[]] }
        var slides: [[StudioPlacement]] = []
        var start = 0
        while start < count {
            let onSlide = Swift.min(legacyTilesPerSlide, count - start)
            let grid = legacyGrid(onSlide)
            let width = columns / grid.columns
            func rowStart(_ row: Int) -> Int { (row * rows) / grid.rows }
            var placements: [StudioPlacement] = []
            for index in 0..<onSlide {
                let row = index / grid.columns
                let column = index % grid.columns
                placements.append(StudioPlacement(
                    x: column * width, y: rowStart(row), w: width, h: rowStart(row + 1) - rowStart(row)))
            }
            slides.append(placements)
            start += legacyTilesPerSlide
        }
        return slides
    }

    // MARK: Markdown-lite (text widget)

    // The parser works on UTF-16 code units like the TypeScript; markers are
    // ASCII, so a split never falls inside a character.
    private static let star = UInt16(UInt8(ascii: "*"))
    private static let space = UInt16(UInt8(ascii: " "))
    private static let tab = UInt16(UInt8(ascii: "\t"))
    private static let hash = UInt16(UInt8(ascii: "#"))

    private static func string<C: Collection>(_ units: C) -> String where C.Element == UInt16 {
        String(decoding: Array(units), as: UTF16.self)
    }

    private static func indexOf(_ needle: [UInt16], in units: [UInt16], from: Int) -> Int? {
        guard needle.count <= units.count, from <= units.count - needle.count else { return nil }
        for index in from...(units.count - needle.count) where starts(units, needle, at: index) {
            return index
        }
        return nil
    }

    private static func starts(_ units: [UInt16], _ prefix: [UInt16], at index: Int) -> Bool {
        guard index >= 0, index + prefix.count <= units.count else { return false }
        for offset in prefix.indices where units[index + offset] != prefix[offset] {
            return false
        }
        return true
    }

    private static func isBlank(_ units: [UInt16], _ index: Int) -> Bool {
        guard index >= 0, index < units.count else { return true }
        return units[index] == space || units[index] == tab
    }

    private static func findClose(_ text: [UInt16], from: Int, marker: Int) -> Int? {
        let markerUnits = Array(repeating: star, count: marker)
        let pair: [UInt16] = [star, star]
        var j = from
        while j < text.count {
            if marker == 1 && starts(text, pair, at: j) {
                if let inner = indexOf(pair, in: text, from: j + 2) {
                    j = inner + 2
                } else {
                    j += 2
                }
                continue
            }
            if starts(text, markerUnits, at: j) && !isBlank(text, j - 1) && j > from {
                // "***" closes bold with its last two stars, after an inner italic.
                return marker == 2 && starts(text, [star, star, star], at: j) ? j + 1 : j
            }
            j += 1
        }
        return nil
    }

    private static func parseInline(_ text: [UInt16], bold: Bool, italic: Bool) -> [StudioTextSpan] {
        var spans: [StudioTextSpan] = []
        var literal: [UInt16] = []
        func flush() {
            if !literal.isEmpty {
                spans.append(StudioTextSpan(text: string(literal), bold: bold, italic: italic))
                literal = []
            }
        }
        var i = 0
        while i < text.count {
            if !bold && starts(text, [star, star], at: i) && !isBlank(text, i + 2),
                let close = findClose(text, from: i + 2, marker: 2), close > i + 2
            {
                flush()
                spans += parseInline(Array(text[(i + 2)..<close]), bold: true, italic: italic)
                i = close + 2
                continue
            }
            if !italic && text[i] == star && !(i + 1 < text.count && text[i + 1] == star) && !isBlank(text, i + 1),
                let close = findClose(text, from: i + 1, marker: 1), close > i + 1
            {
                flush()
                spans += parseInline(Array(text[(i + 1)..<close]), bold: bold, italic: true)
                i = close + 1
                continue
            }
            literal.append(text[i])
            i += 1
        }
        flush()
        return spans
    }

    private static func merge(_ spans: [StudioTextSpan]) -> [StudioTextSpan] {
        var merged: [StudioTextSpan] = []
        for span in spans {
            if let last = merged.last, last.bold == span.bold, last.italic == span.italic {
                merged[merged.count - 1].text += span.text
            } else {
                merged.append(span)
            }
        }
        return merged
    }

    private static func trimBlanks(_ units: [UInt16]) -> [UInt16] {
        var start = 0
        var end = units.count
        while start < end && (units[start] == space || units[start] == tab) { start += 1 }
        while end > start && (units[end - 1] == space || units[end - 1] == tab) { end -= 1 }
        return Array(units[start..<end])
    }

    /**
     * The text widget's markdown-lite: paragraphs, line breaks, `#`/`##`
     * headings, `**bold**` and `*italic*`; everything else literal, never
     * HTML.
     */
    public static func parseText(_ source: String) -> [StudioTextBlock] {
        var blocks: [StudioTextBlock] = []
        var inParagraph = false
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let newline = UInt16(UInt8(ascii: "\n"))
        let lines = Array(normalised.utf16).split(separator: newline, omittingEmptySubsequences: false)
        for raw in lines {
            let line = trimBlanks(Array(raw))
            if line.isEmpty {
                inParagraph = false
                continue
            }
            let level = starts(line, [hash, hash, space], at: 0) ? 2 : starts(line, [hash, space], at: 0) ? 1 : 0
            if level != 0 {
                var text = Array(line[(level + 1)...])
                while let first = text.first, first == space || first == tab { text.removeFirst() }
                if !text.isEmpty {
                    blocks.append(.heading(level: level, spans: merge(parseInline(text, bold: false, italic: false))))
                    inParagraph = false
                    continue
                }
            }
            let spans = merge(parseInline(line, bold: false, italic: false))
            if inParagraph, case .paragraph(var existing) = blocks.last {
                existing.append(spans)
                blocks[blocks.count - 1] = .paragraph(lines: existing)
            } else {
                blocks.append(.paragraph(lines: [spans]))
                inParagraph = true
            }
        }
        return blocks
    }

    // MARK: Compact numbers

    static let compactSuffixes = ["", "K", "M", "B", "T"]

    private static func fixed(_ value: Double, digits: Int) -> String {
        let text = String(format: "%.\(digits)f", locale: Locale(identifier: "en_US_POSIX"), value)
        guard text.contains(".") else { return text }
        var trimmed = Substring(text)
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return String(trimmed)
    }

    /**
     * 12.3K, 4.2M, 1.5B (en-US compact, at most one decimal, half away from
     * zero); below 1,000 the plain number (no decimals from 100, else up to
     * two). The web's formatValue compacts from 10,000 with the same rules.
     */
    public static func compactNumber(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        let sign = value < 0 ? "-" : ""
        let magnitude = abs(value)
        if magnitude < 1000 {
            let digits = magnitude >= 100 ? 0 : 2
            let factor = pow(10.0, Double(digits))
            let rounded = (magnitude * factor).rounded(.toNearestOrAwayFromZero) / factor
            if rounded >= 1000 { return "\(sign)1K" }
            let text = fixed(rounded, digits: digits)
            return text == "0" ? "0" : "\(sign)\(text)"
        }
        var tier = 1
        while tier < compactSuffixes.count - 1 && magnitude >= pow(1000.0, Double(tier + 1)) {
            tier += 1
        }
        var tenths = ((magnitude * 10) / pow(1000.0, Double(tier))).rounded(.toNearestOrAwayFromZero)
        if tenths >= 10000 && tier < compactSuffixes.count - 1 {
            tier += 1
            tenths = ((magnitude * 10) / pow(1000.0, Double(tier))).rounded(.toNearestOrAwayFromZero)
        }
        let whole = (tenths / 10).rounded(.down)
        let fraction = tenths - whole * 10
        let wholeText = String(format: "%.0f", locale: Locale(identifier: "en_US_POSIX"), whole)
        let fractionText = fraction == 0 ? "" : ".\(String(format: "%.0f", locale: Locale(identifier: "en_US_POSIX"), fraction))"
        return "\(sign)\(wholeText)\(fractionText)\(compactSuffixes[tier])"
    }
}
