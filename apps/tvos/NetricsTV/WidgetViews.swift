import ImageIO
import NetricsKit
import SwiftUI

// The schema 2 widget renderers (ADR 0015, sections 2 and 8; ADR 0018,
// sections 5 and 6), the counterparts of apps/web/src/components/studio.
// Sizes come from StudioRender in canvas units, colours from the theme
// tokens and what SignalDesign derives from them. Titles and resource names
// wrap to two lines and shrink to the minimum before the last-resort
// ellipsis; values switch to the compact form, never cut. Data widgets say
// when their numbers were updated, and take a surface of their own when
// they cannot show them (auth failed, no data, backfilling).

struct WidgetView: View {
    let widget: DeviceWidget
    /** Where the widget is on this screen: cells in the format's grid, and its box in units off the classic canvas. */
    let placement: ScreenPlacement
    let env: WidgetEnv
    let image: StoredImage?

    var body: some View {
        switch widget.content {
        case .metric(let options, let data):
            // The footer's "updated 2 min. ago" is worded anew every minute.
            TimelineView(.everyMinute) { context in
                MetricWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .line(let options, let data):
            TimelineView(.everyMinute) { context in
                LineWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .bar(_, let data):
            TimelineView(.everyMinute) { context in
                BarWidgetView(label: widget.label ?? "", placement: placement, data: data, env: env, now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .table(let options, let data):
            TimelineView(.everyMinute) { context in
                TableWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .status(let options, let data):
            TimelineView(.everyMinute) { context in
                StatusWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .compare(let options, let data):
            TimelineView(.everyMinute) { context in
                CompareWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .gauge(let options, let data):
            TimelineView(.everyMinute) { context in
                GaugeWidgetView(
                    label: widget.label ?? "", placement: placement, options: options, data: data, env: env,
                    now: context.date)
            }
            .surface(env, state: GaugeWidgetView.surfaceState(data))
        case .review(_, _, let data):
            // The age in the author line is worded anew every minute.
            TimelineView(.everyMinute) { context in
                ReviewWidgetView(
                    label: widget.label ?? "", placement: placement, data: data, icon: image, env: env,
                    now: context.date)
            }
            .surface(env, state: SurfaceState(data.status))
        case .image(_, let options):
            ImageWidgetView(stored: image, options: options, label: widget.label, env: env)
        case .text(let text, let options):
            TextWidgetView(text: text, options: options, placement: placement, env: env)
        case .clock(let options):
            ClockWidgetView(options: options, placement: placement, env: env)
                .surface(env)
        case .countdown(let options):
            CountdownWidgetView(
                label: widget.label ?? KitStrings.text(.countdownLabel, env.language), options: options,
                placement: placement, env: env
            )
            .surface(env)
        case .unsupported:
            // A type this build does not know (a newer server), or one it
            // cannot read: its cell stays, empty and themed.
            Color.clear.surface(env)
        }
    }
}

/** A title or resource line at its fitted size, at most two lines. */
struct LabelLine: View {
    let fitted: StudioRender.FittedLabel
    let env: WidgetEnv

    var body: some View {
        Text(fitted.text)
            .font(env.font(fitted.size, .semibold))
            .foregroundStyle(env.colors.label)
            .lineLimit(2)
            .truncationMode(.tail)
            .lineSpacing(0)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(fitted.text)
    }
}

struct WidgetLabelView: View {
    let layout: StudioRender.LabelLayout
    let env: WidgetEnv

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LabelLine(fitted: layout.title, env: env)
            if let resource = layout.resource {
                LabelLine(fitted: resource, env: env)
            }
        }
        .padding(.bottom, env.pt(StudioRender.stackGap))
    }
}

/**
 * A stale or failure notice in the theme's warning colour. A stale one
 * (the last sync is too long ago) starts with a dot that blinks on a
 * playing slide (ADR 0018 sections 5 and 6); the others with a sign.
 */
struct NoticeLine: View {
    let text: String
    let size: Double
    let env: WidgetEnv
    var stale = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: env.pt(size * 0.3)) {
            if stale {
                StaleDot(color: env.colors.warning, size: env.pt(size * 0.45))
            } else {
                Text("⚠")
            }
            Text(text)
        }
        .font(env.font(size))
        .foregroundStyle(env.colors.warning)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/** The freshness footer: one muted line at the bottom of a data widget. */
struct FooterLine: View {
    let text: String
    let size: Double
    let env: WidgetEnv

    var body: some View {
        Text(text)
            .font(env.font(size).monospacedDigit())
            .foregroundStyle(env.colors.muted)
            .lineLimit(1)
    }
}

/** A data widget's notice: its connection's state, or that it could not load. */
func dataNotice(status: DeviceTileStatus, updatedAt: String?, unit: String?, language: ScreenLanguage) -> String? {
    if let notice = TileNotices.notice(status: status, updatedAt: updatedAt, language: language) {
        return notice
    }
    return unit == nil ? KitStrings.text(.couldNotLoad, language) : nil
}

/**
 * How a counting value is worded on every frame of the enter: as the
 * shown text is, in full or compact, with its "≈"; nil when the shown text
 * is neither (nothing counts then). Web: `countFormat`.
 */
func countFormat(
    shown: String, full: String, compact: String, value: Double?, unit: String?, approximate: Bool,
    language: ScreenLanguage
) -> ((Double) -> String)? {
    guard let unit, value != nil else { return nil }
    let approx = approximate ? "≈ " : ""
    if shown == full {
        return { approx + MetricFormat.value($0, unit: unit, language: language) }
    }
    if shown == compact {
        return { approx + MetricFormat.compactValue($0, unit: unit, language: language) }
    }
    return nil
}

/**
 * A data widget whose numbers cannot be shown (ADR 0018 section 5, design
 * 4b): its label, then for auth failed "Reconnect the source" with a hint
 * and when it last worked in the footer; for no data and backfilling a
 * skeleton block (sweeping while the history loads) and what is going on.
 * No value, no chart. The label and the sizes are the widget's own
 * layout's, so the shared layout math is unchanged.
 */
struct DataStateView: View {
    let surface: DataSurface
    let type: StudioWidgetType
    let label: StudioRender.LabelLayout
    /** The layout's smallest text size (at least 24 units). */
    let small: Double
    let updatedAt: String?
    let placement: ScreenPlacement
    let env: WidgetEnv
    let now: Date
    /** The surface's lines when the type words them itself (a latest review). */
    var texts: (headline: String?, hint: String)? = nil

    var body: some View {
        // Screens carry no source name: "Reconnect the source".
        let texts = self.texts ?? surface.texts(source: nil, language: env.language)
        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: label, env: env)
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: env.pt(6)) {
                if let headline = texts.headline {
                    Text(headline)
                        .font(env.font(DataSurface.reconnectSize(small: small), .semibold))
                        .foregroundStyle(env.colors.down)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    SkeletonBlock(env: env, sweeping: surface == .backfilling)
                }
                Text(texts.hint)
                    .font(env.font(small))
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if surface == .authFailed,
                let footer = WidgetFooter.line(
                    WidgetFooter.candidates(updatedAt: updatedAt, source: nil, now: now, language: env.language),
                    type: type, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                    unitBox: placement.unitBox)
            {
                FooterLine(text: footer, size: small, env: env)
                    .padding(.top, env.pt(12))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Metric

struct MetricWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: MetricWidgetOptions
    let data: MetricWidgetData
    let env: WidgetEnv
    var now = Date()

    @Environment(\.enterProgress) private var progress

    var body: some View {
        let tile = data.tile(id: "", label: label)
        let unit = data.unit ?? "count"
        let approximate = data.conversion != nil && data.value != nil
        let approx = approximate ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit, language: env.language)
        let compact = data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit, language: env.language)
        let change = MetricFormat.change(
            delta: data.change.delta, ratio: data.change.ratio, unit: unit, language: env.language)
        let comparison = MetricFormat.comparisonLabel(data.period, language: env.language)
        let changeLine: (full: String, short: String, comparison: String?)? =
            !options.showChange || data.unit == nil
            ? nil
            : change.map {
                ("\($0.direction.arrow) \($0.text) \(comparison)", "\($0.direction.arrow) \($0.text)", comparison)
            }
                ?? (data.value == nil
                    ? (KitStrings.text(.noDataForPeriod, env.language), KitStrings.text(.noDataYet, env.language), nil)
                    : (
                        KitStrings.text(.noDataToCompare, env.language, comparison),
                        KitStrings.text(.noComparison, env.language), nil
                    ))
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: env.language)
        let note = ConversionFormat.note(data.conversion, language: env.language)
        // The footer takes the slot under the numbers (the web's source
        // line); a notice replaces it, and without a footer the conversion
        // note keeps the slot.
        let footer =
            notice != nil
            ? nil
            : WidgetFooter.line(
                WidgetFooter.candidates(updatedAt: data.updatedAt, source: nil, now: now, language: env.language),
                type: .metric, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox)
        let slot = footer ?? note
        let layout = StudioRender.metricLayout(
            label: label, value: (full, compact), periodText: MetricFormat.subtitle(tile, language: env.language), change: changeLine,
            notice: notice, note: slot, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
            showSparkline: options.showSparkline && Sparkline.isDrawable(data.spark), unitBox: placement.unitBox)
        let tone = change.map { MetricFormat.tone($0.direction, better: data.better) } ?? .flat

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .metric, label: layout.label, small: layout.small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: layout.label, env: env)
                if layout.showPeriod {
                    Text(MetricFormat.subtitle(tile, language: env.language))
                        .font(env.font(layout.small))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Between the label and the value (design 4a): only the
                // order changes, the heights are the layout's.
                if layout.sparkline > 0 {
                    SparklineChart(spark: data.spark, env: env)
                        .frame(maxHeight: .infinity)
                        .padding(.vertical, env.pt(StudioRender.stackGap / 2))
                }
                CountingValue(
                    final: layout.value.text, target: data.value,
                    format: countFormat(
                        shown: layout.value.text, full: full, compact: compact, value: data.value, unit: data.unit,
                        approximate: approximate, language: env.language)
                )
                .font(env.font(layout.value.size, .semibold).monospacedDigit())
                .tracking(-0.01 * env.pt(layout.value.size))
                .foregroundStyle(data.unit == nil || data.status == .stale ? env.colors.muted : env.colors.text)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                if let changeText = layout.changeText {
                    Text(changeText)
                        .font(env.font(layout.change))
                        .foregroundStyle(change == nil ? env.colors.muted : env.colors.tone(tone))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if let comparisonText = layout.comparisonText {
                    Text(comparisonText)
                        .font(env.font(layout.comparison))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if layout.sparkline == 0 {
                    Spacer(minLength: 0)
                }
                if layout.showNote, let slot {
                    if slot == footer {
                        FooterLine(text: slot, size: layout.small, env: env)
                    } else {
                        Text(slot)
                            .font(env.font(layout.small))
                            .foregroundStyle(env.colors.muted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                if let notice {
                    NoticeLine(text: notice, size: layout.small, env: env, stale: data.status == .stale)
                }
            }
        }
    }
}

/**
 * The metric widget's sparkline: the chart line, drawn while the slide
 * enters, gaps for null buckets, and the latest point in the accent with
 * its pulse once the draw is done.
 */
struct SparklineChart: View {
    let spark: [Double?]
    let env: WidgetEnv

    @Environment(\.enterProgress) private var progress

    var body: some View {
        let colors = env.colors
        let values = spark.compactMap { $0 }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let pad = high > low ? (high - low) * 0.08 : max(abs(high) * 0.1, 1)
        let series = PlotSeries(spark, domain: (low - pad)...(high + pad))
        let lineWidth = max(2, env.pt(3))
        let dot = env.pt(5)
        GeometryReader { box in
            ZStack(alignment: .topLeading) {
                SeriesLine(series: series)
                    .trim(from: 0, to: progress)
                    .stroke(colors.chartLine, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                if let last = series.last {
                    let point = CGPoint(x: last.x * box.size.width, y: last.y * box.size.height)
                    ZStack {
                        PulseRing(color: colors.accent, radius: dot, reach: env.pt(EnterMotion.pulseRing))
                        Circle().fill(colors.accent).frame(width: dot * 2, height: dot * 2)
                    }
                    .position(point)
                    .modifier(AppearAtEnd(progress: progress))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: Line

struct LineWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: LineWidgetOptions
    let data: LineWidgetData
    let env: WidgetEnv
    var now = Date()

    var body: some View {
        let unit = data.unit ?? "count"
        let approximate = data.conversion != nil && data.value != nil
        let approx = approximate ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit, language: env.language)
        let compact = data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit, language: env.language)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: env.language)
        let fitted = WidgetFooter.chartLayout(
            type: .line, label: label, value: (full, compact), notice: notice,
            footer: WidgetFooter.line(
                WidgetFooter.candidates(updatedAt: data.updatedAt, source: nil, now: now, language: env.language),
                type: .line, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox),
            placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
            unitBox: placement.unitBox)
        let layout = fitted.layout
        let previous = options.showPrevious ? Array(data.previous.prefix(data.values.count)) : []
        let domain = StudioRender.lineDomain(values: data.values, previous: previous)

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .line, label: layout.label, small: layout.small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: layout.label, env: env)
                if let value = layout.value {
                    CountingValue(
                        final: value.text, target: data.value,
                        format: countFormat(
                            shown: value.text, full: full, compact: compact, value: data.value, unit: data.unit,
                            approximate: approximate, language: env.language)
                    )
                    .font(env.font(value.size, .semibold).monospacedDigit())
                    .tracking(-0.01 * env.pt(value.size))
                    .foregroundStyle(data.unit == nil || data.status == .stale ? env.colors.muted : env.colors.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .padding(.bottom, env.pt(StudioRender.stackGap))
                }
                if let domain, data.unit != nil {
                    LineChartView(
                        data: data, previous: previous, domain: domain, showAxis: options.showAxis, axisSize: layout.axis,
                        unit: unit, env: env, timeZone: env.timeZone)
                    .frame(maxHeight: .infinity)
                } else {
                    Text(data.unit == nil ? "" : KitStrings.text(.noDataForPeriod, env.language))
                        .font(env.font(layout.small))
                        .foregroundStyle(env.colors.muted)
                    Spacer(minLength: 0)
                }
                if let notice {
                    NoticeLine(text: notice, size: layout.small, env: env, stale: data.status == .stale)
                } else if let footer = fitted.footer {
                    FooterLine(text: footer, size: layout.small, env: env)
                }
            }
        }
    }
}

/**
 * The period's line over the area under it (fading from the chart fill to
 * nothing), the previous period dashed behind it, on one value axis from
 * zero, and a dot at the latest point with its pulse. While the slide
 * enters the line draws, the area and the previous period fade in, and the
 * dot appears when the draw is done. Axis labels (top and bottom value,
 * first and last bucket) are at least 24 units.
 */
struct LineChartView: View {
    let data: LineWidgetData
    let previous: [Double?]
    let domain: ClosedRange<Double>
    let showAxis: Bool
    let axisSize: Double
    let unit: String
    let env: WidgetEnv
    let timeZone: String

    @Environment(\.enterProgress) private var progress

    var body: some View {
        let colors = env.colors
        let count = data.values.count
        let current = PlotSeries(data.values, domain: domain, count: count)
        let earlier = PlotSeries(previous, domain: domain, count: count)
        let span = domain.upperBound - domain.lowerBound
        let base = CGFloat(span > 0 ? 1 - (max(domain.lowerBound, 0) - domain.lowerBound) / span : 1)
        let radius = env.pt(max(9, axisSize * 0.3))
        let chart = GeometryReader { box in
            ZStack(alignment: .topLeading) {
                SeriesArea(series: current, base: base)
                    .fill(
                        LinearGradient(
                            colors: [colors.chartFill.opacity(0.35), colors.chartFill.opacity(0)], startPoint: .top,
                            endPoint: .bottom)
                    )
                    .opacity(progress)
                SeriesLine(series: earlier)
                    .stroke(
                        colors.muted,
                        style: StrokeStyle(lineWidth: env.pt(3), lineCap: .butt, dash: [env.pt(12), env.pt(9)]))
                    .opacity(0.8 * progress)
                SeriesLine(series: current)
                    .trim(from: 0, to: progress)
                    .stroke(
                        colors.chartLine, style: StrokeStyle(lineWidth: env.pt(5.25), lineCap: .round, lineJoin: .round))
                if let last = current.last {
                    ZStack {
                        PulseRing(color: colors.accent, radius: radius, reach: env.pt(EnterMotion.pulseRing))
                        Circle().fill(colors.accent).frame(width: radius * 2, height: radius * 2)
                    }
                    .position(x: last.x * box.size.width, y: last.y * box.size.height)
                    .modifier(AppearAtEnd(progress: progress))
                }
            }
        }
        .accessibilityHidden(true)

        if showAxis {
            let font = env.font(axisSize).monospacedDigit()
            VStack(spacing: env.pt(8)) {
                HStack(alignment: .top, spacing: env.pt(12)) {
                    VStack(alignment: .trailing) {
                        Text(MetricFormat.compactValue(domain.upperBound, unit: unit, language: env.language))
                        Spacer(minLength: 0)
                        Text(MetricFormat.compactValue(domain.lowerBound, unit: unit, language: env.language))
                    }
                    .font(font)
                    .foregroundStyle(colors.muted)
                    .fixedSize(horizontal: true, vertical: false)
                    chart
                        .overlay(alignment: .bottom) {
                            // The axis line under the plot (web: .sw-axis).
                            Rectangle().fill(colors.border).frame(height: env.pt(2))
                        }
                }
                HStack {
                    Text(data.buckets.first.flatMap { MetricFormat.bucketLabel($0, period: data.period, timeZone: timeZone, language: env.language) } ?? "")
                    Spacer(minLength: env.pt(12))
                    if data.buckets.count > 1 {
                        Text(data.buckets.last.flatMap { MetricFormat.bucketLabel($0, period: data.period, timeZone: timeZone, language: env.language) } ?? "")
                    }
                }
                .font(font)
                .foregroundStyle(colors.muted)
                .lineLimit(1)
            }
        } else {
            chart
        }
    }
}

// MARK: Bar

struct BarWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let data: BarWidgetData
    let env: WidgetEnv
    var now = Date()

    var body: some View {
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: env.language)
        let fitted = WidgetFooter.chartLayout(
            type: .bar, label: label, value: nil, notice: notice,
            footer: WidgetFooter.line(
                WidgetFooter.candidates(updatedAt: data.updatedAt, source: nil, now: now, language: env.language),
                type: .bar, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox),
            placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
            unitBox: placement.unitBox)
        let layout = fitted.layout
        let bars = StudioRender.barLayout(
            bars: data.bars, others: data.others, width: layout.chartWidth, height: layout.chartHeight,
            size: layout.resource, format: { approx + MetricFormat.value($0, unit: unit, language: env.language) },
            othersLabel: KitStrings.text(.others, env.language))

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .bar, label: layout.label, small: layout.small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: layout.label, env: env)
                if bars.rows.isEmpty {
                    Text(data.unit == nil ? "—" : KitStrings.text(.noDataForPeriod, env.language))
                        .font(env.font(layout.small))
                        .foregroundStyle(env.colors.muted)
                    Spacer(minLength: 0)
                } else {
                    VStack(alignment: .leading, spacing: env.pt(bars.rowGap)) {
                        ForEach(Array(bars.rows.enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: env.pt(4)) {
                                HStack(alignment: .firstTextBaseline, spacing: env.pt(16)) {
                                    Text(row.label.text)
                                        .font(env.font(bars.size, .semibold))
                                        .foregroundStyle(row.others ? env.colors.muted : env.colors.label)
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                    Text(row.valueText)
                                        .font(env.font(bars.size, .semibold).monospacedDigit())
                                        .foregroundStyle(row.others ? env.colors.muted : env.colors.text)
                                        .lineLimit(1)
                                        .fixedSize()
                                }
                                BarTrack(ratio: row.ratio, others: row.others, env: env)
                                    .frame(height: env.pt(bars.barHeight))
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                if let notice {
                    NoticeLine(text: notice, size: layout.small, env: env, stale: data.status == .stale)
                } else if let footer = fitted.footer {
                    FooterLine(text: footer, size: layout.small, env: env)
                }
            }
        }
    }
}

/**
 * One bar on its track: the fill runs from a deeper shade of the chart
 * fill to the fill (flat themes: the plain fill), "Others" dimmed; it grows
 * from the start while the slide enters.
 */
struct BarTrack: View {
    let ratio: Double
    let others: Bool
    let env: WidgetEnv

    @Environment(\.enterProgress) private var progress
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let derived = env.colors.derived
        let shape = RoundedRectangle(cornerRadius: env.pt(6))
        GeometryReader { box in
            ZStack(alignment: .leading) {
                shape.fill(Color(derived.track))
                shape
                    .fill(
                        LinearGradient(
                            colors: [Color(derived.barStart), Color(derived.barEnd)], startPoint: .leading,
                            endPoint: .trailing)
                    )
                    .frame(width: max(2 / max(displayScale, 1), box.size.width * CGFloat(min(1, max(0, ratio)))))
                    .opacity(others ? 0.5 : 1)
                    .scaleEffect(x: progress, y: 1, anchor: .leading)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: Table

/**
 * The table widget (ADR 0019 section 6; web: `TableWidgetView`): the label,
 * "Top N · Last 30 days", the column heads (caps, muted), then one row per
 * group with its value (tabular, compact when the label column would get
 * too narrow, never cut) and its Δ coloured by `better`. Rows shown are
 * min(limit, rows, rowCapacity), and the subtitle says how many; a last,
 * dimmed "Others" row only while a slot is left. Row labels shrink to
 * 24 u and only then end with an ellipsis (data text). On slide enter the
 * rows rise 14 u and fade in, 90 ms apart; values do not count.
 */
struct TableWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: TableWidgetOptions
    let data: TableWidgetData
    let env: WidgetEnv
    var now = Date()

    private struct ShownRow {
        var label: String
        var full: String
        var compact: String
        var change: (text: String, color: Color)?
        var others: Bool
    }

    var body: some View {
        let unit = data.unit ?? "count"
        let language = env.language
        let approx = data.conversion != nil ? "≈ " : ""
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .table, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let capacity = StudioLayout.tableLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale,
            showChange: options.showChange
        ).rowCapacity
        let shownCount = StudioLayout.tableRowsShown(
            limit: options.limit, rows: data.rows.count, rowCapacity: capacity)
        let rows: [ShownRow] =
            data.rows.prefix(shownCount).map { row in
                ShownRow(
                    label: row.label,
                    full: approx + MetricFormat.value(row.value, unit: unit, language: language),
                    compact: approx + MetricFormat.compactValue(row.value, unit: unit, language: language),
                    change: options.showChange ? change(row, unit: unit) : nil,
                    others: false)
            }
            + (options.showOthers && shownCount < capacity
                ? data.others.map {
                    [
                        ShownRow(
                            label: $0.label,
                            full: approx + MetricFormat.value($0.value, unit: unit, language: language),
                            compact: approx + MetricFormat.compactValue($0.value, unit: unit, language: language),
                            change: nil, others: true)
                    ]
                } ?? [] : [])
        let layout = StudioLayout.tableLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale,
            values: rows.map { StudioLayout.TableValueText(full: $0.full, compact: $0.compact) },
            showChange: options.showChange)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        let footer =
            notice != nil
            ? nil
            : WidgetFooter.line(
                WidgetFooter.candidates(updatedAt: data.updatedAt, source: nil, now: now, language: language),
                type: .table, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox)
        let small = sizes[.any] ?? StudioLayout.Minimum.any

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .table, label: labelLayout, small: small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: labelLayout, env: env)
                Text(
                    KitStrings.text(.tableTop, language, shownCount) + " · "
                        + MetricFormat.periodLabel(data.period, language: language)
                )
                .font(env.font(layout.sizes.subtitle))
                .foregroundStyle(env.colors.muted)
                .lineLimit(1)
                .padding(.bottom, env.pt(StudioLayout.TableSpacing.stack))
                TableHeadRow(
                    label: data.columns.label, value: data.columns.value, showChange: options.showChange,
                    layout: layout, env: env)
                if rows.isEmpty {
                    Text(data.unit == nil ? "—" : KitStrings.text(.noDataForPeriod, language))
                        .font(env.font(small))
                        .foregroundStyle(env.colors.muted)
                        .padding(.top, env.pt(StudioLayout.TableSpacing.rowGap))
                } else {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        TableRowView(
                            label: row.label, value: layout.compact ? row.compact : row.full, change: row.change,
                            others: row.others, showChange: options.showChange, layout: layout, env: env
                        )
                        .modifier(RowRise(progress: progressValue, index: index, rise: env.pt(EnterMotion.rowRise)))
                    }
                }
                Spacer(minLength: 0)
                if let notice {
                    NoticeLine(text: notice, size: small, env: env, stale: data.status == .stale)
                } else if let footer {
                    FooterLine(text: footer, size: small, env: env)
                }
            }
        }
    }

    @Environment(\.enterProgress) private var progressValue

    /** A row's Δ: "+12 %" in `up`/`down` by `better`, "new", or "–". */
    private func change(_ row: TableRow, unit: String) -> (text: String, color: Color) {
        switch StudioLayout.tableChangeKind(value: row.value, previousValue: row.previousValue, ratio: row.ratio) {
        case .ratio:
            let delta = row.previousValue.map { row.value - $0 } ?? row.ratio ?? 0
            if let change = MetricFormat.change(delta: delta, ratio: row.ratio, unit: unit, language: env.language) {
                let tone = MetricFormat.tone(change.direction, better: data.better)
                return (change.text, env.colors.tone(tone))
            }
            return ("–", env.colors.muted)
        case .new:
            return (KitStrings.text(.tableNew, env.language), env.colors.muted)
        case .none:
            return ("–", env.colors.muted)
        }
    }
}

/** The column heads: 24 u caps, muted, tracked; value and Δ right-aligned over their columns. */
struct TableHeadRow: View {
    let label: String
    let value: String
    let showChange: Bool
    let layout: StudioLayout.TableLayout
    let env: WidgetEnv

