import Foundation

// Screen view on the Apple TV (ADR 0017, sections 2, 3, 6, 7 and 9): the
// viewport after the device's rotation setting, its format, a slide's pages
// in that format (primary, custom or auto reflow, continuation pages as
// rotation entries) and the geometry of a page on the screen. The
// counterpart of apps/web/src/lib/screen-view.ts and slide-rotation.ts;
// pure, so it is tested on a Mac. Apple TV is always screen view: the
// payload's display mode is ignored.

/** A placement as a slide renders it on a screen. */
public struct ScreenPlacement: Sendable, Equatable {
    /** Cells in the format's grid. */
    public var cells: StudioPlacement
    public var format: ScreenFormat
    /**
     * The widget's box in units when it differs from its box at the 16:9
     * reference canvas (another format, a stretched grid); nil on the
     * classic canvas, where widgets measure themselves as before.
     */
    public var unitBox: StudioCanvas?

    public init(cells: StudioPlacement, format: ScreenFormat = .widescreen, unitBox: StudioCanvas? = nil) {
        self.cells = cells
        self.format = format
        self.unitBox = unitBox
    }
}

/** One entry of the rotation: a slide's page (continuation pages are entries of their own). */
public struct ScreenPage: Sendable, Equatable, Identifiable {
    /** The rotation id: the slide's id for its first page, `<id>#<n>` for page n (1-based) after it. */
    public var id: String
    public var slideId: String
    /** 0-based. */
    public var page: Int
    /** How many pages the slide has in this format. */
    public var pages: Int
    public var durationSec: Int
    /** The page's visible widgets, in reading order. */
    public var placements: [LayoutPlacement]

    public init(slideId: String, page: Int, pages: Int, durationSec: Int, placements: [LayoutPlacement]) {
        id = ScreenView.pageEntryId(slideId: slideId, page: page)
        self.slideId = slideId
        self.page = page
        self.pages = pages
        self.durationSec = durationSec
        self.placements = placements
    }

    /** "2/3" in the header for the second of three pages; nil for a single page. */
    public var pageLabel: String? { ScreenView.pageLabel(page: page, pages: pages) }
}

/** Where a slide goes on a screen: the frame, and each placement's rect and unit box. */
public struct ScreenGeometry: Sendable, Equatable {
    public var format: ScreenFormat
    /** Rendered exactly as before ADR 0017 (`16x9` on a 16:9 screen). */
    public var classic: Bool
    public var frame: ScreenFrame

    /** A placement's rect in screen points and, off the classic canvas, its box in units. */
    public func place(_ cells: StudioPlacement) -> (rect: StudioRect, placement: ScreenPlacement) {
        let rect = StudioLayout.placementRect(cells, frame: frame)
        let box = classic ? nil : StudioCanvas(width: rect.width / frame.unit, height: rect.height / frame.unit)
        return (rect, ScreenPlacement(cells: cells, format: format, unitBox: box))
    }
}

public enum ScreenView {
    /** The separator of a continuation page's rotation id. */
    static let pageSeparator: Character = "#"

    /**
     * How far a 16:9 screen may be from 16:9 and still render exactly as
     * before ADR 0017 (as the web's isClassicCanvas).
     */
    public static let identityTolerance = 0.01

    /** The rotation the screen applies: the device setting from schema 3, else none. */
    public static func rotation(_ payload: DeviceDashboardV2?) -> ScreenRotation {
        guard let payload, payload.schema >= 3 else { return .none }
        return payload.device.rotation
    }

    /**
     * The format the screen shows: from the viewport (after rotation) with
     * schema 3; schema 2 is always the `16x9` layout.
     */
    public static func format(_ payload: DeviceDashboardV2, viewport: StudioCanvas) -> ScreenFormat {
        payload.schema >= 3 ? StudioLayout.formatFor(width: viewport.width, height: viewport.height) : .widescreen
    }

    /** A usable size: both sides positive and finite. */
    static func usable(_ size: StudioCanvas) -> Bool {
        size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0
    }

