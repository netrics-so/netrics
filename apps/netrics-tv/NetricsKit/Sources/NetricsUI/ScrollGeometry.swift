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

    /** Points per unit for a text size of `rem` points (Dynamic Type): 1 rem is 32 units. */
    public static func unit(rem: Double) -> Double { rem / unitsPerRem }

    // MARK: Cards (web: scroll-view.ts and the `.scroll-card` styles)

    /** A card's padding and corner radius in points (web: `SCROLL_CARD_PADDING`, 10 px radius). */
    public static let cardPadding = 16.0
    public static let cardRadius = 10.0
    /** The space between a card's parts (web: `.scroll-card { gap: 6px }`). */
    public static let cardGap = 6.0
    /** A clock card's vertical padding, an image card's padding (web: `.scroll-card--clock`, `--image`). */
    public static let clockPaddingVertical = 20.0
    public static let imagePadding = 8.0
    /** The goal ring's diameter in units: the card's width, at most this (web: `SCROLL_RING_MAX`). */
    public static let ringMax = 240.0

    /** Scroll view text sizes in units, ÷ 32 = rem (web: `SCROLL_TYPE`). */
    public enum TypeSize {
        /** The label's metric (title) and resource line. */
        public static let title = 30.0
        public static let resource = 26.0
        /** Period, notices, the footer and axis labels. */
        public static let small = 24.0
        public static let change = 26.0
        /** A value shrinks from max to min, then goes compact. */
        public static let valueMin = 48.0
        public static let valueMax = 72.0
        public static let clock = 64.0
        public static let date = 26.0

        /** A text widget's size by its size option. */
        public static func text(_ size: StudioTextSize) -> Double {
            switch size {
            case .body: return 32
            case .heading: return 44
            case .display: return 64
            }
        }
    }

    /**
     * A card's inner width in units for a card `width` points wide at a
     * text size of `rem` points (web: `cardUnits`): less the padding and
     * the 1 point borders.
     */
    public static func cardUnits(width: Double, rem: Double) -> Double {
        let inner = Swift.max(0, width - 2 * cardPadding - 2)
        return inner * unitsPerRem / (rem > 0 ? rem : Self.rem)
    }

    /**
     * A value in a card `units` wide: as large as fits between the scroll
     * bounds, then the compact form (12.3K) before it goes below the
     * minimum (web: `scrollValue`).
     */
    public static func value(full: String, compact: String, units: Double) -> StudioRender.FittedValue {
        StudioRender.fitValue(full, compact: compact, maxWidth: units, min: TypeSize.valueMin, max: TypeSize.valueMax)
    }

    /** The clock's size in units: as large as fits, at most `TypeSize.clock`; widest digits (web: `scrollClockSize`). */
    public static func clockSize(time: String, units: Double) -> Double {
        StudioLayout.fitTextSize(
            widestDigits(time), maxWidth: units, min: TypeSize.valueMin, max: TypeSize.clock, weight: .semibold)
            ?? TypeSize.valueMin
    }

    /**
     * A countdown's numbers and letters in units: the numbers as large as
     * fit between the value bounds on their widest digits, the letters a
     * third of them and never below the change size (web: `scrollCountdownSizes`).
     */
    public static func countdownSizes(_ groups: [CountdownShownGroup], units: Double) -> (value: Double, unit: Double) {
        let sample = groups.map { "\(widestDigits($0.value)) \($0.unit)" }.joined(separator: "  ")
        let value =
            StudioLayout.fitTextSize(
                sample, maxWidth: units, min: TypeSize.valueMin, max: TypeSize.valueMax, weight: .semibold)
            ?? TypeSize.valueMin
        return (value, Swift.max(TypeSize.change, value / 3))
    }

    /** The goal ring in a card `units` wide: diameter, stroke and the room for the value inside (units). */
    public struct Ring: Sendable, Equatable {
        public var diameter: Double
        public var stroke: Double
        public var room: Double
    }

    /** Web: `ScrollGaugeCard`'s diameter, stroke and room, less the suffix ("%") and its gap. */
    public static func ring(units: Double, suffix: String?) -> Ring {
        let spacing = StudioLayout.GaugeSpacing.self
        let diameter = Swift.max(spacing.ringMin, Swift.min(units, ringMax))
        let stroke = Swift.max(spacing.strokeMin, diameter * spacing.strokeShare)
        let suffixWidth =
            suffix.map {
                StudioLayout.estimateTextWidth($0, fontSize: TypeSize.change, weight: .semibold)
                    + TypeSize.change * spacing.suffixGap
            } ?? 0
        return Ring(diameter: diameter, stroke: stroke, room: (diameter - 2 * stroke) * spacing.valueWidthShare - suffixWidth)
    }

    /**
     * The value inside the ring: the full text when it fits at the value
     * minimum, else the compact one, at the size that fits the room
     * (between the small size and the value maximum).
     */
    public static func ringValue(full: String, compact: String, room: Double) -> StudioRender.FittedValue {
        func fits(_ text: String) -> Double? {
            StudioLayout.fitTextSize(
                widestDigits(text), maxWidth: room, min: TypeSize.small, max: TypeSize.valueMax, weight: .semibold)
        }
        let shown = (fits(full) ?? 0) >= TypeSize.valueMin ? full : compact
        return StudioRender.FittedValue(text: shown, size: fits(shown) ?? TypeSize.small)
    }

    /**
     * Whether a table card stacks its rows (the label, then its value and
     * Δ under it): when the value and Δ columns at the row size would leave
     * the labels less than 40 % of the card. Only Dynamic Type's largest
     * sizes on a phone get there; the web's columns stay otherwise.
     */
    public static func tableStacks(values: [String], changes: [String], units: Double) -> Bool {
        func widest(_ texts: [String]) -> Double {
            texts.map { StudioLayout.estimateTextWidth($0, fontSize: TypeSize.resource, weight: .semibold) }
                .reduce(0, Swift.max)
        }
        let gap = 16.0
        let columns = widest(values) + gap + (changes.isEmpty ? 0 : widest(changes) + gap)
        return units - columns < units * 0.4
    }

    /** Every digit as "0", so a size does not change as the digits do. */
    static func widestDigits(_ text: String) -> String {
        String(text.map { $0.isASCII && $0.isNumber ? "0" : $0 })
    }
}
