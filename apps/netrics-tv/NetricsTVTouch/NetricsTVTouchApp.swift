import NetricsKit
import NetricsUI
import SwiftUI
import UIKit

/**
 * netrics TV on iPhone and iPad (ADR 0021). The flows are the Apple TV's
 * (`DeviceSession` in NetricsUI): netrics cloud at once, "Use your own
 * server", the code with the approval link, and the dashboard once an owner
 * or admin approves it on the web (#411). The iPad and iPhone layouts,
 * touch and the lifecycle follow in #412 to #415; `TouchDashboardView` is
 * where they plug in.
 */
@main
struct NetricsTVTouchApp: App {
    @State private var model = DeviceSession(
        platform: UIDevice.current.userInterfaceIdiom == .pad ? .ipados : .ios,
        appGroup: Bundle.main.object(forInfoDictionaryKey: CacheLocation.appGroupInfoKey) as? String)

    var body: some Scene {
        // One window: the app is one device pairing (Info.plist turns off
        // multiple scenes).
        WindowGroup {
            TouchRootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .task { model.launch() }
        }
    }
}

struct TouchRootView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let language = model.language
        ZStack {
            Theme.background.ignoresSafeArea()
            if let demo = model.demo {
                // "Try a demo" (#416): over whatever was on screen, until left.
                TouchDashboardView(state: demo, images: model.images, openSettings: {}, leaveDemo: model.leaveDemo)
                    .environment(\.demoMode, true)
            } else {
                switch model.route {
                case .launching:
                    ProgressView()
                case .connectingCloud:
                    TouchConnectingCloudView()
                case .ownServer:
                    TouchServerEntryView()
                case .running:
                    TouchDeviceView()
                }
            }
        }
        // The window, for the heartbeat (ADR 0017, section 7).
        .background {
            GeometryReader { window in
                Color.clear
                    .onAppear { measured(window.size) }
                    .onChange(of: window.size) { _, size in measured(size) }
            }
            .ignoresSafeArea()
        }
        // Polls only in the foreground; on return at once, with a heartbeat (#415).
        .deviceLifecycle(model)
        // The app's text and numbers in the screen language (ADR 0016).
        .environment(\.screenLanguage, language)
        .environment(\.locale, language.locale)
    }

    private func measured(_ size: CGSize) {
        model.measured(Double(size.width), Double(size.height), scale: Double(displayScale))
    }
}

/** What a paired or pairing iPhone or iPad shows, by the client's phase. */
struct TouchDeviceView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    @State private var showSettings = false

    var body: some View {
        let state = model.device
        Group {
            switch state.phase {
            case .starting, .unpaired:
                ProgressView()
            case .pairing:
                TouchPairingView(state: state, openSettings: { showSettings = true })
            case .blocked(let message):
                TouchBlockedView(
                    message: KitStrings.translate(message, to: language), openSettings: { showSettings = true })
            case .paired:
                TouchDashboardView(state: state, images: model.images, openSettings: { showSettings = true })
            }
        }
        .sheet(isPresented: $showSettings) {
            TouchSettingsView()
                // The sheet is its own presentation: give it the language again.
                .environment(model)
                .environment(\.screenLanguage, language)
                .environment(\.locale, language.locale)
                .preferredColorScheme(.dark)
        }
        .task {
            if DebugLaunch.openSettings {
                try? await Task.sleep(for: .seconds(4))
                showSettings = true
            }
        }
    }
}

/** The pinned certificate changed: stop and warn instead of connecting. */
struct TouchBlockedView: View {
    @Environment(\.screenLanguage) private var language
    let message: String
    let openSettings: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(L10n.tr("⚠ Connection stopped", language), systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.warning)
        } description: {
            Text(message)
        } actions: {
            Button(L10n.tr("Settings", language), action: openSettings)
                .buttonStyle(.borderedProminent)
        }
    }
}
