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
    /** Tests only: draw this many rows instead of the fitted ones. */
    var rowsDrawn: Int? = nil
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
    /// A value view with a grouping: a total with its split (#784).
    private var split: Bool { options.view == "value" && !groupBy.isEmpty }
    /// A total with its split fitted to its tile, as a table is (#784).
    private var fitsSplit: Bool { placement != nil && !scroll && split }
    /// Its texts are drawn at the line heights the fit counts.
    private var fitsLayout: Bool { fitsTile || fitsSplit }
    private var box: (width: Double, height: Double)? {
        placement.flatMap { placement -> (width: Double, height: Double)? in
            guard fitsLayout else { return nil }
            return StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        }
    }
    /// Units per screen pixel: each line may round up to a pixel.
    private var pixel: Double? { env.u > 0 ? 1 / Double(env.u * Swift.max(1, env.displayScale)) : nil }
    /// Points per unit: under a point (iPad, iPhone) the system font draws
    /// wider than on a TV, and the fit counts it so (#780).
    private var points: Double? { env.u > 0 ? Double(env.u) : nil }
    private var fit: (shown: Int, rowsLine: String?, columnWidths: [Double]?) {
        if split {
            let fit = splitFit
            return (fit.shown, fit.rowsLine, nil)
        }
        return data.tableFit(
            label: label, measureIds: measureIds, groupBy: groupBy, rows: rows, box: fitsTile ? box : nil,
            fontScale: env.fontScale, labels: options.labels, pixel: pixel, points: points, now: now,
            language: env.language)
    }
    private var splitFit: (valueSize: Double, valueLines: Int?, shown: Int, rowsLine: String?) {
        data.splitFit(
            label: label, measureIds: measureIds, groupBy: groupBy, rows: rows, box: fitsSplit ? box : nil,
            fontScale: env.fontScale, pixel: pixel, points: points, now: now, language: env.language)
    }
    /// A freshness line over several sources (#784): the form that fits
    /// the tile, a line each; nil for one source.
    private var sourceLayout: MeasureWidgetData.FreshnessSourceLayout? {
        data.freshnessSourceLayout(
            width: fitsLayout ? box?.width : nil, scroll: scroll, fontScale: env.fontScale, points: points,
            now: now, language: env.language)
    }
    /// A line of `size` units as the fit counts it (#768): the system font's
    /// own lines are taller (1.18 em) than the 1.15 the web draws.
    private func line(_ size: Double, _ height: Double = StudioLayout.MeasureTableMetrics.lineHeight) -> CGFloat {
        env.pt(size * env.fontScale * height)
    }
    /// A footer line of a fitted table: counted height, never compressed,
    /// so the rows give way, not the footer.
    private func footer(_ height: Double = StudioLayout.MeasureTableMetrics.lineHeight) -> MeasureLineHeight {
        MeasureLineHeight(points: fitsLayout ? line(24, height) : nil, fixed: fitsLayout)
    }
    var body: some View {
        let fitted = self.fit
        let fit = (shown: rowsDrawn ?? fitted.shown, rowsLine: fitted.rowsLine, columnWidths: fitted.columnWidths)
        VStack(alignment: .leading, spacing: env.pt(12)) {
            Text(label).font(font(36, .semibold)).foregroundStyle(env.colors.label).lineLimit(
                scroll ? nil : 2
            )
            .modifier(MeasureLineHeight(points: fitsLayout ? line(36) : nil, fixed: fitsLayout))
            if let error = data.viewerError(expired: expired, language: env.language) {
                Text(error).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            } else if split {
                splitView
            } else if options.view == "value" {
                Text(
                    measureIds.first.map {
                        data.text(rows.first?.measures[$0], measure: $0, language: env.language, single: true)
                    } ?? "—"
                )
                .font(font(84, .semibold)).monospacedDigit().minimumScaleFactor(0.4).lineLimit(2)
                .frame(maxWidth: .infinity, maxHeight: scroll ? nil : .infinity, alignment: .leading)
            } else if rows.isEmpty {
                Text(KitStrings.text(.noDataYet, env.language)).font(font(28))
            } else if fitsTile {
                // A fitted table (#768): columns that wrap, no scrolling; none
                // when not even a row fits ("0 of N" says so). Their widths are
                // the fit's: even, or what keeps the heads' words whole (#780).
                if fit.shown > 0 { table(Array(rows.prefix(fit.shown)), even: true, widths: fit.columnWidths) }
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
                    .font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            if let rowsLine = fit.rowsLine {
                Text(verbatim: rowsLine)
                    .font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            ForEach(data.scope ?? [], id: \.self) { scope in
                Text(scope).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            if data.showsFreshnessLine(now: now, language: env.language) {
                // The freshness line replaces the refresh age (ADR 0025, #769): the
                // longest form that fits one line, parts dropped from the end;
                // a provider overdue by a day is the warning instead.
                let lines = data.freshnessLines(now: now, language: env.language)
                let candidates = lines.footer
                if let warning = lines.warning {
                    Text(verbatim: "⚠ \(warning)").font(font(24)).foregroundStyle(env.colors.warning)
                        .modifier(footer())
                } else if let sourceLayout {
                    // Several sources (#784): the form that fits, never cut; a
                    // line per source as the last form.
                    switch sourceLayout {
                    case .lines(let lines):
                        // Chosen as the fit counts it (or a scroll card, which wraps).
                        sourceLines(lines, limit: scroll ? nil : 1)
                    case .firstThatFits(let levels):
                        // Unfitted tile: the first form that fits its actual width.
                        ViewThatFits(in: .horizontal) {
                            ForEach(Array(levels.enumerated()), id: \.offset) { index, lines in
                                sourceLines(lines, limit: index == levels.count - 1 ? nil : 1)
                            }
                        }
                    }
                } else if scroll {
                    if let first = candidates.first {
                        Text(verbatim: first).font(font(24).monospacedDigit()).foregroundStyle(env.colors.muted)
                            .modifier(footer(StudioLayout.MeasureTableMetrics.freshnessLineHeight))
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        ForEach(candidates, id: \.self) { line in
                            Text(verbatim: line).lineLimit(1)
                                .modifier(footer(StudioLayout.MeasureTableMetrics.freshnessLineHeight))
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
                .font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            if data.result?.pendingSources?.isEmpty == false {
                Text(KitStrings.text(.sourceReportsPending, env.language)).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            // A wall screen's wording: the state, not the editor's remedy (#676).
            // Partial data and the warning count: two different lines at most.
            ForEach(data.viewerWarnings(rows: rows, language: env.language), id: \.self) { notice in
                Text(notice).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            ForEach(data.viewerSourceNotices(language: env.language)) { notice in
                Text(notice.text).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
            }
            ForEach(data.exclusions, id: \.filterId) { exclusion in
                Text(exclusion.reason).font(font(24)).foregroundStyle(env.colors.muted).modifier(footer())
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
    /// A freshness form's lines (#784), one Text each.
    private func sourceLines(_ lines: [String], limit: Int?) -> some View {
        VStack(alignment: .leading, spacing: env.pt(12)) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line).lineLimit(limit)
                    .font(font(24).monospacedDigit()).foregroundStyle(env.colors.muted)
                    .modifier(footer(StudioLayout.MeasureTableMetrics.freshnessLineHeight))
            }
        }
    }
    /// A total with its split (#784): the total, then a line per group,
    /// label leading and value trailing; the groups alone without a total.
    @ViewBuilder private var splitView: some View {
        let fit = splitFit
        let lines = data.splitLines(measureIds: measureIds, groupBy: groupBy, rows: rows, language: env.language)
        if rows.isEmpty {
            Text(KitStrings.text(.noDataYet, env.language)).font(font(28))
        } else {
            if let total = data.splitTotal(measureIds: measureIds, language: env.language) {
                // Wraps between its amounts only, on the lines the fit counts.
                Text(verbatim: total)
                    .font(env.font(fit.valueSize, .semibold)).monospacedDigit().lineLimit(fit.valueLines)
                    .modifier(
                        MeasureLineHeight(
                            points: fitsSplit
                                ? env.pt(fit.valueSize * StudioLayout.MeasureSplitMetrics.valueLineHeight) : nil,
                            fixed: fitsSplit))
            }
            if fit.shown > 0 {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(fit.shown).enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .firstTextBaseline) {
                            Text(verbatim: entry.0)
                            Spacer(minLength: env.pt(12))
                            Text(verbatim: entry.1).monospacedDigit()
                        }
                        .font(font(28))
                        .modifier(MeasureLineHeight(points: fitsSplit ? line(28) : nil, fixed: fitsSplit))
                    }
                }
            }
        }
    }
    private func table(_ rows: [MeasureResultRow], even: Bool = false, widths: [Double]? = nil) -> some View {
        // A fitted table's rows are as tall as the fit counts them: the
        // lines plus 10 units above and below (MeasureTableMetrics).
        // Fitted: columns with 10 units of padding on each side, as the
        // web's cells and the fit count them; `widths` in units, padding
        // included (nil: even shares).
        let dimensions = groupBy.count
        // A column's width, where the fit set one for every column.
        let width = { (column: Int) -> Double? in
            widths.flatMap { $0.count == dimensions + measureIds.count ? $0[column] : nil }
        }
        return Grid(
            alignment: .leading, horizontalSpacing: env.pt(even ? 0 : 20), verticalSpacing: env.pt(even ? 0 : 12)
        ) {
            GridRow {
                ForEach(Array(groupBy.enumerated()), id: \.element) { column, id in
                    cell(Text(name(id, dimension: true)).font(font(28, .semibold)), even: even, width: width(column))
                }
                ForEach(Array(measureIds.enumerated()), id: \.element) { column, id in
                    cell(Text(name(id)).font(font(28, .semibold)), even: even, width: width(dimensions + column))
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(groupBy.enumerated()), id: \.element) { column, id in
                        cell(
                            Text(data.dimensionText(row, dimension: id, language: env.language)), even: even,
                            width: width(column))
                    }
                    ForEach(Array(measureIds.enumerated()), id: \.element) { column, id in
                        cell(
                            Text(data.text(row.measures[id], measure: id, language: env.language)).monospacedDigit(),
                            even: even, width: width(dimensions + column))
                    }
                }.font(font(28))
            }
        }
    }
    /// A cell of a fitted table, wrapping: `width` units wide with its
    /// padding, or (nil) an even share of the table.
    @ViewBuilder private func cell(_ text: some View, even: Bool, width: Double? = nil) -> some View {
        if even {
            let lines = text.modifier(MeasureLineHeight(points: line(28), fixed: false))
            if let width {
                lines.frame(width: Swift.max(0, env.pt(width - 20)), alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(env.pt(10))
            } else {
                lines.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .padding(env.pt(10))
            }
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
            // On a slide the chart alone; the point table only in a scroll card (#835).
            let shown = MeasureLineChart.tableRows(placed: placement != nil, scroll: scroll, count: rows.count)
            if shown > 0 { table(Array(rows.prefix(shown))) }
        }
    }
}

/// Exact line height for the measure tile's texts (#768), as
/// HeaderNameLineHeight does for the header; `fixed` keeps a line's full
/// height when the tile is tight.
struct MeasureLineHeight: ViewModifier {
    let points: CGFloat?
    let fixed: Bool

    func body(content: Content) -> some View {
        if let points {
            content.lineHeight(.exact(points: points)).fixedSize(horizontal: false, vertical: fixed)
        } else {
            content
        }
    }
}