    var body: some View {
        let size = layout.sizes.columnHead
        HStack(alignment: .firstTextBaseline, spacing: env.pt(layout.columns.gap)) {
            Text(label.uppercased())
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value.uppercased())
                .lineLimit(1)
                .fixedSize()
            if showChange {
                Text(verbatim: "Δ")
                    .frame(width: env.pt(layout.columns.change), alignment: .trailing)
            }
        }
        .font(env.font(size, .semibold))
        .tracking(env.pt(size * 0.06))
        .foregroundStyle(env.colors.muted)
        .accessibilityElement(children: .combine)
    }
}

/** One row: label (shrunk, then cut), value (tabular), Δ. */
struct TableRowView: View {
    let label: String
    let value: String
    let change: (text: String, color: Color)?
    let others: Bool
    let showChange: Bool
    let layout: StudioLayout.TableLayout
    let env: WidgetEnv

    var body: some View {
        let sizes = layout.sizes
        let fitted = StudioLayout.tableRowLabel(
            label, labelWidth: layout.columns.label, cell: sizes.cell, cellMin: sizes.cellMin)
        HStack(alignment: .firstTextBaseline, spacing: env.pt(layout.columns.gap)) {
            Text(label)
                .font(env.font(fitted.size))
                .foregroundStyle(others ? env.colors.muted : env.colors.label)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .font(env.font(sizes.cell, .semibold).monospacedDigit())
                .foregroundStyle(others ? env.colors.muted : env.colors.text)
                .lineLimit(1)
                .fixedSize()
            if showChange {
                Text(change?.text ?? "")
                    .font(env.font(sizes.cell, .semibold).monospacedDigit())
                    .foregroundStyle(change?.color ?? env.colors.muted)
                    .lineLimit(1)
                    .frame(width: env.pt(layout.columns.change), alignment: .trailing)
            }
        }
        .frame(height: env.pt(sizes.cell * 1.15))
        .padding(.top, env.pt(StudioLayout.TableSpacing.rowGap))
        .accessibilityElement(children: .combine)
    }
}

