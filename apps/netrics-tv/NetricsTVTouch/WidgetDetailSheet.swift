import NetricsKit
import NetricsUI
import SwiftUI

/**
 * A widget's details on iPhone and iPad (#414), opened by a tap on it in
 * screen view or on its card in scroll view: label, value, period,
 * comparison, source and "updated … ago", worded by NetricsKit's
 * `WidgetDetail` from the payload alone, so it works offline. System
 * controls and Dynamic Type, as the app's other sheets.
 */
struct WidgetDetailSheet: View {
    let widget: DeviceWidget
    let language: ScreenLanguage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            // "updated 5 minutes ago" is worded anew every minute.
            TimelineView(.everyMinute) { context in
                if let detail = WidgetDetail.make(widget, now: context.date, language: language) {
                    content(detail)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.tr("Done", language)) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .environment(\.locale, language.locale)
    }

    private func content(_ detail: WidgetDetail) -> some View {
        List {
            Section {
                ForEach(Array(detail.rows.enumerated()), id: \.offset) { _, row in
                    LabeledContent(title(row.field)) {
                        Text(row.text)
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                }
            }
            if !detail.items.isEmpty {
                Section {
                    ForEach(Array(detail.items.enumerated()), id: \.offset) { _, item in
                        LabeledContent(item.label, value: item.value)
                    }
                }
            }
            if let text = detail.text {
                Section {
                    Text(text)
                }
            }
        }
        .navigationTitle(detail.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) {
            if let subtitle = detail.subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 4)
            }
        }
    }

    private func title(_ field: WidgetDetail.Field) -> String {
        switch field {
        case .value: return L10n.tr("Value", language)
        case .period: return L10n.tr("Period", language)
        case .comparison: return L10n.tr("Change", language)
        case .previous: return L10n.tr("Previous period", language)
        case .goal: return L10n.tr("Goal", language)
        case .progress: return L10n.tr("Progress", language)
        case .source: return L10n.tr("Source", language)
        case .conversion: return L10n.tr("Exchange rates", language)
        case .updated: return L10n.tr("Updated", language)
        }
    }
}
