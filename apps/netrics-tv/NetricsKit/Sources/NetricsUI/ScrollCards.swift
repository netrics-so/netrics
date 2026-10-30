import NetricsKit
import SwiftUI

// The scroll view's widget cards (ADR 0017 section 5, #413), the
// counterparts of the web's `apps/web/src/components/scroll/scroll-widgets.tsx`
// as a kiosk set to scroll view fills them from the payload
// (`device-scroll-widget.tsx`). They read the same numbers as the screen's
// widget views and size text in the scroll view's unit (1 rem = 32 units,
// 1 rem the Dynamic Type body size): labels and names wrap in full and are
// never cut, values shrink between the scroll bounds and then go compact,
// charts are 16:9 of their width (200 to 360 points), lists show every row
// (the card grows instead of "+N more"), and each card is as high as its
// content.

/** A widget's scroll view card at `width` points, as `ScrollGeometry` lays it out. */
struct ScrollCardView: View {
    let widget: DeviceWidget
    /** The card's width in points. */
    let width: Double
    /** 1 rem in points (Dynamic Type). */
    let rem: Double
    /** The scroll view's height: images take at most half of it. */
    let viewportHeight: Double
    let env: WidgetEnv
    let image: StoredImage?

    var body: some View {
        // Footers ("updated 2 min. ago"), clocks and countdowns are worded anew every minute.
        TimelineView(.everyMinute) { context in
            card(now: context.date)
        }
        .frame(width: CGFloat(width), alignment: .topLeading)
    }

    private var units: Double { ScrollGeometry.cardUnits(width: width, rem: rem) }

    @ViewBuilder
    private func card(now: Date) -> some View {
        let label = widget.label ?? ""
        switch widget.content {
        case .metric(let options, let data):
            ScrollMetricCard(label: label, options: options, data: data, units: units, env: env, now: now)
                .scrollCard(env)
        case .line(let options, let data):
            ScrollLineCard(label: label, options: options, data: data, units: units, env: env, now: now)
                .scrollCard(env)
        case .bar(_, let data):
            ScrollBarCard(label: label, data: data, env: env, now: now)
                .scrollCard(env)
        case .table(let options, let data):
            ScrollTableCard(label: label, options: options, data: data, units: units, env: env, now: now)
                .scrollCard(env)
        case .status(let options, let data):
            ScrollStatusCard(label: label, options: options, data: data, env: env, now: now)
                .scrollCard(env)
        case .compare(let options, let data):
            ScrollCompareCard(label: label, options: options, data: data, units: units, env: env, now: now)
                .scrollCard(env)
        case .gauge(let options, let data):
            ScrollGaugeCard(label: label, options: options, data: data, units: units, env: env, now: now)
                .scrollCard(env)
        case .review(_, _, let data):
            ScrollReviewCard(label: label, data: data, icon: image, env: env, now: now)
                .scrollCard(env)
        case .clock(let options):
            ScrollClockCard(options: options, units: units, env: env, now: now)
                .scrollCard(
                    env,
                    padding: EdgeInsets(
                        top: ScrollGeometry.clockPaddingVertical, leading: ScrollGeometry.cardPadding,
                        bottom: ScrollGeometry.clockPaddingVertical, trailing: ScrollGeometry.cardPadding))
        case .countdown(let options):
            ScrollCountdownCard(
                label: widget.label ?? KitStrings.text(.countdownLabel, env.language), options: options,
                units: units, env: env, now: now
            )
            .scrollCard(env)
        case .text(let text, let options):
            ScrollTextCard(text: text, options: options, env: env)
                .scrollCard(env)
        case .image:
            ScrollImageCard(
                image: image, label: widget.label, width: width - 2 * ScrollGeometry.imagePadding,
                viewportHeight: viewportHeight, env: env
            )
            .scrollCard(env, padding: EdgeInsets(all: ScrollGeometry.imagePadding))
        case .unsupported:
            // A type this build does not know (a newer server): an empty card keeps its place.
            Color.clear.frame(height: env.pt(ScrollGeometry.TypeSize.valueMax))
                .scrollCard(env)
        }
    }
}

extension EdgeInsets {
    init(all value: Double) {
        self.init(top: value, leading: value, bottom: value, trailing: value)
    }
}

