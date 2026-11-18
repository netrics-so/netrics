import NetricsKit
import SwiftUI

/// Shared semantic values and tables. The server supplies every calculation.
struct MeasureWidgetView: View {
    let label: String
    let measureIds: [String]
    let groupBy: [String]
    let options: MeasureWidgetOptions
    let data: MeasureWidgetData
    let env: WidgetEnv
    var scroll = false
    /** Where the tile sits (#768): a table shows the rows that fit; nil in scroll cards. */
    var placement: ScreenPlacement? = nil
    var now = Date()
    @State private var expiryClock = Date()
    private var expired: Bool { data.expired(at: max(now, expiryClock)) }

    private func font(_ size: Double, _ weight: Font.Weight = .regular) -> Font {
        env.font(size * env.fontScale, weight)
    }
    private var rows: [MeasureResultRow] { expired ? [] : data.result?.rows ?? [] }
    private func name(_ id: String, dimension: Bool = false) -> String {
        options.labels?[id]
            ?? (dimension ? data.metadata?.dimensions : data.metadata?.measures)?.first { $0.id == id }?.name
            ?? id
    }
    /// The rows the table shows and its "N of M" line (#768): fitted to the
    /// tile above the footer lines, deterministic from the payload and the
    /// tile's size, so nothing is measured after drawing.
    private var fitsTile: Bool {
        placement != nil && !scroll && options.view != "value" && (options.view == "table" || !chartSafe)
    }
    private var fit: (shown: Int, rowsLine: String?) {
        let box = placement.flatMap { placement -> (width: Double, height: Double)? in
            guard fitsTile else { return nil }
            return StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        }
        return data.tableFit(
            label: label, measureIds: measureIds, groupBy: groupBy, rows: rows, box: box,
            fontScale: env.fontScale, labels: options.labels, now: now, language: env.language)
    }
    var body: some View {
        let fit = self.fit
        VStack(alignment: .leading, spacing: env.pt(12)) {
            Text(label).font(font(36, .semibold)).foregroundStyle(env.colors.label).lineLimit(
                scroll ? nil : 2)
            if let error = data.viewerError(expired: expired, language: env.language) {
                Text(error).font(font(24)).foregroundStyle(env.colors.muted)
            } else if options.view == "value" {
                Text(
                    measureIds.first.map { data.text(rows.first?.measures[$0], measure: $0, language: env.language) } ?? "—"
                )
                .font(font(84, .semibold)).monospacedDigit().minimumScaleFactor(0.4).lineLimit(2)
                .frame(maxWidth: .infinity, maxHeight: scroll ? nil : .infinity, alignment: .leading)
            } else if rows.isEmpty {
                Text(KitStrings.text(.noDataYet, env.language)).font(font(28))
            } else if fitsTile {
                // A fitted table (#768): even columns that wrap, no scrolling;
                // none when not even a row fits ("0 of N" says so).
                if fit.shown > 0 { table(Array(rows.prefix(fit.shown)), even: true) }
            } else {
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: env.pt(12)) {
                        if !chartSafe {
                            table(Array(rows.prefix(fit.shown)))
                        } else if options.view == "bar" {
                            bars
                        } else if options.view == "line" {
                            line
                        } else {
                            table(Array(rows.prefix(fit.shown)))
                        }
                    }
                }
            }
            if data.result?.stale == true {
                Text(KitStrings.text(.measureStale, env.language))
                    .font(font(24)).foregroundStyle(env.colors.muted)
            }
            if let rowsLine = fit.rowsLine {
                Text(verbatim: rowsLine)
                    .font(font(24)).foregroundStyle(env.colors.muted)
            }
            ForEach(data.scope ?? [], id: \.self) { scope in
                Text(scope).font(font(24)).foregroundStyle(env.colors.muted)
            }
            if data.showsFreshnessLine(now: now, language: env.language) {
                // The freshness line replaces the refresh age (ADR 0025, #769): the
                // longest form that fits one line, parts dropped from the end;
                // a provider overdue by a day is the warning instead.
                let lines = data.freshnessLines(now: now, language: env.language)
                let candidates = lines.footer
                if let warning = lines.warning {
                    Text(verbatim: "⚠ \(warning)").font(font(24)).foregroundStyle(env.colors.warning)
                } else if scroll {
                    if let first = candidates.first {
                        Text(verbatim: first).font(font(24).monospacedDigit()).foregroundStyle(env.colors.muted)
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        ForEach(candidates, id: \.self) { line in
                            Text(verbatim: line).lineLimit(1)
                        }
                    }
                    .font(font(24).monospacedDigit()).foregroundStyle(env.colors.muted)
                }
            } else if let received = data.result?.receivedAt {
                Text(
                    verbatim: KitStrings.text(
                        .measureOldestRefresh, env.language,
                        RelativeTime.describe(received, now: now, language: env.language))
                )
                .font(font(24)).foregroundStyle(env.colors.muted)
            }
            if data.result?.pendingSources?.isEmpty == false {
                Text(KitStrings.text(.sourceReportsPending, env.language)).font(font(24)).foregroundStyle(env.colors.muted)
            }
            // A wall screen's wording: the state, not the editor's remedy (#676).
            // Partial data and the warning count: two different lines at most.
            ForEach(data.viewerWarnings(rows: rows, language: env.language), id: \.self) { notice in
                Text(notice).font(font(24)).foregroundStyle(env.colors.muted)
            }
            ForEach(data.viewerSourceNotices(language: env.language)) { notice in
                Text(notice.text).font(font(24)).foregroundStyle(env.colors.muted)
            }
            ForEach(data.exclusions, id: \.filterId) { exclusion in
                Text(exclusion.reason).font(font(24)).foregroundStyle(env.colors.muted)
            }
        }
        .foregroundStyle(env.colors.text)
        .task(id: data.result?.expiresAt) {
            guard let deadline = data.expirationDate else { return }
            while !Task.isCancelled && deadline > Date() {
                do { try await Task.sleep(for: .seconds(min(86400, deadline.timeIntervalSinceNow))) } catch { return }
                expiryClock = Date()
            }
            expiryClock = Date()
        }
    }
    private func table(_ rows: [MeasureResultRow], even: Bool = false) -> some View {
        // A fitted table's rows are as tall as the fit counts them: the
        // lines plus 10 units above and below (MeasureTableMetrics).
        Grid(alignment: .leading, horizontalSpacing: env.pt(20), verticalSpacing: env.pt(even ? 0 : 12)) {
            GridRow {
                ForEach(groupBy, id: \.self) {
                    cell(Text(name($0, dimension: true)).font(font(28, .semibold)), even: even)
                }
                ForEach(measureIds, id: \.self) { cell(Text(name($0)).font(font(28, .semibold)), even: even) }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(groupBy, id: \.self) {
                        cell(Text(data.dimensionText(row, dimension: $0, language: env.language)), even: even)
                    }
                    ForEach(measureIds, id: \.self) {
                        cell(
                            Text(data.text(row.measures[$0], measure: $0, language: env.language)).monospacedDigit(),
                            even: even)
                    }
                }.font(font(28))
            }
        }
    }
    /// A cell of a fitted table: an even share of the width, wrapping.
    @ViewBuilder private func cell(_ text: some View, even: Bool) -> some View {
        if even {
            text.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, env.pt(10))
        } else {
            text
        }
    }
    private var chartSafe: Bool {
        rows.allSatisfy { row in
            measureIds.allSatisfy { id in row.measures[id]?.value == .null || row.measures[id]?.value.chartNumber != nil
            }
        }
    }
    private var extent: Double {
        max(
            1,
            rows.compactMap { row in measureIds.first.flatMap { row.measures[$0]?.value.chartNumber } }
                .map(abs).max() ?? 1)
    }
    private var bars: some View {
        VStack(alignment: .leading, spacing: env.pt(12)) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                let id = measureIds.first
                let cell = id.flatMap { row.measures[$0] }
                HStack {
                    Text(
                        groupBy.map { data.dimensionText(row, dimension: $0, language: env.language) }.joined(
                            separator: " · "))
                    GeometryReader { box in
                        if let value = cell?.value.chartNumber {
                            Rectangle().fill(env.colors.accent)
                                .frame(width: box.size.width * abs(value) / extent / 2)
                                .offset(x: box.size.width * (value >= 0 ? 0.5 : 0.5 - abs(value) / extent / 2))
                        }
                    }.frame(width: env.pt(160), height: env.pt(16))
                    Text(id.map { data.text(cell, measure: $0, language: env.language) } ?? "—").monospacedDigit()
                }.font(font(28))
            }
        }
    }
    private var line: some View {
        VStack(alignment: .leading) {
            Canvas { context, size in
                var path = Path()
                var continuing = false
                for (index, row) in rows.enumerated() {
                    guard let id = measureIds.first, let number = row.measures[id]?.value.chartNumber else {
                        continuing = false
                        continue
                    }
                    let point = CGPoint(
                        x: rows.count <= 1
                            ? size.width / 2 : Double(index) / Double(rows.count - 1) * size.width,
                        y: size.height * (1 - (number / extent + 1) / 2))
                    if continuing { path.addLine(to: point) } else { path.move(to: point) }
                    continuing = true
                }
                context.stroke(path, with: .color(env.colors.accent), lineWidth: env.pt(3))
            }.frame(width: env.pt(500), height: env.pt(180))
            table(rows)
        }
    }
}
