import Foundation

// How a slide's widgets use their room (ADR 0015, section 8): a port of the
// web's apps/web/src/lib/studio-render.ts, studio-chart.ts and the text
// widget layout in studio-widgets.ts, on top of StudioLayout. Sizes are in
// canvas units at the 1080p reference canvas; the app multiplies them by
// u = canvas height / 1080. Nothing here touches UI, so it is tested on a Mac.

public enum StudioRender {
    /** Line height of titles, labels and small text. */
    public static let lineHeight = 1.15
    /** Line height of a value or the clock. */
    public static let valueLineHeight = 1.0
    /** Space between the parts of a widget, in units. */
    public static let stackGap = 8.0
    /** Below this height in units a sparkline says nothing; it is left out. */
    public static let minSparklineHeight = 40.0

    /**
     * A widget's content box in units: its rect less the widget padding.
     * Off the classic 16:9 canvas (ADR 0017) the screen passes the widget's
     * box in units (`ScreenPlacement.unitBox`), since the format's grid and
     * a stretched screen give it other proportions.
     */
    public static func contentBox(_ placement: StudioPlacement, showHeader: Bool, unitBox: StudioCanvas? = nil)
        -> (width: Double, height: Double)
    {
        if let unitBox {
            return (unitBox.width - 2 * StudioLayout.widgetPadding, unitBox.height - 2 * StudioLayout.widgetPadding)
        }
        let rect = StudioLayout.widgetRect(placement, canvas: StudioLayout.referenceCanvas, showHeader: showHeader)
        return (rect.width - 2 * StudioLayout.widgetPadding, rect.height - 2 * StudioLayout.widgetPadding)
    }

    /** A widget's content box in units at its format's reference canvas (the Studio's readability check). */
    public static func contentBox(_ placement: StudioPlacement, format: ScreenFormat, showHeader: Bool)
        -> (width: Double, height: Double)
    {
        let rect = StudioLayout.placementRect(
            placement,
            frame: StudioLayout.screenFrame(screen: format.spec.reference, format: format, showHeader: showHeader))
        return (rect.width - 2 * StudioLayout.widgetPadding, rect.height - 2 * StudioLayout.widgetPadding)
    }

    // MARK: Labels

    public struct FittedLabel: Sendable, Equatable {
        public var text: String
        /** Font size in units. */
        public var size: Double
        /** Lines at that size, at most two. */
        public var lines: Int
        /**
         * More than two lines even at the minimum: the last resort, an
         * ellipsis at the end of the second line.
         */
        public var truncated: Bool
    }

    /**
     * A title, resource name or bar label wrapped to at most two lines: at
     * its size when it fits, else shrunk step by step down to `floor`, and
     * only then truncated.
     */
    public static func fitLabel(
        _ text: String, maxWidth: Double, size: Double, floor: Double, weight: StudioFontWeight = .semibold,
        maxLines: Int = 2
    ) -> FittedLabel {
        let floor = min(floor, size)
        var current = size
        while current > floor {
            let lines = StudioLayout.wrappedLineCount(text, maxWidth: maxWidth, fontSize: current, weight: weight)
            if lines <= maxLines {
                return FittedLabel(text: text, size: current, lines: lines, truncated: false)
            }
            current -= 1
        }
        let lines = StudioLayout.wrappedLineCount(text, maxWidth: maxWidth, fontSize: floor, weight: weight)
        return FittedLabel(text: text, size: floor, lines: min(lines, maxLines), truncated: lines > maxLines)
    }

    public struct LabelLayout: Sendable, Equatable {
        public var title: FittedLabel
        public var resource: FittedLabel?
        /** Height of the label block in units. */
        public var height: Double
    }

