import Charts
import ImageIO
import NetricsKit
import SwiftUI

// The schema 2 widget renderers (ADR 0015, sections 2 and 8), the
// counterparts of apps/web/src/components/studio. Sizes come from
// StudioRender in canvas units, colours from the theme tokens. Titles and
// resource names wrap to two lines and shrink to the minimum before the
// last-resort ellipsis; values switch to the compact form, never cut.

struct WidgetView: View {
    let widget: DeviceWidget
    let env: WidgetEnv
    let image: StoredImage?

    var body: some View {
        switch widget.content {
        case .metric(let options, let data):
            MetricWidgetView(label: widget.label ?? "", placement: widget.placement, options: options, data: data, env: env)
                .surface(env)
        case .line(let options, let data):
            LineWidgetView(label: widget.label ?? "", placement: widget.placement, options: options, data: data, env: env)
                .surface(env)
        case .bar(_, let data):
            BarWidgetView(label: widget.label ?? "", placement: widget.placement, data: data, env: env)
                .surface(env)
        case .image(_, let options):
            ImageWidgetView(stored: image, options: options, label: widget.label, env: env)
        case .text(let text, let options):
            TextWidgetView(text: text, options: options, placement: widget.placement, env: env)
        case .clock(let options):
            ClockWidgetView(options: options, placement: widget.placement, env: env)
                .surface(env)
        case .unsupported:
            // A type this build does not know (a newer server), or one it
            // cannot read: its cell stays, empty and themed.
            Color.clear.surface(env)
        }
    }
}

extension View {
    /** The widget box: padding, surface, border (web: .sw). */
    func surface(_ env: WidgetEnv, padded: Bool = true) -> some View {
        let radius = env.pt(12)
        return self
            .padding(padded ? env.pt(StudioLayout.widgetPadding) : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(env.colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(env.colors.border, lineWidth: max(1, env.pt(1.5))))
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

/** A stale or failure notice in the theme's warning colour (as on tiles). */
struct NoticeLine: View {
    let text: String
    let size: Double
    let env: WidgetEnv

    var body: some View {
        Text("⚠ \(text)")
            .font(env.font(size))
            .foregroundStyle(env.colors.warning)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/** A data widget's notice: its connection's state, or that it could not load. */
func dataNotice(status: DeviceTileStatus, updatedAt: String?, unit: String?) -> String? {
    if let notice = TileNotices.notice(status: status, updatedAt: updatedAt) {
        return notice
    }
    return unit == nil ? "Could not load" : nil
}

// MARK: Metric

struct MetricWidgetView: View {
    let label: String
    let placement: StudioPlacement
    let options: MetricWidgetOptions
    let data: MetricWidgetData
    let env: WidgetEnv

    var body: some View {
        let tile = data.tile(id: "", label: label)
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil && data.value != nil ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit)
        let compact = data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit)
        let change = MetricFormat.change(delta: data.change.delta, ratio: data.change.ratio, unit: unit)
        let comparison = MetricFormat.comparisonLabel(data.period)
        let changeLine: (full: String, short: String, comparison: String?)? =
            !options.showChange || data.unit == nil
            ? nil
            : change.map {
                ("\($0.direction.arrow) \($0.text) \(comparison)", "\($0.direction.arrow) \($0.text)", comparison)
            }
                ?? (data.value == nil
                    ? ("No data for this period yet", "No data yet", nil)
                    : ("No data to compare \(comparison)", "No comparison", nil))
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit)
        let note = ConversionFormat.note(data.conversion)
        let layout = StudioRender.metricLayout(
            label: label, value: (full, compact), periodText: MetricFormat.subtitle(tile), change: changeLine,
            notice: notice, note: note, placement: placement, showHeader: env.showHeader, fontScale: env.fontScale,
            showSparkline: options.showSparkline && Sparkline.isDrawable(data.spark))
        let tone = change.map { MetricFormat.tone($0.direction, better: data.better) } ?? .flat

        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: layout.label, env: env)
            if layout.showPeriod {
                Text(MetricFormat.subtitle(tile))
                    .font(env.font(layout.small))
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(layout.value.text)
                .font(env.font(layout.value.size, .semibold).monospacedDigit())
                .foregroundStyle(data.unit == nil ? env.colors.muted : env.colors.text)
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
            if layout.sparkline > 0 {
                SparklineChart(spark: data.spark, colors: env.colors, lineWidth: max(3, env.pt(4)))
                    .frame(maxHeight: .infinity)
                    .padding(.top, env.pt(StudioRender.stackGap))
            } else {
                Spacer(minLength: 0)
            }
            if layout.showNote, let note {
                Text(note)
                    .font(env.font(layout.small))
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            if let notice {
                NoticeLine(text: notice, size: layout.small, env: env)
            }
        }
    }
}

/** The metric widget's sparkline: one point per bucket, gaps for null. */
struct SparklineChart: View {
    let spark: [Double?]
    let colors: StudioColors
    let lineWidth: CGFloat

    var body: some View {
        let segments = Sparkline.segments(spark)
        let values = segments.flatMap { $0.map(\.value) }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let pad = high > low ? (high - low) * 0.08 : max(abs(high) * 0.1, 1)
        let last = segments.last?.last
        Chart {
            ForEach(Array(segments.enumerated()), id: \.offset) { segment, points in
                ForEach(points, id: \.index) { point in
                    LineMark(
                        x: .value("Bucket", point.index), y: .value("Value", point.value),
                        series: .value("Segment", segment)
                    )
                    .foregroundStyle(colors.chartLine)
                    .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                }
                if points.count == 1, let point = points.first {
                    PointMark(x: .value("Bucket", point.index), y: .value("Value", point.value))
                        .foregroundStyle(colors.chartLine)
                        .symbolSize(lineWidth * lineWidth * 2)
                }
            }
            if let last {
                PointMark(x: .value("Bucket", last.index), y: .value("Value", last.value))
                    .foregroundStyle(colors.accent)
                    .symbolSize(lineWidth * lineWidth * 6)
            }
        }
        .chartXScale(domain: 0...max(spark.count - 1, 1))
        .chartYScale(domain: (low - pad)...(high + pad))
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }
}

// MARK: Line

struct LineWidgetView: View {
    let label: String
    let placement: StudioPlacement
    let options: LineWidgetOptions
    let data: LineWidgetData
    let env: WidgetEnv

    var body: some View {
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil && data.value != nil ? "≈ " : ""
        let full = data.unit == nil ? "—" : approx + MetricFormat.value(data.value, unit: unit)
        let compact = data.unit == nil ? "—" : approx + MetricFormat.compactValue(data.value, unit: unit)
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit)
        let layout = StudioRender.chartLayout(
            type: .line, label: label, value: (full, compact), notice: notice, placement: placement,
            showHeader: env.showHeader, fontScale: env.fontScale)
        let previous = options.showPrevious ? Array(data.previous.prefix(data.values.count)) : []
        let domain = StudioRender.lineDomain(values: data.values, previous: previous)

        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: layout.label, env: env)
            if let value = layout.value {
                Text(value.text)
                    .font(env.font(value.size, .semibold).monospacedDigit())
                    .foregroundStyle(data.unit == nil ? env.colors.muted : env.colors.text)
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
                Text(data.unit == nil ? "" : "No data for this period yet")
                    .font(env.font(layout.small))
                    .foregroundStyle(env.colors.muted)
                Spacer(minLength: 0)
            }
            if let notice {
                NoticeLine(text: notice, size: layout.small, env: env)
            }
        }
    }
}