    /** True when the screen renders exactly as before ADR 0017: `16x9` on a 16:9 screen. */
    public static func isClassicCanvas(_ viewport: StudioCanvas, format: ScreenFormat) -> Bool {
        guard format == .widescreen else { return false }
        guard usable(viewport) else { return true }
        return abs((viewport.width / viewport.height) / (16.0 / 9.0) - 1) <= identityTolerance
    }

    /**
     * Where a slide goes on a viewport (points, after rotation) in
     * `format`: the format's grid over the whole viewport, stretched at
     * most 4/3, else centred (ADR 0017, section 2).
     */
    public static func geometry(viewport: StudioCanvas, format: ScreenFormat, showHeader: Bool) -> ScreenGeometry {
        let size = usable(viewport) ? viewport : format.spec.reference
        return ScreenGeometry(
            format: format, classic: isClassicCanvas(viewport, format: format),
            frame: StudioLayout.screenFrame(screen: size, format: format, showHeader: showHeader))
    }

    /** A widget type the layout knows: a newer server's type is laid out as the smallest widget. */
    static func layoutType(_ type: String) -> StudioWidgetType {
        StudioWidgetType(rawValue: type) ?? .image
    }

    /**
     * The minimum a widget is laid out with: its type's own when this build
     * knows the type, else the schema 3 `min` it carries (ADR 0019 section
     * 2), which keeps the reflow of a later type exact.
     */
    static func layoutMinimum(_ widget: DeviceWidget) -> StudioMinimum? {
        StudioWidgetType(rawValue: widget.type) == nil ? widget.minimum : nil
    }

    /**
     * The pages of a slide on a screen of `format` (ADR 0017, sections 3
     * and 4): the primary layout in the primary format; else the slide's
     * custom layout for the format, completed against the widgets in this
     * payload as the server would (one it could not read is gone), or the
     * auto reflow. Hidden widgets are left out; a slide has at least one
     * (possibly empty) page.
     */
    public static func slidePages(_ slide: DeviceSlide, primaryFormat: ScreenFormat, format: ScreenFormat)
        -> [[LayoutPlacement]]
    {
        let widgets = slide.widgets.map {
            LayoutWidget(
                id: $0.id, type: layoutType($0.type), x: $0.placement.x, y: $0.placement.y, w: $0.placement.w,
                h: $0.placement.h, minimum: layoutMinimum($0))
        }
        let custom = format == primaryFormat
            ? nil
            : slide.layout(format).map {
                ScreenLayout.completeCustomLayout(
                    $0.custom, primaryFormat: primaryFormat, primaryWidgets: widgets, format: format)
            }
        let pages = ScreenLayout.slideLayoutFor(
            widgets: widgets, primaryFormat: primaryFormat, format: format, custom: custom)
        return pages.isEmpty ? [[]] : pages
    }

    /** Every slide's pages in `format`, in order: the entries the screen rotates through. */
    public static func pages(_ payload: DeviceDashboardV2, format: ScreenFormat) -> [ScreenPage] {
        payload.slides.flatMap { slide in
            let pages = slidePages(slide, primaryFormat: payload.primaryFormat, format: format)
            return pages.enumerated().map { page, placements in
                ScreenPage(
                    slideId: slide.id, page: page, pages: pages.count, durationSec: max(slide.durationSec, 1),
                    placements: placements)
            }
        }
    }

    /** The rotation id of a slide's page (0-based); page 0 is the slide's id. */
    public static func pageEntryId(slideId: String, page: Int) -> String {
        page > 0 ? "\(slideId)\(pageSeparator)\(page + 1)" : slideId
    }

    /** The slide and 0-based page of a rotation id from `pageEntryId`. */
    public static func parsePageEntryId(_ id: String) -> (slideId: String, page: Int) {
        guard let at = id.lastIndex(of: pageSeparator), let number = Int(id[id.index(after: at)...]),
            number > 1
        else { return (id, 0) }
        return (String(id[..<at]), number - 1)
    }