// MARK: Status board

/**
 * The status board (ADR 0019 section 7, design 4a "Sources"; web:
 * `StatusWidgetView`): one row per source with a health dot (`up`,
 * `warning`, `muted`, `down`, with a soft glow), the name (shrunk to 24 u,
 * then cut) and the age of its last successful sync (`warning` when stale),
 * attention first as sent; "+N more" when they do not fit, and the footer
 * "4 connected · 1 failing · 1 delayed". Rows rise on slide enter.
 */
struct StatusWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: StatusWidgetOptions
    let data: StatusWidgetData
    let env: WidgetEnv
    var now = Date()

    @Environment(\.enterProgress) private var progressValue

    var body: some View {
        let language = env.language
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .status, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let layout = StudioLayout.statusLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale, showAge: options.showAge)
        let rows = StatusBoard.rows(data.items, capacity: layout.rowCapacity)
        let rise = env.pt(EnterMotion.rowRise)

        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: labelLayout, env: env)
            if data.items.isEmpty {
                Text(KitStrings.text(.statusEmpty, language))
                    .font(env.font(layout.sizes.cell))
                    .foregroundStyle(env.colors.muted)
                    .padding(.top, env.pt(StudioLayout.StatusSpacing.rowGap))
            } else {
                ForEach(Array(rows.shown.enumerated()), id: \.offset) { index, item in
                    StatusRowView(
                        name: item.name, tone: StatusBoard.tone(item.status),
                        age: options.showAge ? StatusBoard.ageText(item.lastSuccessAt, now: now, language: language) : nil,
                        stale: item.status == .stale, layout: layout, env: env
                    )
                    .modifier(RowRise(progress: progressValue, index: index, rise: rise))
                }
                if rows.more > 0 {
                    StatusRowView(
                        name: KitStrings.text(.statusMore, language, rows.more), tone: rows.moreTone, age: nil,
                        stale: false, layout: layout, env: env, more: true
                    )
                    .modifier(RowRise(progress: progressValue, index: rows.shown.count, rise: rise))
                }
            }
            Spacer(minLength: 0)
            if !data.items.isEmpty {
                FooterLine(
                    text: StatusBoard.footer(
                        data.items, language: language, width: box.width, size: layout.sizes.footer),
                    size: layout.sizes.footer, env: env)
            }
        }
    }
}

