import NetricsKit
import NetricsUI
import SwiftUI

/**
 * netrics TV on iPhone and iPad (ADR 0021, #410): the app shell. Pairing,
 * the iPad and iPhone layouts, touch and the lifecycle follow in #411 to
 * #415; until then the app shows a notice, and Debug builds render a payload
 * file (`-NetricsDebugPayload`, as on tvOS): on iPad in screen view sized to
 * the window (#412), on iPhone with NetricsUI's scroll view.
 */
@main
struct NetricsTVTouchApp: App {
    @State private var model = TouchModel()

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

@MainActor
@Observable
final class TouchModel {
    private(set) var state = DeviceState()
    /** The cache folder in the App Group container, from the first build on (ADR 0021, section 4). */
    let images: FileImageCache

    init() {
        let folder = CacheLocation.resolve(
            appGroup: Bundle.main.object(forInfoDictionaryKey: CacheLocation.appGroupInfoKey) as? String)
        images = FileImageCache.inFolder(folder)
    }

    var language: ScreenLanguage { state.payload?.language ?? .system() }

    func launch() {
        #if DEBUG
            if let path = UserDefaults.standard.string(forKey: "NetricsDebugPayload") {
                showFixture(path, images: UserDefaults.standard.string(forKey: "NetricsDebugImages"))
            }
        #endif
    }

    #if DEBUG
        /** Debug builds: a payload file shown as if paired, with no server and nothing in the Keychain. */
        private func showFixture(_ path: String, images folder: String?) {
            var state = DeviceState()
            do {
                state.payload = try JSONDecoder().decode(
                    DashboardPayload.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            } catch {
                state.phase = .blocked("Debug payload \(path): \(error)")
                self.state = state
                return
            }
            if let folder, case .v2(let payload) = state.payload {
                for image in payload.images {
                    let file = URL(fileURLWithPath: folder).appendingPathComponent(image.sha256)
                    guard let bytes = try? Data(contentsOf: file) else { continue }
                    images.store(bytes, sha256: image.sha256)
                    state.storedImages.insert(image.sha256)
                }
            }
            state.phase = .paired
            state.updatedAt = Date()
            self.state = state
        }
    #endif
}

struct TouchRootView: View {
    @Environment(TouchModel.self) private var model

    var body: some View {
        let language = model.language
        ZStack {
            Theme.background.ignoresSafeArea()
            if let payload = model.state.dashboardV2, payload.dashboard != nil {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    // iPad: screen view sized to the window, or scroll view by the device setting (#412).
                    PadDashboardView(state: model.state, payload: payload, images: model.images)
                } else {
                    ScrollDashboardView(state: model.state, payload: payload, images: model.images)
                }
            } else if case .blocked(let message) = model.state.phase {
                notice(text: message)
            } else {
                notice(text: L10n.tr("Pairing on iPhone and iPad comes with the next update.", language))
            }
        }
        .environment(\.screenLanguage, language)
        .environment(\.locale, language.locale)
    }

    private func notice(text: String) -> some View {
        VStack(spacing: 12) {
            Text(verbatim: "netrics TV")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: 520)
    }
}