extension View {
    /**
     * The card box (web: `.scroll-card`): 16 points of padding, a 10 point
     * radius, the theme's widget surface (layered: the gradient and soft
     * shadow of the screen's widgets; flat: the plain surface) and a 1 point
     * border. The card is as high as its content.
     */
    func scrollCard(_ env: WidgetEnv, padding: EdgeInsets = EdgeInsets(all: ScrollGeometry.cardPadding)) -> some View {
        let derived = env.colors.derived
        let layered = derived.kind == .layered
        let shape = RoundedRectangle(cornerRadius: CGFloat(ScrollGeometry.cardRadius))
        return self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background {
                shape
                    .fill(
                        LinearGradient(
                            colors: [Color(derived.widgetTop), Color(derived.widgetBottom)], startPoint: .top,
                            endPoint: .bottom)
                    )
                    .shadow(
                        color: layered ? .black.opacity(SurfaceMetrics.shadowOpacity) : .clear,
                        radius: layered ? env.pt(SurfaceMetrics.shadowBlur / 2) : 0, x: 0,
                        y: layered ? env.pt(SurfaceMetrics.shadowY) : 0)
            }
            .overlay { shape.strokeBorder(env.colors.border, lineWidth: 1) }
    }
}

// MARK: Shared parts

private typealias Size = ScrollGeometry.TypeSize

/** A data widget's label, wrapped in full: the metric, then the resource in muted (web: `ScrollLabel`). */
struct ScrollLabel: View {
    let label: String
    let env: WidgetEnv