    /** A data widget's label as a title and a resource line. */
    public static func labelLayout(_ label: String, width: Double, sizes: [StudioTextRole: Double]) -> LabelLayout {
        let parts = StudioLayout.labelParts(label)
        let title = fitLabel(
            parts.title, maxWidth: width, size: sizes[.title] ?? StudioLayout.Minimum.title,
            floor: StudioLayout.Minimum.title)
        let resource = parts.resource.map {
            fitLabel(
                $0, maxWidth: width, size: sizes[.resource] ?? StudioLayout.Minimum.resource,
                floor: StudioLayout.Minimum.resource)
        }
        let height = Double(title.lines) * title.size * lineHeight
            + (resource.map { Double($0.lines) * $0.size * lineHeight } ?? 0)
        return LabelLayout(title: title, resource: resource, height: height)
    }

    // MARK: Values

    public struct FittedValue: Sendable, Equatable {
        public var text: String
        public var size: Double
    }

    /**
     * A value at the largest size between its bounds that fits on one line,
     * switching to the compact form before going below the minimum. Never
     * truncated.
     */
    public static func fitValue(_ full: String, compact: String, maxWidth: Double, min minSize: Double, max maxSize: Double)
        -> FittedValue
    {
        let upper = Swift.max(minSize, maxSize)
        if let size = StudioLayout.fitTextSize(full, maxWidth: maxWidth, min: minSize, max: upper, weight: .semibold) {
            return FittedValue(text: full, size: size)
        }
        let size = StudioLayout.fitTextSize(compact, maxWidth: maxWidth, min: minSize, max: upper, weight: .semibold)
        return FittedValue(text: compact, size: size ?? minSize)
    }

    private static func linesOf(_ text: String?, width: Double, size: Double) -> Int {
        guard let text else { return 0 }
        return Swift.max(1, StudioLayout.wrappedLineCount(text, maxWidth: width, fontSize: size))
    }

    // MARK: Metric widget

    public struct MetricLayout: Sendable, Equatable {
        public var label: LabelLayout
        public var showPeriod: Bool
        public var value: FittedValue
        /** The change line as shown; nil when off or without room. */
        public var changeText: String?
        /**
         * The comparison ("vs previous 30 days") on its own line under a
         * short change line, when it fits one line at a readable size and
         * there is room; else nil.
         */
        public var comparisonText: String?
        public var small: Double
        public var change: Double
        /** The comparison line's size in units. */
        public var comparison: Double
        /** Height for the sparkline in units; 0 hides it. */
        public var sparkline: Double
        /** The conversion note (#191) under the numbers. */
        public var showNote: Bool
    }

