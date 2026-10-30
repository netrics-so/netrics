import NetricsKit
import NetricsUI
import SwiftUI

/**
 * "Try a demo" on Apple TV (#416, ADR 0021 section 5): the bundled sample
 * dashboard with the Siri Remote's commands, "Demo" in the header. Back
 * (Menu on older remotes) leaves it; pressing and holding the clickpad
 * opens a small menu instead of the settings, since nothing is paired. A
 * hint says how to leave for the first seconds.
 */
struct DemoView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    let state: DeviceState
    @State private var showMenu = false
    @State private var showHint = true

    var body: some View {
        Group {
            if let payload = state.dashboardV2 {
                SlideshowView(state: state, payload: payload, images: model.images, openSettings: { showMenu = true })
            }
        }
        .environment(\.demoMode, true)
        .onExitCommand { model.leaveDemo() }
        .overlay(alignment: .bottom) {
            if showHint {
                Text(L10n.tr("Press Back on the remote to leave the demo.", language))
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 16)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 120)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(8))
            withAnimation { showHint = false }
        }
        .fullScreenCover(isPresented: $showMenu) {
            DemoMenuView(close: { showMenu = false })
        }
    }
}

/** The demo's menu: what it is, and the way back to pairing. */
struct DemoMenuView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 40) {
            Text(L10n.tr("Demo", language))
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(
                L10n.tr(
                    "This sample dashboard shows made-up numbers and works without a connection. Pair this TV to show your own dashboard.",
                    language)
            )
            .font(.system(size: 30))
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: 1200, alignment: .leading)
            HStack(spacing: 40) {
                Button(L10n.tr("Leave demo", language)) {
                    close()
                    model.leaveDemo()
                }
                Button(L10n.tr("Back to the demo", language), action: close)
            }
        }
        .padding(100)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.background.ignoresSafeArea())
        .onExitCommand(perform: close)
    }
}