    var body: some View {
        let parts = StudioLayout.labelParts(label)
        VStack(alignment: .leading, spacing: 2) {
            Text(parts.title)
                .font(env.font(Size.title, .semibold))
                .foregroundStyle(env.colors.label)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let resource = parts.resource {
                Text(resource)
                    .font(env.font(Size.resource, .semibold))
                    .foregroundStyle(env.colors.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/** A muted line in the small size that wraps (period, target, author). */
struct ScrollMutedLine: View {
    let text: String
    let env: WidgetEnv
    var size = Size.small

    var body: some View {
        Text(text)
            .font(env.font(size))
            .foregroundStyle(env.colors.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/** A value as large as fits the card, then compact (web: `ScrollValue`), tabular. */
struct ScrollValueText: View {
    let value: StudioRender.FittedValue
    let muted: Bool
    let env: WidgetEnv

    var body: some View {
        Text(value.text)
            .font(env.font(value.size, .semibold).monospacedDigit())
            .tracking(-0.01 * env.pt(value.size))
            .foregroundStyle(muted ? env.colors.muted : env.colors.text)
            .lineLimit(1)
            .padding(.top, 4)
    }
}

/** The notice (stale with its dot, failures with a sign) or else the freshness footer, wrapping in full. */
struct ScrollBottomLine: View {
    let notice: String?
    let stale: Bool
    let footer: String?
    let env: WidgetEnv

    var body: some View {
        if let notice {
            HStack(alignment: .firstTextBaseline, spacing: env.pt(Size.small * 0.3)) {
                if stale {
                    StaleDot(color: env.colors.warning, size: env.pt(Size.small * 0.45))
                } else {
                    Text(verbatim: "⚠").accessibilityHidden(true)
                }
                Text(notice).fixedSize(horizontal: false, vertical: true)
            }
            .font(env.font(Size.small))
            .foregroundStyle(env.colors.warning)
            .accessibilityElement(children: .combine)
        } else if let footer {
            Text(footer)
                .font(env.font(Size.small).monospacedDigit())
                .foregroundStyle(env.colors.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/** The first footer candidate ("updated 2 min. ago"): the scroll view wraps instead of choosing a shorter one. */
private func scrollFooter(_ updatedAt: String?, now: Date, language: ScreenLanguage) -> String? {
    WidgetFooter.candidates(updatedAt: updatedAt, source: nil, now: now, language: language).first
}

// MARK: Metric

/** The metric card: label, period, value, change, sparkline, and the notice or footer. */
struct ScrollMetricCard: View {
    let label: String
    let options: MetricWidgetOptions
    let data: MetricWidgetData
    let units: Double
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil && data.value != nil ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit, language: language)
        let compact =
            data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit, language: language)
        let change = MetricFormat.change(
            delta: data.change.delta, ratio: data.change.ratio, unit: unit, language: language)
        let comparison = MetricFormat.comparisonLabel(data.period, language: language)
        let tone = change.map { MetricFormat.tone($0.direction, better: data.better) } ?? .flat
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            ScrollMutedLine(text: MetricFormat.subtitle(data.tile(id: "", label: label), language: language), env: env)
            ScrollValueText(
                value: ScrollGeometry.value(full: full, compact: compact, units: units),
                muted: data.unit == nil || data.status == .stale, env: env)
            if options.showChange, data.unit != nil {
                Group {
                    if let change {
                        Text(changeLine("\(change.direction.arrow) \(change.text)", tone: tone, comparison: comparison))
                    } else {
                        Text(
                            data.value == nil
                                ? KitStrings.text(.noDataForPeriod, language)
                                : KitStrings.text(.noDataToCompare, language, comparison)
                        )
                        .foregroundStyle(env.colors.muted)
                    }
                }
                .font(env.font(Size.change))
                .fixedSize(horizontal: false, vertical: true)
            }
            if options.showSparkline, data.unit != nil, Sparkline.isDrawable(data.spark) {
                // 3 rem high (web: `.scroll-spark`).
                SparklineChart(spark: data.spark, env: env)
                    .frame(height: env.pt(3 * ScrollGeometry.unitsPerRem))
                    .padding(.vertical, env.pt(4))
            }
            ScrollBottomLine(
                notice: notice, stale: data.status == .stale,
                footer: scrollFooter(data.updatedAt, now: now, language: language), env: env)
        }
    }

    /** "▲ 12 %" in the tone's colour, then the comparison in muted (web: `.sw-change` and `.sw-comparison`). */
    private func changeLine(_ short: String, tone: MetricFormat.Direction, comparison: String) -> AttributedString {
        var head = AttributedString(short)
        head.foregroundColor = env.colors.tone(tone)
        var tail = AttributedString(" " + comparison)
        tail.foregroundColor = env.colors.muted
        return head + tail
    }
}

// MARK: Line

/** The line card: label, value and the chart, 16:9 of the card's width within 200 to 360 points. */
struct ScrollLineCard: View {
    let label: String
    let options: LineWidgetOptions
    let data: LineWidgetData
    let units: Double
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil && data.value != nil ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit, language: language)
        let compact =
            data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit, language: language)
        let previous = options.showPrevious ? Array(data.previous.prefix(data.values.count)) : []
        let domain = StudioRender.lineDomain(values: data.values, previous: previous)
        let chartHeight = ScrollGeometry.chartHeight(width: units * Double(env.u))
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            ScrollValueText(
                value: ScrollGeometry.value(full: full, compact: compact, units: units),
                muted: data.unit == nil || data.status == .stale, env: env)
            Group {
                if let domain, data.unit != nil {
                    LineChartView(
                        data: data, previous: previous, domain: domain, showAxis: options.showAxis,
                        axisSize: Size.small, unit: unit, env: env, timeZone: env.timeZone)
                } else if data.unit != nil {
                    ScrollMutedLine(text: L10n.tr("Not enough data for a chart yet", language), env: env)
                }
            }
            .frame(height: CGFloat(chartHeight), alignment: .topLeading)
            .padding(.top, 8)
            ScrollBottomLine(
                notice: notice, stale: data.status == .stale,
                footer: scrollFooter(data.updatedAt, now: now, language: language), env: env)
        }
    }
}

// MARK: Bar

/**
 * The bar card: every group the widget asks for, largest first, then
 * "Others". Labels wrap in full; nothing is folded away for lack of room.
 */
struct ScrollBarCard: View {
    let label: String
    let data: BarWidgetData
    let env: WidgetEnv
    let now: Date

    private struct Row {
        var label: String
        var value: Double
        var others: Bool
    }

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let rows =
            data.bars.map { Row(label: $0.label, value: $0.value, others: false) }
            + (data.others.map {
                [Row(label: $0.label.isEmpty ? KitStrings.text(.others, language) : $0.label, value: $0.value, others: true)]
            } ?? [])
        let top = rows.map(\.value).reduce(0, Swift.max)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if data.unit == nil {
                Text(verbatim: "—")
                    .font(env.font(Size.resource, .semibold))
                    .foregroundStyle(env.colors.muted)
            } else if rows.isEmpty {
                ScrollMutedLine(text: KitStrings.text(.noDataForPeriod, language), env: env)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline, spacing: env.pt(16)) {
                                Text(row.label)
                                    .foregroundStyle(row.others ? env.colors.muted : env.colors.label)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(approx + MetricFormat.value(row.value, unit: unit, language: language))
                                    .monospacedDigit()
                                    .foregroundStyle(row.others ? env.colors.muted : env.colors.text)
                                    .fixedSize()
                            }
                            .font(env.font(Size.resource, .semibold))
                            BarTrack(ratio: top > 0 ? Swift.max(0, row.value) / top : 0, others: row.others, env: env)
                                .frame(height: env.pt(ScrollGeometry.unitsPerRem / 2))
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.top, 6)
            }
            ScrollBottomLine(
                notice: notice, stale: data.status == .stale,
                footer: scrollFooter(data.updatedAt, now: now, language: language), env: env)
        }
    }
}

