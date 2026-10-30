import Foundation

// The compare widget (ADR 0019 section 10), a port of
// packages/domain/src/compare.ts: `ratioOf`, `compareChange` and
// `compareLayout`. Both sides run the vectors in
// packages/domain/test-vectors/studio-layout.json (CompareWidgetTests), so
// keep the arithmetic in the same order as the TypeScript.

/** How a compare widget shows its ratio: "32.7%" or "4.62" (or "€0.42"). */
public enum CompareFormat: String, OpenAPIEnum {
    case percent, ratio
    public static var fallback: CompareFormat { .percent }
}

public struct CompareChange: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable {
        case points, relative
    }

    public enum Direction: String, Sendable, Equatable {
        case up, down, flat
    }

    public var kind: Kind
    /** Points (1.9 for "1.9 pt"), or the relative change (0.062 for +6.2 %). */
    public var value: Double
    public var direction: Direction

    public init(kind: Kind, value: Double, direction: Direction) {
        self.kind = kind
        self.value = value
        self.direction = direction
    }
}

/**
 * A compare widget's texts, worded like the web's (apps/web compare
 * widget): operands as metric values, the ratio as a share ("32.7%") or a
 * number or amount per unit, and its change ("▲ 1.9 pt", "▲ +6.2%").
 */
public enum CompareText {
    /** An operand in full and compact form; "—" without a value or after a failed query. */
    public static func operand(_ operand: CompareOperand, language: ScreenLanguage = .en)
        -> StudioLayout.TableValueText
    {
        guard let unit = operand.unit, operand.value != nil else {
            return StudioLayout.TableValueText(full: "—", compact: "—")
        }
        return StudioLayout.TableValueText(
            full: MetricFormat.value(operand.value, unit: unit, language: language),
            compact: MetricFormat.compactValue(operand.value, unit: unit, language: language))
    }

    /**
     * The ratio as shown: `percent` as a share of 100 ("32.7%"; two
     * decimals below 10 %), `ratio` as an amount per unit with the ratio's
     * unit ("€0.42") or a plain number ("4.62"); "–" without one.
     */
    public static func ratio(
        _ value: Double?, format: CompareFormat, unit: String?, language: ScreenLanguage = .en
    ) -> String {
        guard let value, value.isFinite else { return "–" }
        switch format {
        case .percent:
            let digits = Swift.abs(value) < 0.1 ? 2 : 1
            let number = FloatingPointFormatStyle<Double>(locale: language.numberLocale)
                .rounded(rule: .toNearestOrAwayFromZero).precision(.fractionLength(0...digits))
            return (value * 100).formatted(number) + "%"
        case .ratio:
            return MetricFormat.value(value, unit: unit ?? "count", language: language)
        }
    }

    /** "▲ 1.9 pt" (points, one decimal) or "▲ +6.2%" (relative). */
    public static func change(_ change: CompareChange, language: ScreenLanguage = .en) -> String {
        let direction = MetricFormat.Direction(rawValue: change.direction.rawValue) ?? .flat
        switch change.kind {
        case .points:
            let number = FloatingPointFormatStyle<Double>(locale: language.numberLocale)
                .rounded(rule: .toNearestOrAwayFromZero).precision(.fractionLength(1))
            let points = Swift.abs(change.value).formatted(number)
            return "\(direction.arrow) " + KitStrings.text(.comparePoints, language, points)
        case .relative:
            let text =
                MetricFormat.change(delta: change.value, ratio: change.value, unit: "count", language: language)?
                .text ?? ""
            return "\(direction.arrow) \(text)"
        }
    }

    /** The ratio's label: the widget's, else "ratio" / "Verhältnis". */
    public static func ratioLabel(_ options: CompareWidgetOptions, language: ScreenLanguage = .en) -> String {
        options.ratioLabel ?? KitStrings.text(.compareRatio, language)
    }

    /** The footer's candidates: "derived · updated 2 min. ago", then "derived". */
    public static func footerCandidates(updatedAt: String?, now: Date = Date(), language: ScreenLanguage = .en)
        -> [String]
    {
        let derived = KitStrings.text(.compareDerived, language)
        return WidgetFooter.candidates(updatedAt: updatedAt, source: nil, now: now, language: language)
            .map { "\(derived) · \($0)" } + [derived]
    }
}

extension StudioLayout {
    /**
     * A ÷ B over the same period: nil when either side has no value, a side
     * is not finite, or the denominator is zero — never infinity.
     */
    public static func ratioOf(_ numerator: Double?, _ denominator: Double?) -> Double? {
        guard let numerator, let denominator else { return nil }
        guard numerator.isFinite, denominator.isFinite else { return nil }
        if denominator == 0 { return nil }
        let ratio = numerator / denominator
        return ratio.isFinite ? ratio : nil
    }

    /**
     * The ratio's change against the previous period: percentage points for
     * `percent`, relative for `ratio` (nil against zero); nil without both.
     */
    public static func compareChange(value: Double?, previousValue: Double?, format: CompareFormat)
        -> CompareChange?
    {
        guard let value, let previousValue else { return nil }
        guard value.isFinite, previousValue.isFinite else { return nil }
        let delta = value - previousValue
        let direction: CompareChange.Direction = delta > 0 ? .up : delta < 0 ? .down : .flat
        if format == .percent {
            return CompareChange(kind: .points, value: delta * 100, direction: direction)
        }
        if previousValue == 0 { return nil }
        return CompareChange(kind: .relative, value: delta / Swift.abs(previousValue), direction: direction)
    }

