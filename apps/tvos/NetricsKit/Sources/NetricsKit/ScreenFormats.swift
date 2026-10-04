// Screen formats, auto reflow, custom layouts and the scroll view layout
// (ADR 0017, sections 1–5), a port of packages/domain/src/screen-formats.ts
// and the format part of studio-layout.ts. Both sides run the vectors in
// packages/domain/test-vectors/screen-formats.json (ScreenFormatsTests),
// which are normative: keep every function pure, integer-only where it
// places cells, and its steps in the same order as the TypeScript. Rounding
// is floor(v + 0.5); ties are broken by input position, never by comparing
// ids. No Foundation formatting here.

/** The five format classes; `16x9` is the default primary format. */
public enum ScreenFormat: String, Sendable, Equatable, Hashable, CaseIterable, Codable {
    // Declared widest first, like SCREEN_FORMAT_KEYS.
    case ultrawide = "21x9"
    case widescreen = "16x9"
    case standard = "4x3"
    case portrait = "3x4"
    case tall = "9x16"

    /** Grid and reference canvas (its short edge is always 1080). */
    public var spec: ScreenFormatSpec {
        switch self {
        case .widescreen:
            return ScreenFormatSpec(
                key: self, columns: StudioLayout.columns, rows: StudioLayout.rows,
                reference: StudioLayout.referenceCanvas)
        case .ultrawide:
            return ScreenFormatSpec(key: self, columns: 16, rows: 8, reference: StudioCanvas(width: 2520, height: 1080))
        case .standard:
            return ScreenFormatSpec(key: self, columns: 9, rows: 8, reference: StudioCanvas(width: 1440, height: 1080))
        case .portrait:
            return ScreenFormatSpec(key: self, columns: 6, rows: 10, reference: StudioCanvas(width: 1080, height: 1440))
        case .tall:
            return ScreenFormatSpec(key: self, columns: 6, rows: 14, reference: StudioCanvas(width: 1080, height: 1920))
        }
    }
}

public struct ScreenFormatSpec: Sendable, Equatable {
    public var key: ScreenFormat
    /** Grid columns and rows. */
    public var columns: Int
    public var rows: Int
    /** The canvas units are defined on. */
    public var reference: StudioCanvas
}

public enum ScreenSizeClass: String, Sendable, Equatable, CaseIterable, Codable {
    case compact, regular, large
}

public struct ScreenFrame: Sendable, Equatable {
    public var format: ScreenFormat
    public var columns: Int
    public var rows: Int
    /** Screen points per unit: min(width / refWidth, height / refHeight). */
    public var unit: Double
    /** The area the slide fills: the screen, or the stretch-capped canvas centred on it. */
    public var canvas: StudioRect
    /** The header band (0.07 × 1080 units high), nil without the header. */
    public var header: StudioRect?
    /** The area the cells and their gaps fill. */
    public var grid: StudioRect
}

/** Anything placed on whole grid cells. */
public protocol StudioPlaced {
    var x: Int { get }
    var y: Int { get }
    var w: Int { get }
    var h: Int { get }
}

extension StudioPlaced {
    public var cells: StudioPlacement { StudioPlacement(x: x, y: y, w: w, h: h) }
}

extension StudioPlacement: StudioPlaced {}

// MARK: - Formats and frames (sections 1 and 2)

extension StudioLayout {
    /** A grid stretches at most this much against its format's aspect ratio. */
    public static let screenMaxStretch = 4.0 / 3.0

    /** The largest grid of any format. */
    public static let screenFormatMaxGrid = (columns: 16, rows: 14)

    /**
     * The format of a screen of this size (points, after any rotation): the
     * closest aspect ratio on a log scale (boundaries 2.04, 1.54, 1.00 and
     * 0.65). An unusable size (zero, negative, not finite) is 16x9.
     */
    public static func formatFor(width: Double, height: Double) -> ScreenFormat {
        if !width.isFinite || !height.isFinite || width <= 0 || height <= 0 {
            return .widescreen
        }
        let aspect = width / height
        if aspect >= 2.04 { return .ultrawide }
        if aspect >= 1.54 { return .widescreen }
        if aspect >= 1 { return .standard }
        if aspect >= 0.65 { return .portrait }
        return .tall
    }