// MARK: Table

/**
 * The table card (ADR 0019 section 6): every row the widget asks for, then
 * Others; labels and values in full, the card grows instead of cutting.
 */
struct ScrollTableCard: View {
    let label: String
    let options: TableWidgetOptions
    let data: TableWidgetData
    /** The card's inner width in units: at large text sizes the rows stack (`ScrollGeometry.tableStacks`). */
    let units: Double
    let env: WidgetEnv
    let now: Date

    private struct Row {
        var label: String
        var value: String
        var change: (text: String, color: Color)?
        var others: Bool
    }

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let shown = Array(data.rows.prefix(Swift.max(0, options.limit)))
        let rows: [Row] =
            shown.map { row in
                Row(
                    label: row.label, value: approx + MetricFormat.value(row.value, unit: unit, language: language),
                    change: options.showChange ? change(row, unit: unit) : nil, others: false)
            }
            + (options.showOthers
                ? data.others.map {
                    [
                        Row(
                            label: $0.label,
                            value: approx + MetricFormat.value($0.value, unit: unit, language: language),
                            change: options.showChange ? ("", env.colors.muted) : nil, others: true)
                    ]
                } ?? [] : [])
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            ScrollMutedLine(
                text: KitStrings.text(.tableTop, language, shown.count) + " · "
                    + MetricFormat.periodLabel(data.period, language: language),
                env: env)
            if data.unit == nil {
                Text(verbatim: "—")
                    .font(env.font(Size.resource, .semibold))
                    .foregroundStyle(env.colors.muted)
            } else if rows.isEmpty {
                ScrollMutedLine(text: KitStrings.text(.noDataForPeriod, language), env: env)
            } else if ScrollGeometry.tableStacks(
                values: rows.map(\.value), changes: rows.compactMap { $0.change?.text }, units: units)
            {
                // Dynamic Type's largest sizes: each label on its own lines, its value and Δ under it.
                VStack(alignment: .leading, spacing: env.pt(12)) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label)
                                .foregroundStyle(row.others ? env.colors.muted : env.colors.label)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(alignment: .firstTextBaseline, spacing: env.pt(16)) {
                                Text(row.value)
                                    .font(env.font(Size.resource, .semibold).monospacedDigit())
                                    .foregroundStyle(row.others ? env.colors.muted : env.colors.text)
                                if let change = row.change, !change.text.isEmpty {
                                    Text(change.text)
                                        .font(env.font(Size.resource, .semibold).monospacedDigit())
                                        .foregroundStyle(change.color)
                                }
                            }
                        }
                        .font(env.font(Size.resource))
                        .accessibilityElement(children: .combine)
                    }
                }
            } else {
                // One grid for the heads and every row, so the columns line up.
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: env.pt(16), verticalSpacing: env.pt(12)) {
                    GridRow(alignment: .bottom) {
                        Text(data.columns.label.uppercased())
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(data.columns.value.uppercased())
                            .gridColumnAlignment(.trailing)
                        if options.showChange {
                            Text(verbatim: "Δ")
                                .gridColumnAlignment(.trailing)
                        }
                    }
                    .font(env.font(Size.small, .semibold))
                    .tracking(env.pt(Size.small * 0.06))
                    .foregroundStyle(env.colors.muted)
                    .accessibilityHidden(true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            Text(row.label)
                                .foregroundStyle(row.others ? env.colors.muted : env.colors.label)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(row.value)
                                .font(env.font(Size.resource, .semibold).monospacedDigit())
                                .foregroundStyle(row.others ? env.colors.muted : env.colors.text)
                                .fixedSize()
                            if options.showChange {
                                Text(row.change?.text ?? "")
                                    .font(env.font(Size.resource, .semibold).monospacedDigit())
                                    .foregroundStyle(row.change?.color ?? env.colors.muted)
                                    .fixedSize()
                            }
                        }
                        .font(env.font(Size.resource))
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            ScrollBottomLine(
                notice: notice, stale: data.status == .stale,
                footer: scrollFooter(data.updatedAt, now: now, language: language), env: env)
        }
    }

    /** A row's Δ: "+12 %" in `up` or `down` by `better`, "new", or "–" (web: `tableRowTexts`). */
    private func change(_ row: NetricsKit.TableRow, unit: String) -> (text: String, color: Color) {
        switch StudioLayout.tableChangeKind(value: row.value, previousValue: row.previousValue, ratio: row.ratio) {
        case .ratio:
            if let previous = row.previousValue,
                let change = MetricFormat.change(
                    delta: row.value - previous, ratio: row.ratio, unit: unit, language: env.language)
            {
                return (change.text, env.colors.tone(MetricFormat.tone(change.direction, better: data.better)))
            }
            return ("–", env.colors.muted)
        case .new:
            return (KitStrings.text(.tableNew, env.language), env.colors.muted)
        case .none:
            return ("–", env.colors.muted)
        }
    }
}

