import NetricsKit
import SwiftUI

@main
struct NetricsTVApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .task { model.launch() }
        }
    }
}

/** The dark TV palette, as on the web TV layout (globals.css, .tv). */
enum Theme {
    static let background = Color(hex: 0x07090C)
    static let tile = Color(hex: 0x11141A)
    static let tileBorder = Color(hex: 0x23272E)
    static let text = Color(hex: 0xE6E9ED)
    static let label = Color(hex: 0xC5CAD3)
    static let muted = Color(hex: 0x8A919C)
    static let faint = Color(hex: 0x3A404A)
    static let up = Color(hex: 0x9FD6A8)
    static let down = Color(hex: 0xF0A3A3)
    static let warning = Color(hex: 0xE3B341)
    static let sparkLine = Color(hex: 0x5C6470)
    static let accent = Color(hex: 0x7AA2F7)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            switch model.route {
            case .launching:
                MessageView(title: "netrics", text: "Loading…")
            case .serverChoice:
                ServerChoiceView()
            case .running:
                DeviceView()
            }
        }
    }
}

/** What a paired or pairing TV shows, by the client's phase. */
struct DeviceView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false

    var body: some View {
        let state = model.device
        Group {
            switch state.phase {
            case .starting, .unpaired:
                MessageView(title: "netrics", text: "Loading…")
            case .pairing:
                PairingView(state: state, openSettings: { showSettings = true })
            case .blocked(let message):
                BlockedView(message: message, openSettings: { showSettings = true })
            case .paired:
                if let dashboard = state.dashboard {
                    if dashboard.dashboard != nil {
                        DashboardView(state: state, dashboard: dashboard)
                            .remoteSettingsGesture { showSettings = true }
                    } else {
                        MessageView(
                            title: "No dashboard assigned yet",
                            text: "Choose one under TVs in netrics; this screen picks it up on its own.",
                            marker: state.offline
                                ? TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: dashboard.timeZone)
                                : nil
                        )
                        .remoteSettingsGesture { showSettings = true }
                    }
                } else {
                    MessageView(title: "netrics", text: state.offline ? "Connecting to netrics…" : "Loading…")
                        .remoteSettingsGesture { showSettings = true }
                }
            }
        }
        .fullScreenCover(isPresented: $showSettings) {
            SettingsView(close: { showSettings = false })
        }
        .task {
            if DebugLaunch.openSettings {
                try? await Task.sleep(for: .seconds(4))
                showSettings = true
            }
        }
    }
}

extension View {
    /**
     * Settings on a screen without buttons: press and hold the clickpad
     * (select), or press Play/Pause on the Siri Remote.
     */
    func remoteSettingsGesture(_ open: @escaping () -> Void) -> some View {
        self
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .focusable()
            .focusEffectDisabled()
            .onLongPressGesture(minimumDuration: 0.8, perform: open)
            .onPlayPauseCommand(perform: open)
    }
}

/** One calm message in the middle of the screen. */
struct MessageView: View {
    let title: String
    let text: String
    var marker: String?

    var body: some View {
        VStack(spacing: 32) {
            Text(title)
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(text)
                .font(.system(size: 32))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1300)
            if let marker {
                Text(marker)
                    .font(.system(size: 24))
                    .foregroundStyle(Theme.warning)
            }
        }
        .padding(80)
    }
}

/** The pinned certificate changed: stop and warn instead of connecting. */
struct BlockedView: View {
    let message: String
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 40) {
            Text("⚠ Connection stopped")
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.warning)
            Text(message)
                .font(.system(size: 32))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1400)
            Button("Settings", action: openSettings)
        }
        .padding(80)
    }
}