    /**
     * What a metric widget shows at its size: label, value and a notice
     * always; then by importance while there is room the change line, the
     * period line, the comparison, the sparkline and the conversion note.
     *
     * The comparison stays whenever it fits at a readable size: on the
     * change line when the whole line fits one line at the change size,
     * else on a line of its own under the change at the change size or,
     * narrower, the smallest readable size (as the web's metricWidgetLayout).
     */
    public static func metricLayout(
        label: String, value: (full: String, compact: String), periodText: String,
        change: (full: String, short: String, comparison: String?)?, notice: String?, note: String?, placement: StudioPlacement,
        showHeader: Bool, fontScale: Double, showSparkline: Bool, unitBox: StudioCanvas? = nil
    ) -> MetricLayout {
        let box = contentBox(placement, showHeader: showHeader, unitBox: unitBox)
        let sizes = StudioLayout.typeScale(.metric, placement: placement, fontScale: fontScale, showHeader: showHeader)
        let labelLayout = labelLayout(label, width: box.width, sizes: sizes)
        let small = sizes[.any] ?? StudioLayout.Minimum.any
        let changeSize = sizes[.change] ?? StudioLayout.Minimum.change
        func height(_ text: String?, _ size: Double) -> Double {
            Double(linesOf(text, width: box.width, size: size)) * size * lineHeight
        }
        let valueMin = sizes[.valueMin] ?? StudioLayout.Minimum.value
        let valueMax = sizes[.valueMax] ?? valueMin

        var used = labelLayout.height + stackGap + height(notice, small) + valueMin * valueLineHeight
        func fits(_ extra: Double) -> Bool { used + extra <= box.height }

        // One line: when the whole change would wrap, the comparison moves
        // to a line of its own below.
        let oneLine = change.map { linesOf($0.full, width: box.width, size: changeSize) <= 1 } ?? false
        let changeText = change.map { oneLine ? $0.full : $0.short }
        let changeHeight = changeText == nil ? 0 : changeSize * lineHeight
        let showChange = changeText != nil && fits(changeHeight)
        if showChange { used += changeHeight }

        let period = height(periodText, small)
        let showPeriod = fits(period)
        if showPeriod { used += period }

        let comparison = showChange && !oneLine ? change?.comparison : nil
        let comparisonSize = comparison.flatMap { text in
            [changeSize, small].first {
                StudioLayout.wrappedLineCount(text, maxWidth: box.width, fontSize: $0) <= 1
            }
        }
        var showComparison = false
        if let comparisonSize, fits(comparisonSize * lineHeight) {
            showComparison = true
            used += comparisonSize * lineHeight
        }

        let noteHeight = height(note, small)
        let sparkMin = stackGap + minSparklineHeight
        var spark = false
        var showNote = false
        if showSparkline && fits(sparkMin + noteHeight) {
            spark = true
            showNote = noteHeight > 0
            used += sparkMin + noteHeight
        } else if showSparkline && fits(sparkMin) {
            spark = true
            used += sparkMin
        } else if noteHeight > 0 && fits(noteHeight) {
            showNote = true
            used += noteHeight
        }

        let extra = Swift.max(0, box.height - used)
        let fitted = fitValue(
            value.full, compact: value.compact, maxWidth: box.width, min: valueMin,
            max: Swift.min(valueMax, valueMin + extra / valueLineHeight))
        used += (fitted.size - valueMin) * valueLineHeight
        return MetricLayout(
            label: labelLayout, showPeriod: showPeriod, value: fitted, changeText: showChange ? changeText : nil,
            comparisonText: showComparison ? comparison : nil, small: small, change: changeSize,
            comparison: comparisonSize ?? changeSize,
            sparkline: spark ? minSparklineHeight + Swift.max(0, box.height - used) : 0, showNote: showNote)
    }

    // MARK: Line and bar widgets

    public struct ChartLayout: Sendable, Equatable {
        public var label: LabelLayout
        public var value: FittedValue?
        public var small: Double
        public var axis: Double
        public var resource: Double
        /** The chart's box in units. */
        public var chartWidth: Double
        public var chartHeight: Double
    }

    public static func chartLayout(
        type: StudioWidgetType, label: String, value: (full: String, compact: String)?, notice: String?,
        placement: StudioPlacement, showHeader: Bool, fontScale: Double, unitBox: StudioCanvas? = nil
    ) -> ChartLayout {
        let box = contentBox(placement, showHeader: showHeader, unitBox: unitBox)
        let sizes = StudioLayout.typeScale(type, placement: placement, fontScale: fontScale, showHeader: showHeader)
        let labelLayout = labelLayout(label, width: box.width, sizes: sizes)
        let small = sizes[.any] ?? StudioLayout.Minimum.any
        var used = labelLayout.height + stackGap
            + Double(linesOf(notice, width: box.width, size: small)) * small * lineHeight
        var fitted: FittedValue?
        if let value {
            let valueMin = sizes[.valueMin] ?? StudioLayout.Minimum.value
            let result = fitValue(
                value.full, compact: value.compact, maxWidth: box.width, min: valueMin,
                max: sizes[.valueMax] ?? valueMin)
            fitted = result
            used += result.size * valueLineHeight + stackGap
        }
        return ChartLayout(
            label: labelLayout, value: fitted, small: small, axis: sizes[.axis] ?? StudioLayout.Minimum.axis,
            resource: sizes[.resource] ?? StudioLayout.Minimum.resource, chartWidth: box.width,
            chartHeight: Swift.max(0, box.height - used))
    }

    /** The line chart's value range: from zero (or below), never empty. */
    public static func lineDomain(values: [Double?], previous: [Double?]) -> ClosedRange<Double>? {
        let current = values.compactMap { $0 }.filter(\.isFinite)
        guard values.count >= 2, !current.isEmpty else { return nil }
        let all = current + previous.compactMap { $0 }.filter(\.isFinite)
        let low = Swift.min(0, all.min() ?? 0)
        var high = all.max() ?? 1
        if high <= low { high = low + 1 }
        return low...high
    }