/** One source: dot, name (shrunk, then cut) and age; or the "+N more" row without a dot. */
struct StatusRowView: View {
    let name: String
    let tone: StatusTone
    let age: String?
    let stale: Bool
    let layout: StudioLayout.StatusLayout
    let env: WidgetEnv
    var more = false

    private var color: Color {
        switch tone {
        case .up: return env.colors.up
        case .warning: return env.colors.warning
        case .down: return env.colors.down
        case .muted: return env.colors.muted
        }
    }

    var body: some View {
        let sizes = layout.sizes
        let fitted = StudioLayout.statusRowLabel(
            name, nameWidth: layout.columns.name, cell: sizes.cell, cellMin: sizes.cellMin)
        HStack(alignment: .center, spacing: env.pt(layout.columns.gap)) {
            Circle()
                .fill(color)
                .frame(width: env.pt(layout.columns.dot), height: env.pt(layout.columns.dot))
                .shadow(color: tone == .muted ? .clear : color.opacity(0.55), radius: env.pt(4))
                .opacity(more ? 0 : 1)
            Text(name)
                .font(env.font(fitted.size))
                .foregroundStyle(more ? (tone == .muted ? env.colors.muted : color) : env.colors.label)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let age {
                Text(age)
                    .font(env.font(sizes.age).monospacedDigit())
                    .foregroundStyle(stale ? env.colors.warning : env.colors.muted)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .frame(height: env.pt(sizes.cell * 1.15))
        .padding(.top, env.pt(StudioLayout.StatusSpacing.rowGap))
        .accessibilityElement(children: .combine)
    }
}

// MARK: Latest review (ADR 0019 section 12)

/**
 * The newest App Store review (design 4b): the label, the app icon and five
 * stars (filled in `warning`, empty in `border`), the title on one line and
 * the body in the lines `reviewLayout` gives it (data text: both end with
 * an ellipsis), the author line "Marta P. · Germany · 2 hr. ago" with the
 * age from this device's clock. One review, no rotation; the parts rise on
 * the slide enter like table rows.
 */
struct ReviewWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let data: ReviewWidgetData
    let icon: StoredImage?
    let env: WidgetEnv
    var now = Date()

    @Environment(\.enterProgress) private var progressValue

    var body: some View {
        let language = env.language
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .review, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let notice =
            data.status == .stale || data.status == .outage
            ? TileNotices.notice(status: data.status, updatedAt: data.updatedAt, language: language) : nil
        let review = data.review
        let layout = StudioLayout.reviewLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale, icon: icon != nil,
            title: review?.title, body: review?.body, notice: notice != nil)
        let small = layout.sizes.author

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .review, label: labelLayout, small: small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now,
                texts: ReviewText.surfaceTexts(surface, language: language))
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: labelLayout, env: env)
                if let review {
                    HStack(spacing: env.pt(StudioLayout.ReviewSpacing.iconGap)) {
                        if let icon {
                            DownsampledImage(
                                file: icon.url, image: icon.image, fit: .cover, align: .center,
                                box: CGSize(width: env.pt(layout.icon), height: env.pt(layout.icon)),
                                displayScale: env.displayScale
                            )
                            .frame(width: env.pt(layout.icon), height: env.pt(layout.icon))
                            .clipShape(RoundedRectangle(cornerRadius: env.pt(10)))
                            .accessibilityHidden(true)
                        }
                        ReviewStarsView(rating: review.rating, size: layout.sizes.stars, env: env)
                    }
                    .frame(height: env.pt(layout.starsRowHeight), alignment: .leading)
                    .padding(.bottom, env.pt(StudioLayout.ReviewSpacing.stack))
                    .modifier(RowRise(progress: progressValue, index: 0, rise: env.pt(EnterMotion.rowRise)))
                    if layout.showTitle, let title = review.title {
                        Text(title)
                            .font(env.font(layout.sizes.review, .semibold))
                            .foregroundStyle(env.colors.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(height: env.pt(layout.textLine), alignment: .leading)
                            .modifier(RowRise(progress: progressValue, index: 1, rise: env.pt(EnterMotion.rowRise)))
                    }
                    if layout.bodyLines > 0, let body = review.body {
                        Text(body)
                            .font(env.font(layout.sizes.review))
                            .foregroundStyle(env.colors.text)
                            .lineLimit(layout.bodyLines)
                            .truncationMode(.tail)
                            .lineSpacing(env.pt(layout.textLine - layout.sizes.review * 1.2))
                            .frame(
                                maxHeight: env.pt(layout.textLine * Double(layout.bodyLines)), alignment: .topLeading
                            )
                            .modifier(RowRise(progress: progressValue, index: 2, rise: env.pt(EnterMotion.rowRise)))
                    }
                    Spacer(minLength: 0)
                    Text(ReviewText.authorLine(review, now: now, language: language))
                        .font(env.font(small))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.top, env.pt(StudioLayout.ReviewSpacing.stack))
                        .modifier(RowRise(progress: progressValue, index: 3, rise: env.pt(EnterMotion.rowRise)))
                } else {
                    Text(verbatim: "—")
                        .font(env.font(layout.sizes.review))
                        .foregroundStyle(env.colors.muted)
                    Spacer(minLength: 0)
                }
                if let notice {
                    NoticeLine(text: notice, size: small, env: env, stale: data.status == .stale)
                        .padding(.top, env.pt(StudioLayout.ReviewSpacing.stack))
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/** Five stars, filled up to the rating in `warning`, the rest in `border`. */
struct ReviewStarsView: View {
    let rating: Int
    let size: Double
    let env: WidgetEnv

    var body: some View {
        let filled = StudioLayout.reviewStarsFilled(Double(rating))
        HStack(spacing: env.pt(StudioLayout.ReviewSpacing.starGap)) {
            ForEach(0..<StudioLayout.reviewStars, id: \.self) { index in
                Text(verbatim: "★")
                    .foregroundStyle(index < filled ? env.colors.warning : env.colors.border)
            }
        }
        .font(env.font(size))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(KitStrings.text(.reviewStars, env.language, filled))
    }
}

/** A row rising 14 u and fading in during the enter, `index` × 90 ms after the first (animatable). */
struct RowRise: ViewModifier, Animatable {
    var progress: Double
    let index: Int
    let rise: CGFloat

    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let p = EnterMotion.rowProgress(index, eased: progress)
        content
            .offset(y: rise * CGFloat(1 - p))
            .opacity(p)
    }
}

