import Charts
import NetricsKit
import SwiftUI

/**
 * The full-screen TV layout (web: TvFrame + TileView variant "tv"): name
 * and clock on top, every tile on one screen below.
 */
struct DashboardView: View {
    let state: DeviceState
    let dashboard: DeviceDashboard

    var body: some View {
        GeometryReader { screen in
            let height = screen.size.height
            let gap = height * 0.016
            VStack(alignment: .leading, spacing: gap) {
                header(height: height)
                if dashboard.tiles.isEmpty {
                    Text("This dashboard has no tiles yet.")
                        .font(.system(size: height * 0.03))
                        .foregroundStyle(Theme.muted)
                    Spacer()
                } else {
                    TileGrid(tiles: dashboard.tiles, timeZone: dashboard.timeZone, gap: gap)
                }
            }
            .padding(.horizontal, screen.size.width * 0.02)
            .padding(.vertical, height * 0.024)
        }
        .ignoresSafeArea()
    }

    private func header(height: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 40) {
            Text(dashboard.dashboard?.name ?? "netrics")
                .font(.system(size: height * 0.03, weight: .semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            Spacer()
            if state.offline {
                Text(TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: dashboard.timeZone))
                    .font(.system(size: height * 0.018))
                    .foregroundStyle(Theme.warning)
            }
            TimelineView(.periodic(from: .now, by: 15)) { context in
                Text(TVTime.clock(context.date, timeZone: dashboard.timeZone))
                    .font(.system(size: height * 0.022).monospacedDigit())
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}

struct TileGrid: View {
    let tiles: [DeviceTile]
    let timeZone: String
    let gap: CGFloat

    var body: some View {
        GeometryReader { area in
            let layout = TVGrid.layout(tiles: tiles.count)
            let width = (area.size.width - gap * CGFloat(layout.columns - 1)) / CGFloat(layout.columns)
            let height = (area.size.height - gap * CGFloat(layout.rows - 1)) / CGFloat(layout.rows)
            VStack(alignment: .leading, spacing: gap) {
                ForEach(0..<layout.rows, id: \.self) { row in
                    HStack(spacing: gap) {
                        ForEach(0..<layout.columns, id: \.self) { column in
                            let index = row * layout.columns + column
                            if index < tiles.count {
                                TileView(tile: tiles[index])
                                    .frame(width: width, height: height)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One tile: label, big value, change line, sparkline and a notice when the
 * numbers may be out of date. Sizes follow the tile's own box, like the
 * web's container units, so 1080p and 4K read the same.
 */
struct TileView: View {
    let tile: DeviceTile

    var body: some View {
        GeometryReader { box in
            let h = box.size.height
            let w = box.size.width
            let now = Date()
            VStack(alignment: .leading, spacing: h * 0.03) {
                HStack(alignment: .firstTextBaseline) {
                    Text(tile.label)
                        .font(.system(size: min(h * 0.09, w * 0.06), weight: .medium))
                        .foregroundStyle(Theme.label)
                        .lineLimit(1)
                    Spacer(minLength: 12)
                    Text(MetricFormat.subtitle(tile))
                        .font(.system(size: min(h * 0.065, w * 0.042)))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }

                if let unit = tile.unit {
                    Text(MetricFormat.value(tile.value, unit: unit))
                        .font(.system(size: min(h * 0.30, w * 0.17), weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .fixedSize(horizontal: false, vertical: true)
                    let change = MetricFormat.changeLine(tile)
                    Text(change.text)
                        .font(.system(size: min(h * 0.08, w * 0.054)))
                        .foregroundStyle(color(change.direction))
                        .lineLimit(1)
                        .fixedSize(horizontal: false, vertical: true)
                    if Sparkline.isDrawable(tile.spark) {
                        SparklineView(spark: tile.spark, lineWidth: max(3, h * 0.012))
                            .frame(maxHeight: .infinity)
                            .padding(.top, h * 0.02)
                    } else {
                        Spacer(minLength: 0)
                    }
                } else {
                    Text("This tile could not load.")
                        .font(.system(size: min(h * 0.07, w * 0.046)))
                        .foregroundStyle(Theme.down)
                    Spacer(minLength: 0)
                }

                if let notice = TileNotices.notice(status: tile.status, updatedAt: tile.updatedAt, now: now) {
                    Text("⚠ \(notice)")
                        .font(.system(size: min(h * 0.06, w * 0.04)))
                        .foregroundStyle(Theme.warning)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, w * 0.06)
            .padding(.top, h * 0.07)
            .padding(.bottom, h * 0.05)
            .frame(width: w, height: h, alignment: .topLeading)
            .background(Theme.tile)
            .clipShape(RoundedRectangle(cornerRadius: h * 0.04))
            .overlay(RoundedRectangle(cornerRadius: h * 0.04).stroke(Theme.tileBorder, lineWidth: 2))
        }
    }

    private func color(_ direction: MetricFormat.Direction) -> Color {
        switch direction {
        case .up: return Theme.up
        case .down: return Theme.down
        case .flat: return Theme.muted
        }
    }
}

/** The current period, one point per bucket; gaps for null buckets. */
struct SparklineView: View {
    let spark: [Double?]
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
                        x: .value("Bucket", point.index),
                        y: .value("Value", point.value),
                        series: .value("Segment", segment)
                    )
                    .foregroundStyle(Theme.sparkLine)
                    .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.linear)
                }
                if points.count == 1, let point = points.first {
                    PointMark(x: .value("Bucket", point.index), y: .value("Value", point.value))
                        .foregroundStyle(Theme.sparkLine)
                        .symbolSize(lineWidth * lineWidth * 2)
                }
            }
            if let last {
                PointMark(x: .value("Bucket", last.index), y: .value("Value", last.value))
                    .foregroundStyle(Theme.accent)
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
