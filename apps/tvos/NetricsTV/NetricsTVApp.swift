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
    /** A theme token (`#rrggbb`); netrics Dark's text colour if it is not one. */
    init(token: String) {
        let color = ThemeColor.parse(token) ?? ThemeColor.parse(ThemeTokens.netricsDark.text)!
        self.init(red: color.red, green: color.green, blue: color.blue)
    }

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
        let language = model.language
        ZStack {
            Theme.background.ignoresSafeArea()
            switch model.route {
            case .launching:
                MessageView(title: "netrics", text: L10n.tr("Loading…", language))
            case .connectingCloud:
                ConnectingCloudView()
            case .ownServer:
                ServerEntryView()
            case .running:
                DeviceView()
            }
        }
        // Chrome and numbers in the screen language (ADR 0016).
        .environment(\.screenLanguage, language)
        .environment(\.locale, language.locale)
    }
}

/** What a paired or pairing TV shows, by the client's phase. */
struct DeviceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language
    @State private var showSettings = false

    var body: some View {
        let state = model.device
        Group {
            switch state.phase {
            case .starting, .unpaired:
                MessageView(title: "netrics", text: L10n.tr("Loading…", language))
            case .pairing:
                PairingView(state: state, openSettings: { showSettings = true })
            case .blocked(let message):
                BlockedView(
                    message: KitStrings.translate(message, to: language), openSettings: { showSettings = true })
            case .paired:
                if let payload = state.payload {
                    if let v2 = state.dashboardV2, v2.dashboard != nil {
                        // Schema 2: slides, rotated here (ADR 0015).
                        SlideshowView(
                            state: state, payload: v2, images: model.images,
                            openSettings: { showSettings = true })
                    } else if let dashboard = state.dashboard, dashboard.dashboard != nil {
                        // Schema 1 (an older server): every tile on one screen.
                        DashboardView(state: state, dashboard: dashboard)
                            .remoteSettingsGesture { showSettings = true }
                    } else {
                        MessageView(
                            title: L10n.tr("No dashboard assigned yet", language),
                            text: L10n.tr(
                                "Choose one under TVs in netrics; this screen picks it up on its own.", language),
                            marker: state.offline
                                ? TVTime.offlineMarker(
                                    updatedAt: state.updatedAt, timeZone: payload.timeZone, language: language)
                                : nil
                        )
                        .remoteSettingsGesture { showSettings = true }
                    }
                } else {
                    MessageView(
                        title: "netrics",
                        text: L10n.tr(state.offline ? "Connecting to netrics…" : "Loading…", language))
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
    @Environment(\.screenLanguage) private var language
    let message: String
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 40) {
            Text(L10n.tr("⚠ Connection stopped", language))
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.warning)
            Text(message)
                .font(.system(size: 32))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1400)
            Button(L10n.tr("Settings", language), action: openSettings)
        }
        .padding(80)
    }
}