// MARK: Compare

/**
 * The compare widget (ADR 0019 section 10, design 4b): the label, the
 * period line, the two operands side by side with "/" between them and
 * their captions, the ratio in the chart colour with its label and change,
 * and the footer "derived · updated …". The layout is StudioLayout's
 * compareLayout (shared vectors with the web); operands and ratio count up
 * on slide enter. A zero or missing denominator shows "–".
 */
struct CompareWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: CompareWidgetOptions
    let data: CompareWidgetData
    let env: WidgetEnv
    var now = Date()

    var body: some View {
        let language = env.language
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .compare, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let numerator = CompareText.operand(data.numerator, language: language)
        let denominator = CompareText.operand(data.denominator, language: language)
        let ratioText = CompareText.ratio(
            data.ratio.value, format: data.ratio.format, unit: data.unit, language: language)
        let ratioLabel = CompareText.ratioLabel(options, language: language)
        let change =
            options.showChange
            ? StudioLayout.compareChange(
                value: data.ratio.value, previousValue: data.ratio.previousValue, format: data.ratio.format)
            : nil
        let changeText = change.map { CompareText.change($0, language: language) }
        let layout = StudioLayout.compareLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale, numerator: numerator,
            denominator: denominator, ratio: ratioText, ratioLabel: ratioLabel, change: changeText)
        let notice = dataNotice(
            status: data.status, updatedAt: data.updatedAt,
            unit: data.numerator.unit == nil || data.denominator.unit == nil ? nil : "count", language: language)
        let footer =
            notice != nil || !layout.showFooter
            ? nil
            : WidgetFooter.line(
                CompareText.footerCandidates(updatedAt: data.updatedAt, now: now, language: language),
                type: .compare, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox)
        let small = layout.sizes.small
        let stale = data.status == .stale
        let tone = change.map {
            MetricFormat.tone(MetricFormat.Direction(rawValue: $0.direction.rawValue) ?? .flat, better: data.better)
        }

        if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .compare, label: labelLayout, small: small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: labelLayout, env: env)
                if layout.showPeriod {
                    Text(MetricFormat.periodLabel(data.period, language: language))
                        .font(env.font(small))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                HStack(alignment: .top, spacing: env.pt(StudioLayout.CompareSpacing.operandGap)) {
                    operandView(data.numerator, text: numerator, layout: layout, stale: stale)
                    Text(verbatim: StudioLayout.compareSeparator)
                        .font(env.font(layout.sizes.operand))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                        .fixedSize()
                    operandView(data.denominator, text: denominator, layout: layout, stale: stale)
                }
                .padding(.top, env.pt(StudioLayout.CompareSpacing.stack))
                ratioRow(
                    text: ratioText, label: ratioLabel, change: changeText, tone: tone, layout: layout, stale: stale
                )
                .padding(.top, env.pt(StudioLayout.CompareSpacing.stack))
                if let notice {
                    NoticeLine(text: notice, size: small, env: env, stale: stale)
                        .padding(.top, env.pt(StudioLayout.CompareSpacing.stack))
                } else if let footer {
                    FooterLine(text: footer, size: small, env: env)
                        .padding(.top, env.pt(StudioLayout.CompareSpacing.stack))
                }
            }
        }
    }

    /** One operand: the number (counting up) over its caption. */
    private func operandView(
        _ operand: CompareOperand, text: StudioLayout.TableValueText, layout: StudioLayout.CompareLayout, stale: Bool
    ) -> some View {
        let shown = layout.compact ? text.compact : text.full
        return VStack(alignment: .leading, spacing: 0) {
            CountingValue(
                final: shown, target: operand.value,
                format: countFormat(
                    shown: shown, full: text.full, compact: text.compact, value: operand.value, unit: operand.unit,
                    approximate: false, language: env.language)
            )
            .font(env.font(layout.sizes.operand, .semibold).monospacedDigit())
            .foregroundStyle(operand.value == nil || stale ? env.colors.muted : env.colors.text)
            .lineLimit(1)
            .fixedSize()
            Text(operand.label)
                .font(env.font(layout.sizes.caption))
                .foregroundStyle(env.colors.muted)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: env.pt(layout.captionWidth), alignment: .leading)
        }
    }

    /** The ratio in the chart colour, with its label and change beside or below it. */
    @ViewBuilder
    private func ratioRow(
        text: String, label: String, change: String?, tone: MetricFormat.Direction?,
        layout: StudioLayout.CompareLayout, stale: Bool
    ) -> some View {
        let ratio = CountingValue(
            final: text, target: data.ratio.value,
            format: data.ratio.value == nil
                ? nil
                : { [format = data.ratio.format, unit = data.unit, language = env.language] in
                    CompareText.ratio($0, format: format, unit: unit, language: language)
                }
        )
        .font(env.font(layout.sizes.ratio, .semibold).monospacedDigit())
        .tracking(-0.01 * env.pt(layout.sizes.ratio))
        .foregroundStyle(data.ratio.value == nil || stale ? env.colors.muted : env.colors.chartLine)
        .lineLimit(1)
        .fixedSize()
        let caption = HStack(alignment: .firstTextBaseline, spacing: env.pt(StudioLayout.CompareSpacing.ratioGap)) {
            Text(label)
                .foregroundStyle(env.colors.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let change {
                Text(change)
                    .foregroundStyle(stale || tone == nil ? env.colors.muted : env.colors.tone(tone!))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .font(env.font(layout.sizes.change))
        if layout.ratioLine == .beside {
            HStack(alignment: .firstTextBaseline, spacing: env.pt(StudioLayout.CompareSpacing.ratioGap)) {
                ratio
                caption
            }
        } else {
            VStack(alignment: .leading, spacing: env.pt(StudioLayout.CompareSpacing.stack)) {
                ratio
                caption
            }
        }
    }
}

// MARK: Goal (gauge)

/**
 * The goal widget (ADR 0019 section 5; web: `GaugeWidgetView`): the label,
 * the target line ("Goal 15,000"), a full ring from 12 o'clock (track
 * `border`, fill `chartLine`, round caps) with the value inside, the
 * progress line ("2,520 to go · 9 days left") and the footer, as
 * `StudioLayout.gaugeLayout` places them; the ring sits right of the text
 * from a 1.6:1 content box. In progress the value is the percent rounded
 * down; once reached it is the value itself, ring and value in `up` on a
 * surface tinted towards `up` ("✓ Reached · 122 % · 2 days early").
 * Stale data never shows the reached colours. A deleted goal shows "Goal
 * deleted". On slide enter the arc draws and the value counts up; the
 * round caps appear when the draw is done.
 */
struct GaugeWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: GaugeWidgetOptions
    let data: GaugeWidgetData
    let env: WidgetEnv
    var now = Date()

    @Environment(\.enterProgress) private var progressValue

    /** The surface: reached (fresh data only), else the data status's; a deleted goal is empty. */
    static func surfaceState(_ data: GaugeWidgetData) -> SurfaceState {
        if data.goal == nil { return .empty }
        if data.status != .stale && DataSurface(data.status) == nil && Goals.reached(data.progress) {
            return .reached
        }
        return SurfaceState(data.status)
    }

    /** The text inside the ring, full and compact, and its suffix ("%" while in progress). */
    static func ringTexts(
        reached: Bool, value: Double?, percent: Int?, unit: String, approx: String, language: ScreenLanguage
    ) -> (String, String, String?) {
        if reached, let value {
            return (
                approx + MetricFormat.value(value, unit: unit, language: language),
                approx + MetricFormat.compactValue(value, unit: unit, language: language), nil
            )
        }
        if let percent { return ("\(percent)", "\(percent)", "%") }
        return ("—", "—", nil)
    }

    /** "122 %": the percent with a no-break space. */
    static func percentText(_ percent: Int) -> String { "\(percent)\u{00A0}%" }

    var body: some View {
        let language = env.language
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let stale = data.status == .stale
        let reachedGoal = Goals.reached(data.progress)
        let reachedColors = reachedGoal && !stale
        let percent = Goals.percent(data.progress)
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .gauge, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let small = sizes[.any] ?? StudioLayout.Minimum.any

        // Inside the ring: the percent's digits (and "%"), or the value once reached.
        let (full, compact, suffix) = Self.ringTexts(
            reached: reachedGoal, value: data.value, percent: percent, unit: unit, approx: approx, language: language)
        let timeText = data.periodEnd.flatMap {
            Goals.timeText(
                period: data.period?.rawValue ?? "", periodEnd: $0, reachedAt: data.reachedAt,
                progress: data.progress, now: now, timeZone: env.timeZone)
        }
        let time = options.showTimeLeft ? timeText.map { Goals.words($0, language: language) } : nil
        let progressLine: String = {
            guard let value = data.value, let target = data.target else {
                return KitStrings.text(data.unit == nil ? .couldNotLoad : .noDataYet, language)
            }
            if reachedGoal {
                return ([KitStrings.text(.goalReached, language), Self.percentText(percent ?? 100)] + (time.map { [$0] } ?? []))
                    .joined(separator: " · ")
            }
            let toGo = KitStrings.text(
                .goalToGo, language, approx + MetricFormat.value(Swift.max(0, target - value), unit: unit, language: language))
            return ([toGo] + (time.map { [$0] } ?? [])).joined(separator: " · ")
        }()
        let layout = StudioLayout.gaugeLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale,
            value: StudioLayout.TableValueText(full: full, compact: compact), suffix: suffix, progress: progressLine)
        let labelLayout = StudioRender.labelLayout(label, width: layout.textWidth, sizes: sizes)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit, language: language)
        let footer =
            notice != nil || !layout.showFooter
            ? nil
            : WidgetFooter.line(
                WidgetFooter.candidates(updatedAt: data.updatedAt, source: nil, now: now, language: language),
                type: .gauge, placement: placement.cells, showHeader: env.showHeader, fontScale: env.fontScale,
                unitBox: placement.unitBox)
        let shown = layout.compact ? compact : full

        if data.goal == nil {
            GoalDeletedView(label: labelLayout, small: small, env: env)
        } else if let surface = DataSurface(data.status) {
            DataStateView(
                surface: surface, type: .gauge, label: labelLayout, small: small, updatedAt: data.updatedAt,
                placement: placement, env: env, now: now)
        } else {
            let accent = reachedColors ? env.colors.up : env.colors.text
            let ring = GoalRing(
                fraction: Swift.min(Swift.max(data.progress ?? 0, 0), 1),
                diameter: env.pt(layout.ringDiameter), stroke: env.pt(layout.ringStroke),
                fill: stale ? env.colors.muted : (reachedColors ? env.colors.up : env.colors.chartLine),
                track: env.colors.border
            )
            .overlay {
                HStack(alignment: .firstTextBaseline, spacing: env.pt(layout.sizes.suffix * StudioLayout.GaugeSpacing.suffixGap)) {
                    CountingValue(
                        final: shown, target: suffix != nil ? percent.map(Double.init) : data.value,
                        format: suffix != nil
                            ? { "\(Int($0.rounded(.down)))" }
                            : countFormat(
                                shown: shown, full: full, compact: compact, value: data.value, unit: data.unit,
                                approximate: data.conversion != nil, language: language)
                    )
                    .font(env.font(layout.sizes.value, .semibold).monospacedDigit())
                    if let suffix {
                        Text(suffix).font(env.font(layout.sizes.suffix, .semibold))
                    }
                }
                .foregroundStyle(stale ? env.colors.muted : accent)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            }
            let text = VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    LabelLine(fitted: labelLayout.title, env: env)
                    if let resource = labelLayout.resource {
                        LabelLine(fitted: resource, env: env)
                    }
                }
                if layout.showTarget, let target = data.target {
                    Text(KitStrings.text(.goalTarget, language, approx + MetricFormat.value(target, unit: unit, language: language)))
                        .font(env.font(layout.sizes.target, .semibold))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.top, env.pt(StudioLayout.GaugeSpacing.stack))
                }
            }
            let progress = Group {
                if let notice, footer == nil, !layout.showFooter {
                    NoticeLine(text: notice, size: small, env: env, stale: stale)
                } else {
                    Text(progressLine)
                        .font(env.font(layout.sizes.progress, reachedColors ? .medium : .regular))
                        .foregroundStyle(reachedColors ? env.colors.up : env.colors.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            let bottom = Group {
                if let notice, layout.showFooter {
                    NoticeLine(text: notice, size: small, env: env, stale: stale)
                } else if let footer {
                    FooterLine(text: footer, size: small, env: env)
                }
            }
            if layout.orientation == .side {
                HStack(alignment: .center, spacing: env.pt(StudioLayout.GaugeSpacing.side)) {
                    VStack(alignment: .leading, spacing: 0) {
                        text
                        Spacer(minLength: env.pt(StudioLayout.GaugeSpacing.stack))
                        progress
                        bottom.padding(.top, env.pt(StudioLayout.GaugeSpacing.stack))
                    }
                    .frame(width: env.pt(layout.textWidth), alignment: .leading)
                    ring
                }
                .accessibilityElement(children: .combine)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    text
                    Spacer(minLength: env.pt(StudioLayout.GaugeSpacing.stack))
                    ring.frame(maxWidth: .infinity)
                    Spacer(minLength: env.pt(StudioLayout.GaugeSpacing.stack))
                    progress
                    if layout.showFooter {
                        bottom.padding(.top, env.pt(StudioLayout.GaugeSpacing.stack))
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/**
 * A full ring from 12 o'clock: the track, and the fill drawn to `fraction`
 * while the slide enters (butt ends while it draws, round caps once done).
 */
struct GoalRing: View {
    let fraction: Double
    let diameter: CGFloat
    let stroke: CGFloat
    let fill: Color
    let track: Color

    @Environment(\.enterProgress) private var progress

    var body: some View {
        let inset = stroke / 2
        ZStack {
            Circle()
                .inset(by: inset)
                .stroke(track, lineWidth: stroke)
            Circle()
                .inset(by: inset)
                .trim(from: 0, to: fraction * progress)
                .stroke(fill, style: StrokeStyle(lineWidth: stroke, lineCap: .butt))
                .rotationEffect(.degrees(-90))
            if fraction > 0 {
                Circle()
                    .inset(by: inset)
                    .trim(from: 0, to: fraction)
                    .stroke(fill, style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .modifier(AppearAtEnd(progress: progress))
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}

/** A goal widget whose goal was deleted: its label and "Goal deleted" (muted, dashed border). */
struct GoalDeletedView: View {
    let label: StudioRender.LabelLayout
    let small: Double
    let env: WidgetEnv

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: label, env: env)
            Spacer(minLength: 0)
            Text(KitStrings.text(.goalDeleted, env.language))
                .font(env.font(DataSurface.reconnectSize(small: small), .semibold))
                .foregroundStyle(env.colors.muted)
                .lineLimit(2)
            Text(KitStrings.text(.goalDeletedHint, env.language))
                .font(env.font(small))
                .foregroundStyle(env.colors.muted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, env.pt(6))
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Image

/**
 * An uploaded image or app icon keeping its aspect ratio, decoded with
 * ImageIO at the widget's pixel size (a 4096 px upload never decodes at
 * full size on the TV).
 */
struct ImageWidgetView: View {
    let stored: StoredImage?
    let options: ImageWidgetOptions
    let label: String?
    let env: WidgetEnv

    var body: some View {
        GeometryReader { box in
            if let stored {
                DownsampledImage(
                    file: stored.url, image: stored.image, fit: options.fit, align: options.align, box: box.size,
                    displayScale: env.displayScale
                )
                .frame(width: box.size.width, height: box.size.height)
                .clipShape(RoundedRectangle(cornerRadius: options.fit == .cover ? env.pt(12) : 0))
                .accessibilityLabel(label ?? "")
            } else {
                // Not downloaded yet (or gone): a quiet placeholder, never a broken picture.
                RoundedRectangle(cornerRadius: env.pt(12))
                    .strokeBorder(env.colors.border, style: StrokeStyle(lineWidth: max(1, env.pt(1.5)), dash: [env.pt(8)]))
            }
        }
    }
}

/** Decoded images by file and pixel size, so a slide change does not decode again. */
@MainActor
enum DecodedImages {
    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 128 * 1024 * 1024
        return cache
    }()
}

struct DownsampledImage: View {
    let file: URL
    let image: DeviceImage
    let fit: ImageFit
    let align: WidgetAlign
    let box: CGSize
    let displayScale: CGFloat

    @State private var decoded: UIImage?

    /** The longest side in pixels that fills (cover) or fits (contain) the box. */
    private var maxPixelSize: Int {
        let width = max(Double(image.width), 1)
        let height = max(Double(image.height), 1)
        let sx = Double(box.width) / width
        let sy = Double(box.height) / height
        let scale = fit == .cover ? max(sx, sy) : min(sx, sy)
        let pixels = max(width, height) * scale * Double(displayScale)
        return max(1, min(Int(pixels.rounded(.up)), Int(max(width, height))))
    }

    private var key: String { "\(file.lastPathComponent)@\(maxPixelSize)" }

    var body: some View {
        let alignment: Alignment = align == .start ? .leading : align == .end ? .trailing : .center
        ZStack(alignment: alignment) {
            if let decoded {
                Image(uiImage: decoded)
                    .resizable()
                    .aspectRatio(contentMode: fit == .cover ? .fill : .fit)
            }
        }
        .frame(width: box.width, height: box.height, alignment: alignment)
        .clipped()
        .task(id: key) {
            if let hit = DecodedImages.cache.object(forKey: key as NSString) {
                decoded = hit
                return
            }
            let url = file
            let size = maxPixelSize
            let result = await Task.detached(priority: .userInitiated) { Self.decode(url, maxPixelSize: size) }.value
            if let result {
                DecodedImages.cache.setObject(result, forKey: key as NSString, cost: Int(result.size.width * result.size.height * 4))
            }
            decoded = result
        }
    }

    nonisolated static func decode(_ url: URL, maxPixelSize: Int) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else { return nil }
        let options =
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: thumbnail)
    }
}

// MARK: Text

/**
 * Markdown-lite (paragraphs, line breaks, # and ## headings, **bold**,
 * *italic*) from StudioLayout.parseText: text only, HTML stays literal.
 */
struct TextWidgetView: View {
    let text: String
    let options: TextWidgetOptions
    let placement: ScreenPlacement
    let env: WidgetEnv

    var body: some View {
        let layout = StudioRender.textLayout(
            text, size: options.size, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader,
            format: placement.format)
        let horizontal: HorizontalAlignment = options.align == .center ? .center : options.align == .end ? .trailing : .leading
        let textAlign: TextAlignment = options.align == .center ? .center : options.align == .end ? .trailing : .leading
        let frameAlign: Alignment = options.align == .center ? .top : options.align == .end ? .topTrailing : .topLeading
        VStack(alignment: horizontal, spacing: env.pt(layout.paragraph * 0.5)) {
            ForEach(Array(layout.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let spans):
                    Text(attributed([spans], size: level == 1 ? layout.heading1 : layout.heading2, weight: .bold))
                case .paragraph(let lines):
                    Text(attributed(lines, size: layout.paragraph, weight: .regular))
                }
            }
        }
        .foregroundStyle(env.colors.text)
        .multilineTextAlignment(textAlign)
        .padding(env.pt(StudioLayout.widgetPadding))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlign)
        .clipped()
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

// MARK: Clock

/**
 * The time in the accent colour, the date and the zone line, centred as on
 * the web; lines that do not fit are left out (StudioLayout.clockLayout).
 */
/**
 * The countdown widget (ADR 0019 section 8; web: `CountdownWidgetView`):
 * the label, the time left as numbers with unit letters a third of their
 * size, as large as fits, and the target line at the bottom. At and after
 * `targetAt` the text when reached at heading size in the accent colour.
 * It ticks each minute from the Apple TV's clock; no data states, and no
 * motion beyond the slide's fade.
 */
struct CountdownWidgetView: View {
    let label: String
    let options: CountdownWidgetOptions
    let placement: ScreenPlacement
    let env: WidgetEnv

    var body: some View {
        TimelineView(.everyMinute) { context in
            let view = StudioRender.countdownView(
                now: context.date, label: label, options: options, timeZone: options.timeZone ?? env.timeZone,
                placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader,
                unitBox: placement.unitBox, language: env.language)
            let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
            let sizes = StudioLayout.typeScale(
                .countdown, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
            let layout = view.layout
            VStack(alignment: .leading, spacing: 0) {
                WidgetLabelView(layout: StudioRender.labelLayout(label, width: box.width, sizes: sizes), env: env)
                if let doneText = view.doneText {
                    Text(doneText)
                        .font(env.font(layout.done, .semibold))
                        .foregroundStyle(env.colors.accent)
                        .lineLimit(max(1, layout.doneLines))
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        ForEach(Array(view.groups.enumerated()), id: \.offset) { index, group in
                            HStack(alignment: .firstTextBaseline, spacing: env.pt(layout.unitGap)) {
                                Text(group.value)
                                    .font(env.font(layout.value, .semibold).monospacedDigit())
                                    .foregroundStyle(env.colors.text)
                                Text(group.unit)
                                    .font(env.font(layout.unit, .medium))
                                    .foregroundStyle(env.colors.muted)
                            }
                            .padding(.leading, index > 0 ? env.pt(layout.groupGap) : 0)
                        }
                    }
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(view.text)
                }
                Spacer(minLength: 0)
                if layout.showTarget, let target = view.target {
                    Text(target)
                        .font(env.font(layout.target))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

struct ClockWidgetView: View {
    let options: ClockWidgetOptions
    let placement: ScreenPlacement
    let env: WidgetEnv

    var body: some View {
        TimelineView(.everyMinute) { context in
            let zone = options.timeZone ?? env.timeZone
            let text = TVTime.clockWidget(
                context.date, timeZone: zone, hour12: options.hour12, showDate: options.showDate,
                dateStyle: options.dateStyle, showZone: options.showZone, language: env.language)
            let layout = StudioRender.clockLayout(
                time: text.time, options: options, timeZone: zone, placement: placement.cells,
                fontScale: env.fontScale, showHeader: env.showHeader, unitBox: placement.unitBox)
            VStack(alignment: .center, spacing: 0) {
                Text(text.time)
                    .font(env.font(layout.time, .semibold).monospacedDigit())
                    .foregroundStyle(env.colors.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let date = text.date, let size = layout.date {
                    Text(date)
                        .font(env.font(size))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if let line = text.zone, let size = layout.zone {
                    Text(line)
                        .font(env.font(size))
                        .foregroundStyle(env.colors.muted)
                        .lineLimit(1)
                }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}
