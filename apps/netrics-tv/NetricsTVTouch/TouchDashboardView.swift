import NetricsKit
import NetricsUI
import SwiftUI
import UIKit

/**
 * A paired iPhone or iPad: the dashboard and the way to settings. On iPad
 * the screen view sized to the window (#412); on iPhone NetricsUI's scroll
 * view until the portrait and landscape views (#413) replace it here.
 */
struct TouchDashboardView: View {
    @Environment(\.screenLanguage) private var language
    let state: DeviceState
    let images: FileImageCache
    let openSettings: () -> Void

    var body: some View {
        content
            .overlay(alignment: .bottomTrailing) {
                Button(action: openSettings) {
                    Image(systemName: "gearshape")
                        .font(.title3)
                        .padding(6)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel(L10n.tr("Settings", language))
                .padding()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let payload = state.dashboardV2, payload.dashboard != nil {
            if UIDevice.current.userInterfaceIdiom == .pad {
                // iPad: screen view sized to the window, or scroll view by the device setting (#412).
                PadDashboardView(state: state, payload: payload, images: images)
            } else {
                ScrollDashboardView(state: state, payload: payload, images: images)
            }
        } else if let dashboard = state.dashboard, dashboard.dashboard != nil {
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