    /** Size class by the short edge: compact below 600, regular below 1100, else large. */
    public static func sizeClassFor(width: Double, height: Double) -> ScreenSizeClass {
        // Math.min: NaN when either is NaN, which is compact.
        let short = width.isNaN || height.isNaN ? Double.nan : Swift.min(width, height)
        if !(short >= 600) { return .compact }
        if short < 1100 { return .regular }
        return .large
    }

    /**
     * Where a format's grid goes on a real screen in screen view: the grid
     * fills the screen (inset by the padding, below the header band), cells
     * stretching at most by 4/3; beyond that the capped canvas is centred.
     * At a 16:9 screen and 16x9 this is exactly `frame(canvas:showHeader:)`.
     */
    public static func screenFrame(screen: StudioCanvas, format: ScreenFormat, showHeader: Bool) -> ScreenFrame {
        let spec = format.spec
        let reference = referenceCanvas.height
        let unitLength = Swift.min(
            (screen.width * reference) / spec.reference.width,
            (screen.height * reference) / spec.reference.height)
        let unit = unitLength / reference
        let width = Swift.min(screen.width, spec.reference.width * unit * screenMaxStretch)
        let height = Swift.min(screen.height, spec.reference.height * unit * screenMaxStretch)
        let x = (screen.width - width) / 2
        let y = (screen.height - height) / 2
        let headerHeight = showHeader ? unitLength * headerBand : 0
        let pad = padding * unit
        return ScreenFrame(
            format: format,
            columns: spec.columns,
            rows: spec.rows,
            unit: unit,
            canvas: StudioRect(x: x, y: y, width: width, height: height),
            header: showHeader ? StudioRect(x: x, y: y, width: width, height: headerHeight) : nil,
            grid: StudioRect(
                x: x + pad,
                y: y + headerHeight + pad,
                width: width - 2 * pad,
                height: height - headerHeight - 2 * pad))
    }

    /** A placement's rect in screen points, on a frame from `screenFrame`. */
    public static func placementRect(_ placement: StudioPlacement, frame: ScreenFrame) -> StudioRect {
        let grid = frame.grid
        let gap = self.gap * frame.unit
        let cellWidth = (grid.width - gap * Double(frame.columns - 1)) / Double(frame.columns)
        let cellHeight = (grid.height - gap * Double(frame.rows - 1)) / Double(frame.rows)
        return StudioRect(
            x: grid.x + Double(placement.x) * (cellWidth + gap),
            y: grid.y + Double(placement.y) * (cellHeight + gap),
            width: Double(placement.w) * cellWidth + Double(placement.w - 1) * gap,
            height: Double(placement.h) * cellHeight + Double(placement.h - 1) * gap)
    }

    /** At least 1 × 1, inside the format's grid. */
    public static func isInsideFormatGrid(_ p: StudioPlacement, format: ScreenFormat) -> Bool {
        let spec = format.spec
        return p.x >= 0 && p.y >= 0 && p.w >= 1 && p.h >= 1 && p.x + p.w <= spec.columns
            && p.y + p.h <= spec.rows
    }
}

// MARK: - Layout types

/** A widget of a slide: its id, type and placement in some format. */
public struct LayoutWidget: StudioPlaced, Sendable, Equatable {
    public var id: String
    public var type: StudioWidgetType
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    /**
     * The type's minimum size as a schema 3 payload carries it (ADR 0019
     * section 2): a type this build does not know is laid out with it. Nil:
     * the type's own minimum.
     */
    public var minimum: StudioMinimum?

    public init(
        id: String, type: StudioWidgetType, x: Int, y: Int, w: Int, h: Int, minimum: StudioMinimum? = nil
    ) {
        self.id = id
        self.type = type
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.minimum = minimum
    }
}

/** A widget type's minimum size in cells. */
public struct StudioMinimum: Sendable, Equatable, Codable {
    public var w: Int
    public var h: Int

    public init(w: Int, h: Int) {
        self.w = w
        self.h = h
    }
}

/** A widget's placement in a format, by id. */
public struct LayoutPlacement: StudioPlaced, Sendable, Equatable {
    public var id: String
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int