    // MARK: Bars

    public struct BarRow: Sendable, Equatable {
        public var label: FittedLabel
        public var value: Double
        public var valueText: String
        /** Length as a share of the largest bar, 0–1. */
        public var ratio: Double
        public var others: Bool
    }

    public struct BarLayout: Sendable, Equatable {
        public var rows: [BarRow]
        public var size: Double
        public var valueWidth: Double
        public var barHeight: Double
        public var rowGap: Double
        /** Groups moved into "Others" because the widget was too small. */
        public var folded: Int
    }

    struct Entry {
        var label: String
        var value: Double
        var others: Bool
    }

    static let barRowGap = 12.0
    static let valueGap = 16.0

    static func barHeight(_ size: Double) -> Double { Swift.max(12, (size * 0.45).rounded()) }

    private static func rows(_ entries: [Entry], size: Double, width: Double, format: (Double) -> String)
        -> (rows: [BarRow], valueWidth: Double, height: Double, truncated: Bool)
    {
        let texts = entries.map { format($0.value) }
        let valueWidth = texts.map { StudioLayout.estimateTextWidth($0, fontSize: size, weight: .semibold) }
            .reduce(0, Swift.max)
        let labelWidth = Swift.max(1, width - valueWidth - valueGap)
        let largest = entries.map(\.value).reduce(0, Swift.max)
        let rows = entries.enumerated().map { index, entry in
            BarRow(
                label: fitLabel(entry.label, maxWidth: labelWidth, size: size, floor: size),
                value: entry.value, valueText: texts[index],
                ratio: largest > 0 ? Swift.max(0, entry.value) / largest : 0, others: entry.others)
        }
        var height = 0.0
        for (index, row) in rows.enumerated() {
            height += Double(row.label.lines) * size * lineHeight + 4 + barHeight(size) + (index > 0 ? barRowGap : 0)
        }
        return (rows, valueWidth, height, rows.contains { $0.label.truncated })
    }

    private static func foldLast(_ entries: [Entry], othersLabel: String) -> [Entry] {
        let named = entries.filter { !$0.others }
        let others = entries.first { $0.others }
        let moved = named.last
        return Array(named.dropLast()) + [
            Entry(
                label: others?.label ?? othersLabel, value: (others?.value ?? 0) + (moved?.value ?? 0), others: true)
        ]
    }

    /**
     * One row per group, largest first, then "Others": labels start at the
     * resource size and shrink to the minimum; when the rows still do not
     * fit, the smallest groups join "Others" rather than being drawn
     * unreadably.
     */
    public static func barLayout(
        bars: [BarEntry], others: BarOthers?, width: Double, height: Double, size: Double,
        format: (Double) -> String, othersLabel: String = "Others"
    ) -> BarLayout {
        var entries = bars.map { Entry(label: $0.label, value: $0.value, others: false) }
        if let others {
            entries.append(Entry(label: others.label, value: others.value, others: true))
        }
        let floor = StudioLayout.Minimum.any
        var current = Swift.max(floor, size)
        while current > floor {
            let at = rows(entries, size: current, width: width, format: format)
            if !at.truncated && at.height <= height {
                return BarLayout(
                    rows: at.rows, size: current, valueWidth: at.valueWidth, barHeight: barHeight(current),
                    rowGap: barRowGap, folded: 0)
            }
            current -= 1
        }
        var folded = 0
        var at = rows(entries, size: floor, width: width, format: format)
        while at.height > height && entries.filter({ !$0.others }).count > 1 {
            entries = foldLast(entries, othersLabel: othersLabel)
            folded += 1
            at = rows(entries, size: floor, width: width, format: format)
        }
        return BarLayout(
            rows: at.rows, size: floor, valueWidth: at.valueWidth, barHeight: barHeight(floor), rowGap: barRowGap,
            folded: folded)
    }