/**
 * The period's points with the previous period dashed behind them, on one
 * value axis from zero; the area under the current line in the fill
 * colour, the latest point in the accent. Axis labels (top and bottom value,
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

    var body: some View {
        let colors = env.colors
        let current = Sparkline.segments(data.values)
        let earlier = Sparkline.segments(previous)
        let count = data.values.count
        let last = current.last?.last
        let lineWidth = max(3, env.pt(4))
        let chart = Chart {
            ForEach(Array(earlier.enumerated()), id: \.offset) { segment, points in
                ForEach(points, id: \.index) { point in
                    LineMark(
                        x: .value("Bucket", point.index), y: .value("Value", point.value),
                        series: .value("Series", "previous-\(segment)")
                    )
                    .foregroundStyle(colors.muted)
                    .lineStyle(StrokeStyle(lineWidth: lineWidth * 0.75, lineCap: .round, dash: [lineWidth * 2, lineWidth * 2]))
                }
            }
            ForEach(Array(current.enumerated()), id: \.offset) { segment, points in
                ForEach(points, id: \.index) { point in
                    AreaMark(
                        x: .value("Bucket", point.index), yStart: .value("Base", max(domain.lowerBound, 0)),
                        yEnd: .value("Value", point.value), series: .value("Series", "area-\(segment)")
                    )
                    .foregroundStyle(colors.chartFill.opacity(0.25))
                    LineMark(
                        x: .value("Bucket", point.index), y: .value("Value", point.value),
                        series: .value("Series", "current-\(segment)")
                    )
                    .foregroundStyle(colors.chartFill)
                    .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                }
            }
            if let last {
                PointMark(x: .value("Bucket", last.index), y: .value("Value", last.value))
                    .foregroundStyle(colors.accent)
                    .symbolSize(lineWidth * lineWidth * 6)
            }
        }
        .chartXScale(domain: 0...max(count - 1, 1))
        .chartYScale(domain: domain)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)

        if showAxis {
            let font = env.font(axisSize).monospacedDigit()
            VStack(spacing: env.pt(8)) {
                HStack(alignment: .top, spacing: env.pt(12)) {
                    VStack(alignment: .trailing) {
                        Text(MetricFormat.compactValue(domain.upperBound, unit: unit))
                        Spacer(minLength: 0)
                        Text(MetricFormat.compactValue(domain.lowerBound, unit: unit))
                    }
                    .font(font)
                    .foregroundStyle(colors.muted)
                    .fixedSize(horizontal: true, vertical: false)
                    chart
                }
                HStack {
                    Text(data.buckets.first.flatMap { MetricFormat.bucketLabel($0, period: data.period, timeZone: timeZone) } ?? "")
                    Spacer(minLength: env.pt(12))
                    if data.buckets.count > 1 {
                        Text(data.buckets.last.flatMap { MetricFormat.bucketLabel($0, period: data.period, timeZone: timeZone) } ?? "")
                    }
                }
                .font(env.font(axisSize))
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
    let placement: StudioPlacement
    let data: BarWidgetData
    let env: WidgetEnv

    var body: some View {
        let unit = data.unit ?? "count"
        let approx = data.conversion != nil ? "≈ " : ""
        let notice = dataNotice(status: data.status, updatedAt: data.updatedAt, unit: data.unit)
        let layout = StudioRender.chartLayout(
            type: .bar, label: label, value: nil, notice: notice, placement: placement, showHeader: env.showHeader,
            fontScale: env.fontScale)
        let bars = StudioRender.barLayout(
            bars: data.bars, others: data.others, width: layout.chartWidth, height: layout.chartHeight,
            size: layout.resource, format: { approx + MetricFormat.value($0, unit: unit) })

        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: layout.label, env: env)
            if bars.rows.isEmpty {
                Text(data.unit == nil ? "—" : "No data for this period yet")
                    .font(env.font(layout.small))
                    .foregroundStyle(env.colors.muted)
                Spacer(minLength: 0)
            } else {
                let largest = bars.rows.map(\.value).reduce(0, max)
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
                                    .foregroundStyle(env.colors.text)
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                            BarChartRow(value: row.value, largest: largest, others: row.others, colors: env.colors)
                                .frame(height: env.pt(bars.barHeight))
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            if let notice {
                NoticeLine(text: notice, size: layout.small, env: env)
            }
        }
    }
}

/** One bar on a shared scale (Swift Charts), "Others" in the muted colour. */
struct BarChartRow: View {
    let value: Double
    let largest: Double
    let others: Bool
    let colors: StudioColors

