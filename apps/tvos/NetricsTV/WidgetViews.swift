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
        case .image(_, let options):
            ImageWidgetView(stored: image, options: options, label: widget.label, env: env)
        case .text(let text, let options):
            TextWidgetView(text: text, options: options, placement: placement, env: env)
        case .clock(let options):
            ClockWidgetView(options: options, placement: placement, env: env)
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

    var body: some View {
        // Screens carry no source name: "Reconnect the source".
        let texts = surface.texts(source: nil, language: env.language)
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