    // MARK: Text widget

    public struct TextLayout: Sendable, Equatable {
        public var blocks: [StudioTextBlock]
        public var size: StudioTextSize
        public var paragraph: Double
        public var heading1: Double
        public var heading2: Double
        /** Even body size does not fit: the end is cut off (the studio warns). */
        public var overflow: Bool
    }

    static func spansText(_ spans: [StudioTextSpan]) -> String { spans.map(\.text).joined() }

    static func blocksHeight(_ blocks: [StudioTextBlock], width: Double, paragraph: Double, heading1: Double, heading2: Double)
        -> Double
    {
        var height = 0.0
        for (index, block) in blocks.enumerated() {
            if index > 0 { height += paragraph * 0.5 }
            switch block {
            case .heading(let level, let spans):
                let size = level == 1 ? heading1 : heading2
                height += Double(
                    StudioLayout.wrappedLineCount(spansText(spans), maxWidth: width, fontSize: size, weight: .bold))
                    * size * lineHeight
            case .paragraph(let lines):
                for line in lines {
                    height += Double(
                        Swift.max(
                            1,
                            StudioLayout.wrappedLineCount(
                                spansText(line), maxWidth: width, fontSize: paragraph, weight: .bold)))
                        * paragraph * lineHeight
                }
            }
        }
        return height
    }

    /**
     * The text's blocks at its size option, or the next smaller one that
     * fits, measured at the reference canvas of the placement's format (as
     * the Studio's readability check and the web, ADR 0017 section 6).
     */
    public static func textLayout(
        _ text: String, size: StudioTextSize, placement: StudioPlacement, fontScale: Double, showHeader: Bool,
        format: ScreenFormat = .widescreen
    ) -> TextLayout {
        let blocks = StudioLayout.parseText(text)
        let box = contentBox(placement, format: format, showHeader: showHeader)
        var current = size
        while true {
            let sizes = StudioLayout.textWidgetSizes(current, fontScale: fontScale)
            let fits = blocksHeight(
                blocks, width: box.width, paragraph: sizes.paragraph, heading1: sizes.heading1,
                heading2: sizes.heading2) <= box.height
            let smaller: StudioTextSize? = current == .display ? .heading : current == .heading ? .body : nil
            if fits || smaller == nil {
                return TextLayout(
                    blocks: blocks, size: current, paragraph: sizes.paragraph, heading1: sizes.heading1,
                    heading2: sizes.heading2, overflow: !fits)
            }
            current = smaller!
        }
    }

    // MARK: Clock widget

    /**
     * The clock's sizes in units (StudioLayout.clockLayout): the time as
     * large as fits, the date and the zone line, or nil for a line left out.
     */
    public static func clockLayout(
        time: String, options: ClockWidgetOptions, timeZone: String, placement: StudioPlacement, fontScale: Double,
        showHeader: Bool, unitBox: StudioCanvas? = nil
    ) -> StudioClockLayout {
        let box = contentBox(placement, showHeader: showHeader, unitBox: unitBox)
        return StudioLayout.clockLayout(
            placement: placement, box: box, fontScale: fontScale, showHeader: showHeader, time: time,
            showDate: options.showDate, dateStyle: options.dateStyle, zone: options.showZone ? timeZone : nil)
    }
}

// MARK: Formatting for widgets

extension MetricFormat {
    /**
     * The compact form of a value (formatCompactValue on the web): 12.3K,
     * €4.2M; percentages and positions as usual.
     */
    public static func compactValue(_ value: Double?, unit: String, language: ScreenLanguage = .en) -> String {
        guard let value else { return "—" }
        if let code = currency(of: unit) {
            // The full compact form at any size, as the web's narrowCompactNumber.
            return compactAmount(value / pow(10, Double(exponent(of: code))), currency: code, language: language)
        }
        if unit == "percent" || unit == "ratio" || unit == "position" {
            return self.value(value, unit: unit, language: language)
        }
        return compactNumber(value, language: language)
    }