    var body: some View {
        Chart {
            BarMark(xStart: .value("Start", 0), xEnd: .value("Value", max(0, value)), y: .value("Row", 0))
                .foregroundStyle(others ? colors.muted : colors.chartFill)
                .clipShape(Capsule())
        }
        .chartXScale(domain: 0...max(largest, 1))
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartPlotStyle { plot in
            plot.background(colors.border.opacity(0.6)).clipShape(Capsule())
        }
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
    let placement: StudioPlacement
    let env: WidgetEnv

    var body: some View {
        let layout = StudioRender.textLayout(
            text, size: options.size, placement: placement, fontScale: env.fontScale, showHeader: env.showHeader)
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

struct ClockWidgetView: View {
    let options: ClockWidgetOptions
    let placement: StudioPlacement
    let env: WidgetEnv

    var body: some View {
        TimelineView(.everyMinute) { context in
            let zone = options.timeZone ?? env.timeZone
            let text = TVTime.clockWidget(context.date, timeZone: zone, hour12: options.hour12, showDate: options.showDate)
            let sizes = StudioRender.clockSize(
                time: text.time, hasDate: text.date != nil, placement: placement, fontScale: env.fontScale,
                showHeader: env.showHeader)
            VStack(alignment: .leading, spacing: 0) {
                Text(text.time)
                    .font(env.font(sizes.time, .semibold).monospacedDigit())
                    .foregroundStyle(env.colors.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let date = text.date {
                    Text(date)
                        .font(env.font(sizes.date))
                        .foregroundStyle(env.colors.label)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}