    // MARK: Layout

    /** Line height of a compare widget's text, as STUDIO_LINE_HEIGHT. */
    static let compareLineHeight = 1.15

    /** A compare widget's spacing in units. */
    public enum CompareSpacing {
        /** Between the label, period line, operands, ratio and footer. */
        public static let stack = 8.0
        /** On both sides of the "/" between the operands. */
        public static let operandGap = 24.0
        /** Between the ratio, its label and its change. */
        public static let ratioGap = 16.0
    }

    /** The separator between the operands. */
    public static let compareSeparator = "/"

    public struct CompareSizes: Sendable, Equatable {
        public var title: Double
        public var resource: Double
        public var small: Double
        public var operand: Double
        public var caption: Double
        public var ratio: Double
        public var change: Double
    }

    public enum CompareRatioLine: String, Sendable, Equatable {
        case beside, below
    }

    public struct CompareLayout: Sendable, Equatable {
        public var sizes: CompareSizes
        public var titleLines: Int
        public var resourceLines: Int
        public var showPeriod: Bool
        public var showFooter: Bool
        public var compact: Bool
        public var captionWidth: Double
        public var ratioLine: CompareRatioLine
    }

    /**
     * A compare widget's content (compareLayout in the TypeScript): label,
     * period line, operands with captions, the ratio with its label and
     * change, and the footer; the footer goes first, then the period line.
     */
    public static func compareLayout(
        label: String, width inputWidth: Double, height inputHeight: Double, fontScale: Double? = nil,
        numerator: TableValueText, denominator: TableValueText, ratio ratioText: String,
        ratioLabel: String, change changeText: String?
    ) -> CompareLayout {
        let scale = effectiveFontScale(fontScale)
        let width = Swift.max(0, inputWidth)
        let height = Swift.max(0, inputHeight)
        let lh = compareLineHeight
        let gap = CompareSpacing.stack
        let title = Minimum.title * scale
        let resource = Minimum.resource * scale
        let small = Minimum.any * scale
        let operand = Minimum.operand * scale
        let caption = Minimum.any * scale
        let change = Minimum.change * scale
        let valueMin = Minimum.value * scale
        let valueMax = Swift.max(valueMin, height * 0.3)

        let parts = labelParts(label)
        let titleLines = Swift.min(
            labelMaxLines,
            Swift.max(1, wrappedLineCount(parts.title, maxWidth: width, fontSize: title, weight: .semibold)))
        let resourceLines = parts.resource.map {
            Swift.min(
                labelMaxLines,
                Swift.max(1, wrappedLineCount($0, maxWidth: width, fontSize: resource, weight: .semibold)))
        } ?? 0
        let labelHeight = Double(titleLines) * title * lh + Double(resourceLines) * resource * lh

        let separator = estimateTextWidth(compareSeparator, fontSize: operand, weight: .regular)
        let between = 2 * CompareSpacing.operandGap + separator
        func operandsWidth(_ compactForm: Bool) -> Double {
            let a = compactForm ? numerator.compact : numerator.full
            let b = compactForm ? denominator.compact : denominator.full
            return estimateTextWidth(a, fontSize: operand, weight: .semibold)
                + between
                + estimateTextWidth(b, fontSize: operand, weight: .semibold)
        }
        let fullWidth = operandsWidth(false)
        let compact = fullWidth > width && operandsWidth(true) < fullWidth
        let captionWidth = Swift.max(0, (width - between) / 2)
        let operandsHeight = operand * lh + caption * lh

        let ratioGap = CompareSpacing.ratioGap
        let restWidth =
            ratioGap
            + estimateTextWidth(ratioLabel, fontSize: change, weight: .regular)
            + (changeText.map { ratioGap + estimateTextWidth($0, fontSize: change, weight: .regular) } ?? 0)
        let ratioAtOne = estimateTextWidth(ratioText, fontSize: 1, weight: .semibold)
        let beside = ratioAtOne * valueMin + restWidth <= width
        let below = beside ? 0 : gap + change * lh

        func fixed(_ ratio: Double) -> Double {
            labelHeight + gap + operandsHeight + gap + ratio * lh + below
        }
        let line = gap + small * lh
        let candidates: [(Bool, Bool)] = [(true, true), (true, false), (false, false)]
        let chosen = candidates.first { period, footer in
            fixed(valueMin) + (period ? line : 0) + (footer ? line : 0) <= height
        } ?? (false, false)
        let (showPeriod, showFooter) = chosen
        let others = fixed(0) + (showPeriod ? line : 0) + (showFooter ? line : 0)
        let byHeight = (height - others) / lh
        let room = beside ? width - restWidth : width
        let byWidth = ratioAtOne > 0 ? room / ratioAtOne : valueMax
        let ratio = Swift.max(valueMin, Swift.min(valueMax, byHeight, byWidth))

        return CompareLayout(
            sizes: CompareSizes(
                title: title, resource: resource, small: small, operand: operand, caption: caption, ratio: ratio,
                change: change),
            titleLines: titleLines,
            resourceLines: resourceLines,
            showPeriod: showPeriod,
            showFooter: showFooter,
            compact: compact,
            captionWidth: captionWidth,
            ratioLine: beside ? .beside : .below)
    }
}