// MARK: Status board

/** The status board card (ADR 0019 section 7): every source, attention first, names wrapped in full. */
struct ScrollStatusCard: View {
    let label: String
    let options: StatusWidgetOptions
    let data: StatusWidgetData
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if data.items.isEmpty {
                ScrollMutedLine(text: KitStrings.text(.statusEmpty, language), env: env)
            } else {
                VStack(alignment: .leading, spacing: env.pt(12)) {
                    ForEach(Array(data.items.enumerated()), id: \.offset) { _, item in
                        row(item)
                    }
                }
                .padding(.top, env.pt(12))
                ScrollBottomLine(
                    notice: nil, stale: false, footer: StatusBoard.footer(data.items, language: language), env: env)
            }
        }
    }

    private func row(_ item: StatusItem) -> some View {
        let tone = StatusBoard.tone(item.status)
        let color: Color =
            switch tone {
            case .up: env.colors.up
            case .warning: env.colors.warning
            case .down: env.colors.down
            case .muted: env.colors.muted
            }
        return HStack(alignment: .firstTextBaseline, spacing: env.pt(16)) {
            Circle()
                .fill(color)
                .frame(width: env.pt(14), height: env.pt(14))
                .shadow(color: tone == .muted ? .clear : color.opacity(0.55), radius: env.pt(4))
                .alignmentGuide(.firstTextBaseline) { box in box.height * 0.85 }
            Text(item.name)
                .font(env.font(Size.resource))
                .foregroundStyle(env.colors.label)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if options.showAge {
                Text(StatusBoard.ageText(item.lastSuccessAt, now: now, language: env.language))
                    .font(env.font(Size.small).monospacedDigit())
                    .foregroundStyle(item.status == .stale ? env.colors.warning : env.colors.muted)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Compare

/** The compare card (ADR 0019 section 10): the operands with their captions, then the ratio, its label and change. */
struct ScrollCompareCard: View {
    let label: String
    let options: CompareWidgetOptions
    let data: CompareWidgetData
    let units: Double
    let env: WidgetEnv
    let now: Date
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let language = env.language
        let stale = data.status == .stale
        // Side by side; one under the other at the accessibility text sizes, where half the card cuts them.
        let stacked = typeSize.isAccessibilitySize
        let operands =
            stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
            : AnyLayout(HStackLayout(alignment: .top, spacing: env.pt(16)))
        let ratio = CompareText.ratio(data.ratio.value, format: data.ratio.format, unit: data.unit, language: language)
        let change =
            options.showChange
            ? StudioLayout.compareChange(
                value: data.ratio.value, previousValue: data.ratio.previousValue, format: data.ratio.format)
            : nil
        let tone = change.map {
            MetricFormat.tone(MetricFormat.Direction(rawValue: $0.direction.rawValue) ?? .flat, better: data.better)
        }
        let notice = dataNotice(
            status: data.status, updatedAt: data.updatedAt,
            unit: data.numerator.unit == nil || data.denominator.unit == nil ? nil : "count", language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            ScrollMutedLine(text: MetricFormat.periodLabel(data.period, language: language), env: env)
            operands {
                operand(data.numerator, stale: stale, units: stacked ? units : (units - 48) / 2)
                Text(verbatim: StudioLayout.compareSeparator)
                    .font(env.font(Size.valueMin))
                    .foregroundStyle(env.colors.muted)
                    .accessibilityHidden(true)
                operand(data.denominator, stale: stale, units: stacked ? units : (units - 48) / 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(ratio)
                    .font(env.font(Size.valueMax, .semibold).monospacedDigit())
                    .tracking(-0.01 * env.pt(Size.valueMax))
                    .foregroundStyle(data.ratio.value == nil || stale ? env.colors.muted : env.colors.chartLine)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                HStack(alignment: .firstTextBaseline, spacing: env.pt(12)) {
                    Text(CompareText.ratioLabel(options, language: language))
                        .foregroundStyle(env.colors.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if let change {
                        Text(CompareText.change(change, language: language))
                            .foregroundStyle(stale || tone == nil ? env.colors.muted : env.colors.tone(tone!))
                            .fixedSize()
                    }
                }
                .font(env.font(Size.change))
            }
            ScrollBottomLine(
                notice: notice, stale: stale,
                footer: CompareText.footerCandidates(updatedAt: data.updatedAt, now: now, language: language).first,
                env: env)
        }
    }

    /** One operand: the number (as large as its room allows, at most the value minimum) over its caption. */
    private func operand(_ operand: CompareOperand, stale: Bool, units: Double) -> some View {
        let text = CompareText.operand(operand, language: env.language)
        let value = ScrollGeometry.value(full: text.full, compact: text.compact, units: units)
        return VStack(alignment: .leading, spacing: 0) {
            Text(value.text)
                .font(env.font(Swift.min(value.size, Size.valueMin), .semibold).monospacedDigit())
                .foregroundStyle(operand.value == nil || stale ? env.colors.muted : env.colors.text)
                .lineLimit(1)
                // Dynamic Type can outgrow the room `value` chose for: smaller, never cut.
                .minimumScaleFactor(0.5)
            ScrollMutedLine(text: operand.label, env: env)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Goal (gauge)

/** The goal card (ADR 0019 section 5): label, target line, the ring with the percent or value inside, the progress line. */
struct ScrollGaugeCard: View {
    let label: String
    let options: GaugeWidgetOptions
    let data: GaugeWidgetData
    let units: Double
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let stale = data.status == .stale
        let reached = Goals.reached(data.progress) && !stale
        let (full, compact, suffix) = GaugeWidgetView.ringTexts(
            reached: Goals.reached(data.progress), value: data.value, percent: Goals.percent(data.progress),
            unit: unit, approx: approx, language: language)
        let ring = ScrollGeometry.ring(units: units, suffix: suffix)
        let value = ScrollGeometry.ringValue(full: full, compact: compact, room: ring.room)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if data.goal == nil {
                Text(KitStrings.text(.goalDeleted, language))
                    .font(env.font(Size.title))
                    .foregroundStyle(env.colors.muted)
            } else {
                if let target = data.target {
                    ScrollMutedLine(
                        text: KitStrings.text(
                            .goalTarget, language, approx + MetricFormat.value(target, unit: unit, language: language)),
                        env: env)
                }
                GoalRing(
                    fraction: Swift.min(Swift.max(data.progress ?? 0, 0), 1), diameter: env.pt(ring.diameter),
                    stroke: env.pt(ring.stroke),
                    fill: stale ? env.colors.muted : (reached ? env.colors.up : env.colors.chartLine),
                    track: env.colors.border
                )
                .overlay {
                    HStack(alignment: .firstTextBaseline, spacing: env.pt(Size.change * StudioLayout.GaugeSpacing.suffixGap)) {
                        Text(value.text).font(env.font(value.size, .semibold).monospacedDigit())
                        if let suffix {
                            Text(suffix).font(env.font(Size.change, .semibold))
                        }
                    }
                    .foregroundStyle(stale ? env.colors.muted : (reached ? env.colors.up : env.colors.text))
                    .lineLimit(1)
                    // "83 %" as one word for VoiceOver, not "83" and "%".
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        suffix != nil
                            ? Goals.percent(data.progress).map(GaugeWidgetView.percentText) ?? value.text : value.text)
                }
                .padding(.vertical, 4)
                Text(GaugeWidgetView.progressLine(data, options: options, now: now, timeZone: env.timeZone, language: language))
                    .font(env.font(Size.change, reached ? .medium : .regular))
                    .foregroundStyle(reached ? env.colors.up : env.colors.muted)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollBottomLine(
                    notice: notice, stale: stale, footer: scrollFooter(data.updatedAt, now: now, language: language),
                    env: env)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Latest review

/** The latest-review card (ADR 0019 section 12): the stars, the title and the whole text, the author line. */
struct ScrollReviewCard: View {
    let label: String
    let data: ReviewWidgetData
    let icon: StoredImage?
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        let state: String? =
            switch data.status {
            case .authFailed: KitStrings.text(.reviewsPaused, language)
            case .backfilling: KitStrings.text(.loadingHistory, language)
            case .noData: KitStrings.text(.noReviews, language)
            default: data.review == nil ? KitStrings.text(.noReviews, language) : nil
            }
        let notice =
            data.status == .stale || data.status == .outage
            ? TileNotices.notice(status: data.status, updatedAt: data.updatedAt, language: language) : nil
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if let review = data.review, state == nil {
                HStack(spacing: env.pt(12)) {
                    if let icon {
                        DownsampledImage(
                            file: icon.url, image: icon.image, fit: .cover, align: .center,
                            box: CGSize(width: env.pt(48), height: env.pt(48)), displayScale: env.displayScale
                        )
                        .frame(width: env.pt(48), height: env.pt(48))
                        .clipShape(RoundedRectangle(cornerRadius: env.pt(10)))
                        .accessibilityHidden(true)
                    }
                    ReviewStarsView(rating: review.rating, size: Size.change, env: env)
                }
                if let title = review.title {
                    Text(title)
                        .font(env.font(Size.title, .semibold))
                        .foregroundStyle(env.colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let body = review.body {
                    Text(body)
                        .font(env.font(Size.resource))
                        .foregroundStyle(env.colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ScrollMutedLine(text: ReviewText.authorLine(review, now: now, language: language), env: env)
            } else {
                ScrollMutedLine(text: state ?? "…", env: env)
            }
            ScrollBottomLine(notice: notice, stale: data.status == .stale, footer: nil, env: env)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Clock and countdown

/** The clock card: the time in the accent colour as large as fits, the date and the zone line, centred. */
struct ScrollClockCard: View {
    let options: ClockWidgetOptions
    let units: Double
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let text = TVTime.clockWidget(
            now, timeZone: options.timeZone ?? env.timeZone, hour12: options.hour12, showDate: options.showDate,
            dateStyle: options.dateStyle, showZone: options.showZone, language: env.language)
        VStack(spacing: CGFloat(ScrollGeometry.cardGap)) {
            Text(text.time)
                .font(env.font(ScrollGeometry.clockSize(time: text.time, units: units), .semibold).monospacedDigit())
                .foregroundStyle(env.colors.accent)
                .lineLimit(1)
            if let date = text.date {
                ScrollMutedLine(text: date, env: env, size: Size.date)
            }
            if let zone = text.zone {
                ScrollMutedLine(text: zone, env: env)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/** The countdown card (ADR 0019 section 8): the label, the time left (or the text when reached) and the target line. */
struct ScrollCountdownCard: View {
    let label: String
    let options: CountdownWidgetOptions
    let units: Double
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let view = StudioRender.countdownView(
            now: now, label: label, options: options, timeZone: options.timeZone ?? env.timeZone,
            placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), fontScale: 1, showHeader: true,
            language: env.language)
        let sizes = ScrollGeometry.countdownSizes(view.groups, units: units)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if let done = view.doneText {
                Text(done)
                    .font(env.font(Size.valueMin, .semibold))
                    .foregroundStyle(env.colors.accent)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                // One line; at the largest text sizes, where it would be cut, one group a line.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        ForEach(Array(view.groups.enumerated()), id: \.offset) { index, group in
                            countdownGroup(group, sizes: sizes)
                                .padding(.leading, index > 0 ? env.pt(sizes.value * 0.3) : 0)
                        }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(view.groups.enumerated()), id: \.offset) { _, group in
                            countdownGroup(group, sizes: sizes)
                        }
                    }
                }
                .lineLimit(1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(view.text)
            }
            if let target = view.target {
                ScrollMutedLine(text: target, env: env)
            }
        }
    }

    private func countdownGroup(_ group: CountdownShownGroup, sizes: (value: Double, unit: Double)) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: env.pt(sizes.value * 0.08)) {
            Text(group.value)
                .font(env.font(sizes.value, .semibold).monospacedDigit())
                .foregroundStyle(env.colors.text)
            Text(group.unit)
                .font(env.font(sizes.unit, .medium))
                .foregroundStyle(env.colors.muted)
        }
    }
}

// MARK: Text and image

/** The text card: the widget's markdown-lite at the scroll view's sizes. */
struct ScrollTextCard: View {
    let text: String
    let options: TextWidgetOptions
    let env: WidgetEnv

    var body: some View {
        let size = Size.text(options.size)
        let horizontal: HorizontalAlignment =
            options.align == .center ? .center : options.align == .end ? .trailing : .leading
        let textAlign: TextAlignment = options.align == .center ? .center : options.align == .end ? .trailing : .leading
        let frameAlign: Alignment = options.align == .center ? .top : options.align == .end ? .topTrailing : .topLeading
        VStack(alignment: horizontal, spacing: env.pt(size * 0.5)) {
            ForEach(Array(StudioLayout.parseText(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let spans):
                    Text(attributed([spans], size: size * (level == 1 ? 1.25 : 1.1), weight: .bold))
                        .accessibilityAddTraits(.isHeader)
                case .paragraph(let lines):
                    Text(attributed(lines, size: size, weight: .regular))
                }
            }
        }
        .foregroundStyle(env.colors.text)
        .multilineTextAlignment(textAlign)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: frameAlign)
    }

    private func attributed(_ lines: [[StudioTextSpan]], size: Double, weight: Font.Weight) -> AttributedString {
        var result = AttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result += AttributedString("\n") }
            for span in line {
                var run = AttributedString(span.text)
                var font = env.font(size, span.bold ? .bold : weight)
                if span.italic { font = font.italic() }
                run.font = font
                result += run
            }
        }
        return result
    }
}

/** The image card: the whole image at its aspect, at most half the view high. */
struct ScrollImageCard: View {
    let image: StoredImage?
    let label: String?
    /** The image's width in points (the card less its padding). */
    let width: Double
    let viewportHeight: Double
    let env: WidgetEnv

    var body: some View {
        if let image {
            let aspect = image.image.height > 0 ? Double(image.image.width) / Double(image.image.height) : nil
            let height = ScrollGeometry.imageHeight(width: width, aspect: aspect, viewportHeight: viewportHeight)
            DownsampledImage(
                file: image.url, image: image.image, fit: .contain, align: .center,
                box: CGSize(width: width, height: height), displayScale: env.displayScale
            )
            .frame(width: CGFloat(width), height: CGFloat(height))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityElement()
            .accessibilityLabel(label ?? "")
            .accessibilityAddTraits(.isImage)
        } else {
            ScrollBottomLine(
                notice: L10n.tr("Image not available", env.language), stale: false, footer: nil, env: env
            )
            .padding(8)
        }
    }
}
