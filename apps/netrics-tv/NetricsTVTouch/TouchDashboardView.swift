import NetricsKit
import NetricsUI
import SwiftUI
import UIKit

/**
 * A paired iPhone or iPad: the dashboard and the way to settings. On iPad
 * the screen view sized to the window (#412); on iPhone scroll view in
 * portrait and screen view in landscape (#413). Screen view shows its
 * settings button in the chrome a tap brings up (#414); scroll view and
 * the notices keep it in the corner. The demo (#416) shows the same views
 * with "Leave demo" instead of settings.
 */
struct TouchDashboardView: View {
    @Environment(\.screenLanguage) private var language
    @Environment(DeviceSession.self) private var model
    let state: DeviceState
    let images: FileImageCache
    let openSettings: () -> Void
    /** Set in the demo: the button leaves it instead of opening settings. */
    var leaveDemo: (() -> Void)? = nil

    private var actions: TouchActions { TouchActions(openSettings: openSettings, leaveDemo: leaveDemo) }

    var body: some View {
        if let payload = state.dashboardV2, payload.dashboard != nil {
            if UIDevice.current.userInterfaceIdiom == .pad {
                // iPad: screen view sized to the window, or scroll view by the device setting (#412).
                PadDashboardView(state: state, payload: payload, images: images, actions: actions)
            } else {
                // iPhone: scroll view in portrait, screen view in landscape (#413).
                // The demo is bundled and offline: no pull to refresh there (#416).
                PhoneDashboardView(
                    state: state, payload: payload, images: images,
                    refresh: leaveDemo == nil ? { await model.refresh() } : nil, actions: actions)
            }
        } else {
            other.overlay(alignment: .bottomTrailing) {
                TouchSettingsButton(actions: actions, language: language).padding()
            }
        }
    }

    @ViewBuilder
    private var other: some View {
        if let dashboard = state.dashboard, dashboard.dashboard != nil {
            // Schema 1 (an older server): the tile grid.
            DashboardView(state: state, dashboard: dashboard)
        } else if state.payload != nil {
            TouchNotice(
                title: L10n.tr("No dashboard assigned yet", language),
                text: L10n.tr("Choose one under TVs in netrics; this screen picks it up on its own.", language))
        } else {
            TouchNotice(
                title: "netrics",
                text: L10n.tr(state.offline ? "Connecting to netrics…" : "Loading…", language))
        }
    }
}

/**
 * Scroll view on iPhone and iPad: NetricsUI's `ScrollDashboardView`, a tap
 * on a card for its detail sheet (#414), and the settings button (or
 * "Leave demo") always in the corner, since scroll view has no chrome.
 */
struct TouchScrollView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    let refresh: (@MainActor () async -> Void)?
    let actions: TouchActions

    @State private var detail: WidgetDetailSelection?
    /** The corner button's height, which grows with Dynamic Type. */
    @State private var buttonHeight = 56.0

    var body: some View {
        ScrollDashboardView(
            state: state, payload: payload, images: images, refresh: refresh,
            interaction: WidgetInteraction(openWidget: { detail = WidgetDetailSelection(widget: $0) })
        )
        // Room under the last card, so the button in the corner never covers it.
        .contentMargins(.bottom, buttonHeight + 24, for: .scrollContent)
        .overlay(alignment: .bottomTrailing) {
            TouchSettingsButton(actions: actions, language: payload.language)
                .onGeometryChange(for: Double.self, of: { $0.size.height }, action: { buttonHeight = $0 })
                .padding()
        }
        .sheet(item: $detail) { selection in
            WidgetDetailSheet(
                widget: payload.slides.lazy.flatMap(\.widgets).first { $0.id == selection.id } ?? selection.widget,
                language: payload.language)
        }
    }
}

/** One calm message in the middle of the screen, in the system's type sizes. */
struct TouchNotice: View {
    let title: String
    let text: String

    var body: some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.title.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: 520, maxHeight: .infinity)
    }
}