    /**
     * StudioLayout.compactNumber (the shared vectors' "12.3K") in the
     * language: German swaps the decimal point for a comma ("12,3K"), as
     * the web does; suffixes and the sign stay.
     */
    public static func compactNumber(_ value: Double, language: ScreenLanguage = .en) -> String {
        let text = StudioLayout.compactNumber(value)
        return language == .en ? text : text.replacingOccurrences(of: ".", with: ",")
    }

    /** Whether a change is good, given which way is better. */
    public static func tone(_ direction: Direction, better: MetricBetter) -> Direction {
        switch direction {
        case .flat: return .flat
        case .up: return better == .higher ? .up : .down
        case .down: return better == .higher ? .down : .up
        }
    }

    /** How the line chart's buckets step (SERIES_UNITS). */
    public enum SeriesStep: Sendable { case hour, day, week, month }

    public static func seriesStep(_ period: MetricPeriod) -> SeriesStep {
        switch period {
        case .today: return .hour
        case .last7Days, .last30Days, .thisMonth, .thisWeek, .unknown: return .day
        case .last90Days, .thisQuarter: return .week
        case .last12Months, .thisYear: return .month
        }
    }

    /**
     * A bucket's axis label (sparkBucketLabel): "14:00", "Sep 29",
     * "Week of Sep 29", "Sep 2026". Day buckets at UTC midnight are
     * reporting dates and are labelled in UTC.
     */
    public static func bucketLabel(
        _ bucket: String, period: MetricPeriod, timeZone: String, language: ScreenLanguage = .en
    ) -> String? {
        guard let date = ISODate.parse(bucket) else { return nil }
        let step = seriesStep(period)
        let utc = step != .hour && bucket.hasSuffix("T00:00:00.000Z")
        let zone = utc ? TimeZone(identifier: "UTC")! : (TimeZone(identifier: timeZone) ?? .current)
        let style = Date.FormatStyle(
            locale: language == .en ? Locale(identifier: "en_US") : language.dateLocale, timeZone: zone)
        switch step {
        case .hour:
            return TVTime.hourMinute(date, timeZone: utc ? "UTC" : zone.identifier, language: language)
        case .day:
            return date.formatted(style.month(.abbreviated).day())
        case .week:
            return KitStrings.text(.weekOf, language, date.formatted(style.month(.abbreviated).day()))
        case .month:
            return date.formatted(style.month(.abbreviated).year())
        }
    }
}

extension TVTime {
    /**
     * The clock widget: "14:05" (or "2:05 PM"), "Sat 4 Oct" or the long
     * "Saturday, 4 October" ("Samstag, 4. Oktober"; the weekday, a comma,
     * day and month, as on the web) and the zone line "Berlin · UTC+2".
     */
    public static func clockWidget(
        _ date: Date, timeZone: String, hour12: Bool, showDate: Bool, dateStyle: ClockDateStyle = .short,
        showZone: Bool = false, language: ScreenLanguage = .en
    ) -> (time: String, date: String?, zone: String?) {
        let time: String
        if hour12 {
            let style = Date.FormatStyle(locale: Locale(identifier: "en_US"), timeZone: zone(timeZone))
                .hour(.defaultDigits(amPM: .abbreviated)).minute(.twoDigits)
            // Plain spaces: ICU writes a narrow no-break space before "PM".
            time = date.formatted(style).replacingOccurrences(of: "\u{202F}", with: " ")
        } else {
            time = hourMinute(date, timeZone: timeZone, language: language)
        }
        let zoneLine = showZone ? StudioLayout.zoneLabel(timeZone, at: date) : nil
        guard showDate else { return (time, nil, zoneLine) }
        let base = Date.FormatStyle(locale: language.dateLocale, timeZone: zone(timeZone))
        let day: String
        if dateStyle == .long {
            day = "\(date.formatted(base.weekday(.wide))), \(date.formatted(base.day().month(.wide)))"
        } else {
            day = date.formatted(base.weekday(.abbreviated).day().month(.abbreviated))
        }
        return (time, day, zoneLine)
    }
}