    public init(id: String, x: Int, y: Int, w: Int, h: Int) {
        self.id = id
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/** A widget's placement in a custom layout of a format. */
public struct CustomPlacement: StudioPlaced, Sendable, Equatable {
    public var id: String
    /** 0-based page. */
    public var page: Int
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    /** Hidden in this format: an explicit choice, listed in the Studio. */
    public var hidden: Bool
    /** Placed automatically after a primary change: "to review". */
    public var autoPlaced: Bool

    public init(id: String, page: Int, x: Int, y: Int, w: Int, h: Int, hidden: Bool, autoPlaced: Bool) {
        self.id = id
        self.page = page
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.hidden = hidden
        self.autoPlaced = autoPlaced
    }
}

/** A slide's stored layout in one non-primary format. */
public struct CustomLayout: Sendable, Equatable {
    /** 1 to `ScreenLayout.customLayoutMaxPages`. */
    public var pages: Int
    public var placements: [CustomPlacement]

    public init(pages: Int, placements: [CustomPlacement]) {
        self.pages = pages
        self.placements = placements
    }
}

public enum CustomLayoutProblemCode: String, Sendable, Equatable, CaseIterable {
    /** `pages` is not from 1 to 8. */
    case invalidPageCount = "invalid_page_count"
    /** A placement's page is not one of the layout's pages. */
    case pageOutOfRange = "page_out_of_range"
    /** A placement is outside the format's grid. */
    case widgetOutOfBounds = "widget_out_of_bounds"
    /** A placement is below its widget type's minimum size. */
    case widgetTooSmall = "widget_too_small"
    /** Two visible placements on one page overlap. */
    case widgetsOverlap = "widgets_overlap"
    /** A widget of the slide has no placement. */
    case widgetMissing = "widget_missing"
    /** A widget has more than one placement. */
    case widgetDuplicated = "widget_duplicated"
    /** A placement names a widget the slide does not have. */
    case unknownWidget = "unknown_widget"
}

public struct CustomLayoutProblem: Sendable, Equatable {
    public var code: CustomLayoutProblemCode
    /** The widget concerned (the later one for an overlap). */
    public var widgetId: String?

    public init(code: CustomLayoutProblemCode, widgetId: String?) {
        self.code = code
        self.widgetId = widgetId
    }
}

public enum DisplayMode: String, Sendable, Equatable, CaseIterable, Codable {
    case screen, scroll
}

public enum ScreenKind: String, Sendable, Equatable, CaseIterable, Codable {
    case tvos, kiosk, browser
}

/** A widget card's height rule in scroll view. */
public enum ScrollItemHeight: String, Sendable, Equatable, Codable {
    /** Fits its content (metrics, text, clocks). */
    case content
    /** 16:9 of its width, at least `ScreenLayout.scrollChartMinHeight`. */
    case chart
    /** Keeps the image's aspect, at most half the viewport height. */
    case image
}

public struct ScrollItem: Sendable, Equatable {
    public var id: String
    public var type: StudioWidgetType
    /** 0-based row of the flow. */
    public var row: Int
    /** 0-based first column. */
    public var column: Int
    /** Columns spanned: 1 or all. */
    public var span: Int
    public var height: ScrollItemHeight
}

public struct ScrollLayout: Sendable, Equatable {
    public var columns: Int
    /** The content width: the viewport width, at most 1200. */
    public var contentWidth: Double
    public var items: [ScrollItem]
}

// MARK: - Screen layout

public enum ScreenLayout {
    /** A custom layout has at most this many pages. */
    public static let customLayoutMaxPages = 8
    /** Scroll view content is at most this wide (points), centred. */
    public static let scrollMaxContentWidth = 1200.0
    public static let scrollChartMinHeight = 200.0

    /** round(v) = floor(v + 0.5), as the TypeScript rounds. */
    static func roundHalfUp(_ value: Double) -> Int {
        Int((value + 0.5).rounded(.down))
    }

    /** A grid edge (column) of `from` scaled to `to`, rounded. */
    static func scaleEdge(_ edge: Int, from: Int, to: Int) -> Int {
        roundHalfUp(Double(edge * to) / Double(from))
    }

    /** Floor division, as Math.floor(a / b) for b > 0. */
    static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    static func minimumOf(_ widget: LayoutWidget) -> (w: Int, h: Int) {
        if let minimum = widget.minimum { return (minimum.w, minimum.h) }
        return StudioLayout.minimumSize(widget.type)
    }

    // MARK: Bands, stacks and reading order (section 3, steps 1–3)

    struct Indexed<T> {
        var item: T
        var index: Int
    }

    struct Stack<T> {
        var left: Int
        var right: Int
        /** Members top to bottom, by (y, x). */
        var members: [Indexed<T>]
    }

    static func byRowThenColumn<T: StudioPlaced>(_ a: Indexed<T>, _ b: Indexed<T>) -> Bool {
        if a.item.y != b.item.y { return a.item.y < b.item.y }
        if a.item.x != b.item.x { return a.item.x < b.item.x }
        return a.index < b.index
    }

    static func byColumnThenRow<T: StudioPlaced>(_ a: Indexed<T>, _ b: Indexed<T>) -> Bool {
        if a.item.x != b.item.x { return a.item.x < b.item.x }
        if a.item.y != b.item.y { return a.item.y < b.item.y }
        return a.index < b.index
    }

    /**
     * The slide's bands (top to bottom) of stacks (left to right). A band is
     * a maximal run, by (y, x), in which each next widget starts above the
     * band's bottom; a stack a maximal run, by (x, y), in which each next
     * widget starts left of the stack's right edge.
     */
    static func bandsAndStacks<T: StudioPlaced>(_ items: [T]) -> [[Stack<T>]] {
        let sorted = items.enumerated().map { Indexed(item: $0.element, index: $0.offset) }
            .sorted { byRowThenColumn($0, $1) }
        var bands: [[Indexed<T>]] = []
        var bottom = 0
        for entry in sorted {
            if !bands.isEmpty && entry.item.y < bottom {
                bands[bands.count - 1].append(entry)
                bottom = Swift.max(bottom, entry.item.y + entry.item.h)
            } else {
                bands.append([entry])
                bottom = entry.item.y + entry.item.h
            }
        }
        return bands.map { band in
            var stacks: [Stack<T>] = []
            for entry in band.sorted(by: { byColumnThenRow($0, $1) }) {
                if !stacks.isEmpty && entry.item.x < stacks[stacks.count - 1].right {
                    stacks[stacks.count - 1].members.append(entry)
                    stacks[stacks.count - 1].right = Swift.max(
                        stacks[stacks.count - 1].right, entry.item.x + entry.item.w)
                } else {
                    stacks.append(Stack(left: entry.item.x, right: entry.item.x + entry.item.w, members: [entry]))
                }
            }
            for i in stacks.indices {
                stacks[i].members.sort { byRowThenColumn($0, $1) }
            }
            return stacks
        }
    }

    /**
     * Widgets in reading order: band by band, stack by stack, top to bottom
     * within a stack. Scroll view, the Studio's keyboard order in
     * non-primary formats and screen readers use it.
     */
    public static func studioReadingOrder<T: StudioPlaced>(_ widgets: [T]) -> [T] {
        bandsAndStacks(widgets).flatMap { stacks in
            stacks.flatMap { stack in stack.members.map(\.item) }
        }
    }

    // MARK: Reflow (section 3, steps 4–8)

    struct Block {
        /** Scaled left edge in the target grid. */
        var left: Int
        var width: Int
        /** Members top to bottom with their heights in rows. */
        var members: [(id: String, h: Int)]

        var height: Int { members.reduce(0) { $0 + $1.h } }
    }

    struct Shelf {
        var height: Int
        var blocks: [(x: Int, block: Block)]

        init(_ blocks: [(x: Int, block: Block)]) {
            self.blocks = blocks
            self.height = blocks.reduce(0) { Swift.max($0, $1.block.height) }
        }
    }

    /**
     * A stack's size in the target (step 4): rounded scaled edges, at least
     * the largest minimum width of its widgets, at most the grid; heights
     * keep their rows (at least the minimum, at most the grid). A stack
     * taller than the grid is split between widgets into consecutive stacks.
     */
    static func stackBlocks(_ stack: Stack<LayoutWidget>, from: ScreenFormat, to: ScreenFormat) -> [Block] {
        let source = from.spec
        let target = to.spec
        let left = scaleEdge(stack.left, from: source.columns, to: target.columns)
        let right = scaleEdge(stack.right, from: source.columns, to: target.columns)
        var width = right - left
        for member in stack.members {
            width = Swift.max(width, minimumOf(member.item).w)
        }
        width = Swift.min(width, target.columns)
        var blocks: [Block] = []
        var used = 0
        for member in stack.members {
            let h = Swift.min(Swift.max(member.item.h, minimumOf(member.item).h), target.rows)
            if blocks.isEmpty || used + h > target.rows {
                blocks.append(Block(left: left, width: width, members: []))
                used = 0
            }
            blocks[blocks.count - 1].members.append((member.item.id, h))
            used += h
        }
        return blocks
    }

    /** Greedy shelves: as many blocks per shelf as fit, in order. */
    static func greedyGroups(_ blocks: [Block], columns: Int) -> [[Block]] {
        var groups: [[Block]] = []
        var used = 0
        for block in blocks {
            if !groups.isEmpty && used + block.width <= columns {
                groups[groups.count - 1].append(block)
                used += block.width
            } else {
                groups.append([block])
                used = block.width
            }
        }
        return groups
    }

    static func totalWidth(_ blocks: [Block]) -> Int {
        blocks.reduce(0) { $0 + $1.width }
    }

    /**
     * A band's shelves (step 5). A band that fits on one shelf keeps its
     * scaled positions (moved right past the previous block and left so that
     * it and the blocks after it end inside the grid). Otherwise the band
     * wraps over the greedy number of shelves, the blocks spread as evenly
     * as possible by count (earlier shelves take the extra one; greedy when
     * the even split does not fit), and each shelf is justified: spare
     * columns go one at a time to its blocks, left to right.
     */
    static func bandShelves(_ blocks: [Block], columns: Int) -> [Shelf] {
        let total = totalWidth(blocks)
        if total <= columns {
            var end = 0
            var rest = total
            var placed: [(x: Int, block: Block)] = []
            for block in blocks {
                let x = Swift.min(Swift.max(block.left, end), columns - rest)
                placed.append((x, block))
                end = x + block.width
                rest -= block.width
            }
            return [Shelf(placed)]
        }
        let greedy = greedyGroups(blocks, columns: columns)
        let count = greedy.count
        let base = blocks.count / count
        let extra = blocks.count % count
        var even: [[Block]] = []
        var at = 0
        for shelf in 0..<count {
            let size = base + (shelf < extra ? 1 : 0)
            even.append(Array(blocks[at..<(at + size)]))
            at += size
        }
        let fits = even.allSatisfy { totalWidth($0) <= columns }
        return (fits ? even : greedy).map { group in
            let spare = columns - totalWidth(group)
            var x = 0
            var placed: [(x: Int, block: Block)] = []
            for (i, block) in group.enumerated() {
                var widened = block
                widened.width = block.width + floorDiv(spare, group.count) + (i < spare % group.count ? 1 : 0)
                placed.append((x, widened))
                x += widened.width
            }
            return Shelf(placed)
        }
    }

    /**
     * The auto layout of a slide in format `to`, from its widgets placed in
     * the primary format `from` (ADR 0017, section 3): one or more pages,
     * each a list of placements in reading order. Every widget is placed
     * exactly once, at least its minimum size, inside the grid, without
     * overlap; overflow becomes continuation pages. When `to` is `from` the
     * result is the primary layout as one page. A slide without widgets is
     * one empty page.
     */
    public static func reflowSlide(_ widgets: [LayoutWidget], from: ScreenFormat, to: ScreenFormat)
        -> [[LayoutPlacement]]
    {
        if from == to {
            return [studioReadingOrder(widgets).map { LayoutPlacement(id: $0.id, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }]
        }
        let target = to.spec
        // Steps 1–5: bands of stacks, sized, laid out on shelves.
        let shelves = bandsAndStacks(widgets).flatMap { stacks in
            bandShelves(stacks.flatMap { stackBlocks($0, from: from, to: to) }, columns: target.columns)
        }
        // Step 7: shelves top to bottom, a new page when one does not fit.
        var pages: [[Shelf]] = []
        var used = 0
        for shelf in shelves {
            if !pages.isEmpty && used + shelf.height <= target.rows {
                pages[pages.count - 1].append(shelf)
                used += shelf.height
            } else {
                pages.append([shelf])
                used = shelf.height
            }
        }
        if pages.isEmpty { return [[]] }
        return pages.map { placePage($0, rows: target.rows) }
    }

    /**
     * Steps 6 and 8 for one page: spare rows go to the shelves one at a
     * time, top to bottom, repeating, each growing by at most half its
     * height; what is left centres the page (offset rounded down). Within a
     * shelf every stack is stretched to the shelf height, the extra rows
     * going to its last widget.
     */
    static func placePage(_ page: [Shelf], rows: Int) -> [LayoutPlacement] {
        let heights = page.map(\.height)
        let limits = page.map { floorDiv($0.height, 2) }
        var grown = page.map { _ in 0 }
        var spare = rows - heights.reduce(0, +)
        var growing = true
        while spare > 0 && growing {
            growing = false
            var i = 0
            while i < page.count && spare > 0 {
                if grown[i] < limits[i] {
                    grown[i] += 1
                    spare -= 1
                    growing = true
                }
                i += 1
            }
        }
        var y = floorDiv(spare, 2)
        var placements: [LayoutPlacement] = []
        for (i, shelf) in page.enumerated() {
            let height = heights[i] + grown[i]
            for (x, block) in shelf.blocks {
                var top = y
                let last = block.members.count - 1
                for (m, member) in block.members.enumerated() {
                    let h = m == last ? y + height - top : member.h
                    placements.append(LayoutPlacement(id: member.id, x: x, y: top, w: block.width, h: h))
                    top += h
                }
            }
            y += height
        }
        return placements
    }

    // MARK: Layout of a slide in a format

    /**
     * The pages a screen of `format` shows for a slide: the primary layout,
     * the custom layout when there is one (hidden widgets left out), else
     * the auto reflow. Pages with nothing visible are kept, so page numbers
     * stay those of the layout.
     */
    public static func slideLayoutFor(
        widgets: [LayoutWidget], primaryFormat: ScreenFormat, format: ScreenFormat, custom: CustomLayout? = nil
    ) -> [[LayoutPlacement]] {
        guard format != primaryFormat, let custom else {
            return reflowSlide(widgets, from: primaryFormat, to: format)
        }
        var pages: [[LayoutPlacement]] = Array(repeating: [], count: Swift.max(1, custom.pages))
        for placement in custom.placements where !placement.hidden {
            guard placement.page >= 0 && placement.page < pages.count else { continue }
            pages[placement.page].append(
                LayoutPlacement(id: placement.id, x: placement.x, y: placement.y, w: placement.w, h: placement.h))
        }
        return pages.map { studioReadingOrder($0) }
    }

    // MARK: Custom layouts (section 4)

    /**
     * Why a custom layout is not valid for the slide's widgets in `format`,
     * in a stable order (empty when valid). Hidden placements are only
     * checked for their page.
     */
    public static func validateCustomLayout(
        _ custom: CustomLayout, widgets: [LayoutWidget], format: ScreenFormat
    ) -> [CustomLayoutProblem] {
        var problems: [CustomLayoutProblem] = []
        let pagesValid = custom.pages >= 1 && custom.pages <= customLayoutMaxPages
        if !pagesValid {
            problems.append(CustomLayoutProblem(code: .invalidPageCount, widgetId: nil))
        }
        var byId: [String: LayoutWidget] = [:]
        // new Map(entries) keeps the last value per key.
        for widget in widgets { byId[widget.id] = widget }
        var seen = Set<String>()
        var visible: [CustomPlacement] = []
        for placement in custom.placements {
            guard let widget = byId[placement.id] else {
                problems.append(CustomLayoutProblem(code: .unknownWidget, widgetId: placement.id))
                continue
            }
            if seen.contains(placement.id) {
                problems.append(CustomLayoutProblem(code: .widgetDuplicated, widgetId: placement.id))
                continue
            }
            seen.insert(placement.id)
            if placement.page < 0 || placement.page >= (pagesValid ? custom.pages : customLayoutMaxPages) {
                problems.append(CustomLayoutProblem(code: .pageOutOfRange, widgetId: placement.id))
                continue
            }
            if placement.hidden { continue }
            if !StudioLayout.isInsideFormatGrid(placement.cells, format: format) {
                problems.append(CustomLayoutProblem(code: .widgetOutOfBounds, widgetId: placement.id))
                continue
            }
            let minimum = minimumOf(widget)
            if placement.w < minimum.w || placement.h < minimum.h {
                problems.append(CustomLayoutProblem(code: .widgetTooSmall, widgetId: placement.id))
                continue
            }
            if visible.contains(where: {
                $0.page == placement.page && StudioLayout.overlap($0.cells, placement.cells)
            }) {
                problems.append(CustomLayoutProblem(code: .widgetsOverlap, widgetId: placement.id))
                continue
            }
            visible.append(placement)
        }
        for widget in widgets where !seen.contains(widget.id) {
            problems.append(CustomLayoutProblem(code: .widgetMissing, widgetId: widget.id))
        }
        return problems
    }

    /** The first free spot of this size on a page, row by row, or nil. */
    static func freeSpot(_ occupied: [StudioPlacement], w: Int, h: Int, format: ScreenFormat) -> (x: Int, y: Int)? {
        let spec = format.spec
        var y = 0
        while y + h <= spec.rows {
            var x = 0
            while x + w <= spec.columns {
                let spot = StudioPlacement(x: x, y: y, w: w, h: h)
                if !occupied.contains(where: { StudioLayout.overlap($0, spot) }) {
                    return (x, y)
                }
                x += 1
            }
            y += 1
        }
        return nil
    }

    /**
     * A custom layout brought in line with the primary (ADR 0017, section
     * 4), as the server runs it on every save:
     *
     * - Placements of widgets the slide no longer has are removed; the hole
     *   stays. Duplicates keep their first placement.
     * - Placements the user made stay as they are, hidden ones included.
     * - A visible placement that is no longer valid (below its type's
     *   minimum, outside the grid or its pages, or overlapping one kept
     *   before it in reading order) is re-placed as if added. A hidden
     *   widget on a page that no longer exists stays hidden, on page 1.
     * - A widget without a placement is placed automatically, in reading
     *   order: at the first free spot of its auto-reflowed size, else of its
     *   minimum size, on the page of its reading-order neighbour (the
     *   previous visible widget, else the next, else page 1), else at the
     *   top of a new last page. With all 8 pages in use it takes the first
     *   free spot of its minimum size on any page, and failing that it is
     *   hidden; either way it is flagged.
     *
     * Re-placed and added widgets are flagged `autoPlaced`; other flags are
     * kept. The result lists placements in the primary's reading order.
     */
    public static func completeCustomLayout(
        _ custom: CustomLayout, primaryFormat: ScreenFormat, primaryWidgets: [LayoutWidget], format: ScreenFormat
    ) -> CustomLayout {
        let order = studioReadingOrder(primaryWidgets)
        var byId: [String: CustomPlacement] = [:]
        for placement in custom.placements where byId[placement.id] == nil {
            byId[placement.id] = placement
        }
        var pages = Swift.min(Swift.max(custom.pages, 1), customLayoutMaxPages)

        // Keep what is still valid, in reading order.
        var kept: [String: CustomPlacement] = [:]
        for widget in order {
            guard let placement = byId[widget.id] else { continue }
            let pageValid = placement.page >= 0 && placement.page < pages
            if placement.hidden {
                // Hidden stays hidden; a page that no longer exists becomes the first.
                var hidden = placement
                hidden.page = pageValid ? placement.page : 0
                kept[widget.id] = hidden
                continue
            }
            let minimum = minimumOf(widget)
            let valid =
                pageValid
                && StudioLayout.isInsideFormatGrid(placement.cells, format: format)
                && placement.w >= minimum.w
                && placement.h >= minimum.h
                && !kept.values.contains(where: {
                    !$0.hidden && $0.page == placement.page && StudioLayout.overlap($0.cells, placement.cells)
                })
            if valid { kept[widget.id] = placement }
        }

        // Place the rest, in reading order.
        var auto: [String: LayoutPlacement] = [:]
        for page in reflowSlide(primaryWidgets, from: primaryFormat, to: format) {
            for placement in page { auto[placement.id] = placement }
        }
        let spec = format.spec
        func occupiedOn(_ page: Int) -> [StudioPlacement] {
            kept.values.filter { !$0.hidden && $0.page == page }.map(\.cells)
        }
        for (index, widget) in order.enumerated() {
            if kept[widget.id] != nil { continue }
            let reflowed = auto[widget.id]!
            let minimum = minimumOf(widget)
            let preferred = (
                w: Swift.min(Swift.max(reflowed.w, minimum.w), spec.columns),
                h: Swift.min(Swift.max(reflowed.h, minimum.h), spec.rows)
            )
            var sizes = [preferred]
            if preferred.w != minimum.w || preferred.h != minimum.h {
                sizes.append(minimum)
            }
            let previous = order[..<index].reversed().lazy.compactMap { kept[$0.id] }.first { !$0.hidden }
            let next = order[(index + 1)...].lazy.compactMap { kept[$0.id] }.first { !$0.hidden }
            let page = (previous ?? next)?.page ?? 0
            func place(_ on: Int, _ size: (w: Int, h: Int)) -> Bool {
                guard let spot = freeSpot(occupiedOn(on), w: size.w, h: size.h, format: format) else { return false }
                kept[widget.id] = CustomPlacement(
                    id: widget.id, page: on, x: spot.x, y: spot.y, w: size.w, h: size.h,
                    hidden: false, autoPlaced: true)
                return true
            }
            if sizes.contains(where: { place(page, $0) }) { continue }
            if pages < customLayoutMaxPages {
                pages += 1
                if place(pages - 1, sizes[0]) { continue }
            }
            if (0..<pages).contains(where: { place($0, minimum) }) { continue }
            kept[widget.id] = CustomPlacement(
                id: widget.id, page: 0, x: 0, y: 0, w: minimum.w, h: minimum.h, hidden: true, autoPlaced: true)
        }

        return CustomLayout(pages: pages, placements: order.map { kept[$0.id]! })
    }

    // MARK: Display modes (section 5)

    /**
     * The display mode a screen starts in: an Apple TV is always screen
     * view; a paired kiosk follows its device setting (screen view by
     * default); a signed-in browser uses scroll view on compact and regular
     * screens with a coarse primary pointer, else screen view.
     */
    public static func defaultDisplayMode(
        kind: ScreenKind, sizeClass: ScreenSizeClass, coarsePointer: Bool, deviceMode: DisplayMode? = nil
    ) -> DisplayMode {
        switch kind {
        case .tvos:
            return .screen
        case .kiosk:
            return deviceMode ?? .screen
        case .browser:
            return sizeClass != .large && coarsePointer ? .scroll : .screen
        }
    }

    // MARK: Scroll view layout (section 5)

    /** Scroll view columns: 1 below 600 points, 2 below 1024, else 3. */
    public static func scrollColumns(_ width: Double) -> Int {
        if !(width >= 600) { return 1 }
        return width < 1024 ? 2 : 3
    }

    /**
     * One slide's section in scroll view, for a viewport `width` points
     * wide: every widget (clocks included), in the primary layout's reading
     * order, flowing over the columns without reordering. Line and bar
     * charts, and text, image and table widgets at least 6 columns wide in
     * the primary (ADR 0019 section 2), span the row (after a half-filled row, which keeps its gap);
     * everything else takes one column.
     */
    public static func scrollLayout(_ widgets: [LayoutWidget], width: Double) -> ScrollLayout {
        let columns = scrollColumns(width)
        var items: [ScrollItem] = []
        var row = 0
        var column = 0
        for widget in studioReadingOrder(widgets) {
            let full =
                widget.type == .line || widget.type == .bar
                || ((widget.type == .text || widget.type == .image || widget.type == .table) && widget.w >= 6)
            let span = full ? columns : 1
            if column > 0 && column + span > columns {
                row += 1
                column = 0
            }
            let height: ScrollItemHeight =
                widget.type == .line || widget.type == .bar ? .chart : widget.type == .image ? .image : .content
            items.append(ScrollItem(id: widget.id, type: widget.type, row: row, column: column, span: span, height: height))
            column += span
            if column >= columns {
                row += 1
                column = 0
            }
        }
        let contentWidth = width.isNaN ? Double.nan : Swift.max(0, Swift.min(width, scrollMaxContentWidth))
        return ScrollLayout(columns: columns, contentWidth: contentWidth, items: items)
    }
}
