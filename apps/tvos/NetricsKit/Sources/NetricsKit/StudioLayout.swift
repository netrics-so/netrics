import Foundation

// Dashboard Studio layout and readability rules (ADR 0015, section 8), a
// port of packages/domain/src/studio-layout.ts. Both sides run the vectors in
// packages/domain/test-vectors/studio-layout.json (StudioLayoutTests), so
// keep the arithmetic in the same order as the TypeScript.
//
// Sizes are in canvas units: u = canvas height / 1080. Functions that take a
// canvas answer in canvas points; the type scale answers in units.

public enum StudioWidgetType: String, Sendable, Equatable, CaseIterable, Codable {
    case metric, line, bar, image, text, clock

    /** Widgets with a title and resource line (bound to a metric). */
    public var isData: Bool { self == .metric || self == .line || self == .bar }
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
    case valueMin, valueMax, clockMin, clockMax, date
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

    /** How a data widget's label wraps at 1080p (title and resource line). */
    public static func labelFit(_ label: String, type: StudioWidgetType, w: Int, h: Int, fontScale: Double? = nil)
        -> StudioLabelFit
    {
        guard type.isData else { return StudioLabelFit(fits: true, titleLines: 0, resourceLines: 0) }
        let scale = effectiveFontScale(fontScale)
        let rect = widgetRect(StudioPlacement(x: 0, y: 0, w: w, h: h), canvas: referenceCanvas, showHeader: true)
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
    public static func fits(_ label: String, type: StudioWidgetType, w: Int, h: Int, fontScale: Double? = nil) -> Bool {
        labelFit(label, type: type, w: w, h: h, fontScale: fontScale).fits
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
