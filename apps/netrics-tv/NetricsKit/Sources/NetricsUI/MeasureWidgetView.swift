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
    var now = Date()
    @State private var expiryClock = Date()
    private var expired: Bool { data.expired(at: max(now, expiryClock)) }

    private func font(_ size: Double, _ weight: Font.Weight = .regular) -> Font {
        env.font(size * env.fontScale, weight)
    }
    private var rows: [MeasureResultRow] { expired ? [] : data.result?.rows ?? [] }
    private func name(_ id: String, dimension: Bool = false) -> String {
        (dimension ? data.metadata?.dimensions : data.metadata?.measures)?.first { $0.id == id }?.name
            ?? id
    }
    var body: some View {
        VStack(alignment: .leading, spacing: env.pt(12)) {
            Text(label).font(font(36, .semibold)).foregroundStyle(env.colors.label).lineLimit(
                scroll ? nil : 2)
            if data.error != nil || expired {
                Text(
                    KitStrings.text(
                        data.error == "data_source_pending" && !expired ? .noDataYet : .noticeOutage,
                        env.language)
                ).font(font(24)).foregroundStyle(env.colors.muted)
            } else if options.view == "value" {
                Text(
                    measureIds.first.flatMap { rows.first?.measures[$0]?.text(language: env.language) } ?? "—"
                )
                .font(font(84, .semibold)).monospacedDigit().minimumScaleFactor(0.4).lineLimit(2)
                .frame(maxWidth: .infinity, maxHeight: scroll ? nil : .infinity, alignment: .leading)
            } else if rows.isEmpty {
                Text(KitStrings.text(.noDataYet, env.language)).font(font(28))
            } else {
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: env.pt(12)) {
                        if !chartSafe {
                            table
                        } else if options.view == "bar" {
                            bars
                        } else if options.view == "line" {
                            line
                        } else {
                            table
                        }
                    }
                }
            }
            if data.result?.stale == true {
                Text(env.language == .de ? "Letzte gültige Daten" : "Last valid data")
                    .font(font(24)).foregroundStyle(env.colors.muted)
            }
            if let total = data.result?.totalRows, total > rows.count {
                Text(
                    env.language == .de
                        ? "\(rows.count) von \(total) Gruppen" : "\(rows.count) of \(total) groups"
                )
                .font(font(24)).foregroundStyle(env.colors.muted)
            }
            ForEach(data.scope ?? [], id: \.self) { scope in
                Text(scope).font(font(24)).foregroundStyle(env.colors.muted)
            }
            if let received = data.result?.receivedAt {
                Text(
                    (env.language == .de ? "Älteste Quellenaktualisierung: " : "Oldest source refresh: ")
                        + RelativeTime.describe(received, now: now, language: env.language)
                )
                .font(font(24)).foregroundStyle(env.colors.muted)
            }
            if data.result?.pendingSources?.isEmpty == false {
                Text(KitStrings.text(.sourceReportsPending, env.language)).font(font(24)).foregroundStyle(env.colors.muted)
            }
            if data.result?.warnings.isEmpty == false
                || rows.contains(where: { $0.measures.values.contains(where: { $0.status == "partial" }) })
            {
                Text(env.language == .de ? "Datenhinweise: Prüfe das Modell." : "Data warnings: check the model.")
                    .font(font(24)).foregroundStyle(env.colors.muted)
            }
            ForEach((data.sourceHealth ?? []).filter { $0.status != "ok" }, id: \.connectionId) { source in
                Text("\(source.name): \(KitStrings.text(source.status == "needs_reauthorization" || source.status == "auth_failed" ? .sourceAccess : source.status == "paused" ? .sourcePaused : source.status == "pending" ? .noticeFirstSync : .noticeOutage, env.language))")
                    .font(font(24)).foregroundStyle(env.colors.muted)
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
    private var table: some View {
        Grid(alignment: .leading, horizontalSpacing: env.pt(20), verticalSpacing: env.pt(12)) {
            GridRow {
                ForEach(groupBy, id: \.self) {
                    Text(name($0, dimension: true)).font(font(28, .semibold))
                }
                ForEach(measureIds, id: \.self) { Text(name($0)).font(font(28, .semibold)) }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(groupBy, id: \.self) {
                        Text(row.dimensionLabels?[$0] ?? row.dimensions[$0]?.text(language: env.language) ?? "—")
                    }
                    ForEach(measureIds, id: \.self) {
                        Text(row.measures[$0]?.text(language: env.language) ?? "—").monospacedDigit()
                    }
                }.font(font(28))
            }
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
                let cell = measureIds.first.flatMap { row.measures[$0] }
                HStack {
                    Text(
                        groupBy.map { row.dimensionLabels?[$0] ?? row.dimensions[$0]?.text(language: env.language) ?? "—" }.joined(
                            separator: " · "))
                    GeometryReader { box in
                        if let value = cell?.value.chartNumber {
                            Rectangle().fill(env.colors.accent)
                                .frame(width: box.size.width * abs(value) / extent / 2)
                                .offset(x: box.size.width * (value >= 0 ? 0.5 : 0.5 - abs(value) / extent / 2))
                        }
                    }.frame(width: env.pt(160), height: env.pt(16))
                    Text(cell?.text(language: env.language) ?? "—").monospacedDigit()
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
            table
        }
    }
}
