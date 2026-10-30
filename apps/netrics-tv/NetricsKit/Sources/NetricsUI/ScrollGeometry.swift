import Foundation
import NetricsKit

/**
 * Where the scroll view puts things (ADR 0017 section 5), as the web's
 * `apps/web/src/lib/scroll-view.ts` and `.scroll-*` styles do: the order,
 * rows and columns come from `ScreenLayout.scrollLayout`, unchanged; this
 * adds the sizes in points. Plain values, so the tests run on a Mac.
 */
public enum ScrollGeometry {
    /** Gap between cards (web: `SCROLL_GAP`). */
    public static let gap = 12.0
    /** A section's padding around its grid, room for its backdrop (web: `SCROLL_SECTION_PADDING`). */
    public static let sectionPadding = 12.0
    /** Points per unit at the default text size: 1 rem (16 points) is 32 units (web: `--u`). */
    public static let unitsPerRem = 32.0
    public static let rem = 16.0
    /** Images keep their aspect, at most this share of the viewport's height. */
    public static let imageMaxViewportShare = 0.5

    /** One section: an enabled slide and its scroll layout. */
    public struct Section: Sendable, Equatable, Identifiable {
        public var slide: DeviceSlide
        /** The slide's position in the dashboard ("Slide 2" for a nameless one). */
        public var index: Int
        public var layout: ScrollLayout
        public var id: String { slide.id }
    }

    /**
     * Every slide of the payload as a section for a view `width` points wide
     * (the payload carries only enabled slides), each laid out by
     * `scrollLayout` on the slide's primary placements, clocks included.
     */
    public static func sections(_ slides: [DeviceSlide], width: Double) -> [Section] {
        slides.enumerated().map { index, slide in
            Section(
                slide: slide, index: index,
                layout: ScreenLayout.scrollLayout(ScreenView.layoutWidgets(slide), width: width))
        }
    }

    /** The layout's rows in order, each with its items left to right. */
    public static func rows(_ layout: ScrollLayout) -> [[ScrollItem]] {
        var rows: [[ScrollItem]] = []
        for item in layout.items {
            if let last = rows.last?.last, last.row == item.row {
                rows[rows.count - 1].append(item)
            } else {
                rows.append([item])
            }
        }
        return rows
    }

    /** The width of one column: the content less the section's padding, shared by the columns and gaps. */
    public static func columnWidth(_ layout: ScrollLayout) -> Double {
        let grid = layout.contentWidth - 2 * sectionPadding
        return (grid - gap * Double(layout.columns - 1)) / Double(layout.columns)
    }

    /** An item's width spanning `span` columns (web: `scrollItemWidth`). */
    public static func itemWidth(_ layout: ScrollLayout, span: Int) -> Double {
        Swift.max(0, columnWidth(layout) * Double(span) + gap * Double(span - 1))
    }

    /** An item's left edge in its section's grid (after the section padding). */
    public static func itemX(_ layout: ScrollLayout, column: Int) -> Double {
        Double(column) * (columnWidth(layout) + gap)
    }

    /** A chart's height: 16:9 of its width, at least 200 and at most 360 points (web: `scrollChartHeight`). */
    public static func chartHeight(width: Double) -> Double {
        Swift.min(
            ScreenLayout.scrollChartMaxHeight,
            Swift.max(ScreenLayout.scrollChartMinHeight, (width * 9 / 16 + 0.5).rounded(.down)))
    }

    /** An image's height: its aspect at `width`, at most half the viewport's height. */
    public static func imageHeight(width: Double, aspect: Double?, viewportHeight: Double) -> Double {
        let natural = aspect.map { $0 > 0 ? width / $0 : width } ?? width * 9 / 16
        return Swift.min(natural, viewportHeight * imageMaxViewportShare)
    }

    /**
     * A card sized to its content (metrics, text, clocks and the rest): as
     * many units high as its box in the primary layout, at the scroll
     * view's unit, so its text has the room it has on a screen at the
     * platform's type size; the width is the column's.
     */
    public static func contentHeight(
        placement: StudioPlacement, primaryFormat: ScreenFormat, showHeader: Bool, unit: Double
    ) -> Double {
        let frame = StudioLayout.screenFrame(
            screen: primaryFormat.spec.reference, format: primaryFormat, showHeader: showHeader)
        let rect = StudioLayout.placementRect(placement, frame: frame)
        return Swift.max(0, rect.height / frame.unit) * unit
    }

    /** Points per unit for a text size of `rem` points (Dynamic Type): 1 rem is 32 units. */
    public static func unit(rem: Double) -> Double { rem / unitsPerRem }
}