    /** "2/3" for the second of three pages; nil for a single page. */
    public static func pageLabel(page: Int, pages: Int) -> String? {
        pages > 1 ? "\(page + 1)/\(pages)" : nil
    }

    /**
     * What the heartbeat reports (ADR 0017, section 7): the size the
     * dashboard is laid out in (points after the rotation setting), the
     * scale, the format shown and screen view. Before a schema 3 payload
     * the TV shows `16x9` unrotated.
     */
    public static func report(screen: StudioCanvas, scale: Double, payload: DeviceDashboardV2?) -> DeviceScreenReport? {
        let viewport = rotation(payload).viewport(screen)
        let format = payload.map { self.format($0, viewport: viewport) } ?? .widescreen
        return DeviceScreenReport.measured(
            width: viewport.width, height: viewport.height, scale: scale, format: format.rawValue,
            mode: DisplayMode.screen.rawValue)
    }
}

// MARK: - Header (ADR 0017, section 6; headerFit in packages/domain)

/** The header's sizes in units (STUDIO_HEADER_METRICS). */
public enum StudioHeaderMetrics {
    /** The dashboard name, semibold. */
    public static let name = 36.0
    /** The slide name and the clock. */
    public static let meta = 30.0
    /** Left and right padding. */
    public static let padding = 32.0
    /** Between logo, names and the clock. */
    public static let gap = 20.0
    /** At least this much space before the clock. */
    public static let clockSpace = 24.0
    /** The logo's height. */
    public static let logo = 48.0
    /** Formats whose header may wrap the dashboard name to two lines. */
    public static let narrowFormats: Set<ScreenFormat> = [.portrait, .tall]
    /** The widest clock text the header reserves room for. */
    static let clockSample = "12:00 PM"
}

public struct HeaderFit: Sendable, Equatable {
    /** The width the names share, in units. */
    public var width: Double
    /** Lines the dashboard name takes at its full size. */
    public var nameLines: Int
    /** 1, or 2 in narrow formats. */
    public var maxNameLines: Int
    /** The slide name fits beside a one-line dashboard name; else it is dropped. */
    public var showSlideName: Bool
    /** The dashboard name shows in full at its size (no shrinking or cut). */
    public var fits: Bool
}

extension StudioLayout {
    /**
     * How the header fits at the format's reference canvas (a port of
     * headerFit): the logo (48 units high, at its aspect ratio), the
     * dashboard name (36, semibold), the slide name (30) and the clock (30,
     * room for "12:00 PM") with the paddings and gaps. In narrow formats
     * (`3x4`, `9x16`) the dashboard name wraps to two lines before it
     * shrinks; the slide name is shown only when it fits in full beside a
     * one-line name, so it is dropped before the name is cut.
     */
    public static func headerFit(name: String, slideName: String?, format: ScreenFormat, logoAspect: Double?)
        -> HeaderFit
    {
        typealias M = StudioHeaderMetrics
        let aspect = logoAspect.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let width =
            format.spec.reference.width - 2 * M.padding - (aspect.map { M.logo * $0 + M.gap } ?? 0)
            - (2 * M.gap + M.clockSpace) - estimateTextWidth(M.clockSample, fontSize: M.meta)
        let maxNameLines = M.narrowFormats.contains(format) ? 2 : 1
        let trimmedName = trimWhitespace(name)
        let nameLines = Swift.max(
            1, wrappedLineCount(trimmedName, maxWidth: Swift.max(0, width), fontSize: M.name, weight: .semibold))
        let slide = slideName.map(trimWhitespace) ?? ""
        let showSlideName =
            !slide.isEmpty && nameLines == 1
            && estimateTextWidth(trimmedName, fontSize: M.name, weight: .semibold) + M.gap
                + estimateTextWidth(slide, fontSize: M.meta) <= width
        return HeaderFit(
            width: width, nameLines: nameLines, maxNameLines: maxNameLines, showSlideName: showSlideName,
            fits: width > 0 && nameLines <= maxNameLines)
    }
}
