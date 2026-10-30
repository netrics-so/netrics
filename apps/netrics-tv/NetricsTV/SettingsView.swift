import NetricsKit
import SwiftUI

/**
 * Reached with the Siri Remote (press and hold the clickpad, or Play/Pause
 * on the dashboard; the Settings button while pairing). Shows what this TV
 * is connected to; Unpair clears the Keychain and the cache and starts
 * pairing with netrics cloud again (another server is one button away).
 *
 * Once paired, settings turn with the content by the device's rotation
 * setting (#298); the pairing screen and its settings stay upright
 * (`ScreenView.settingsRotation`). The tvOS focus engine moves focus along
 * the panel, so on a turned screen only the focused button is focusable
 * and the app moves focus itself, by the press in the content's frame
 * (`FocusGrid`): up on the remote is up as the viewer sees it. The system's
 * confirmation dialog cannot turn, so a turned screen asks in place.
 */
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language
    let rotation: ScreenRotation
    let close: () -> Void
    @State private var confirmUnpair = false
    /** The focused button as the app keeps it on a turned screen. */
    @State private var current: Item = .done
    @FocusState private var focus: Item?

    enum Item: Hashable, Sendable { case done, unpair, confirmUnpair, cancel }

    /** The buttons as the content lays them out, for the app's own focus moves. */
    private var grid: FocusGrid<Item> {
        FocusGrid(asksInPlace ? [[.confirmUnpair, .cancel]] : [[.done, .unpair]])
    }

    /** A turned screen asks to unpair in place, not in the system dialog. */
    private var asksInPlace: Bool { rotation.remapsFocus && confirmUnpair }

    var body: some View {
        RotatedScreen(rotation: rotation) {
            GeometryReader { frame in
                content(narrow: frame.size.width < frame.size.height)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .onExitCommand {
            if asksInPlace {
                endConfirm()
            } else {
                close()
            }
        }
        .onMoveCommand { press in
            guard rotation.remapsFocus, let next = grid.target(from: current, press: FocusDirection(press)) else {
                return
            }
            move(to: next)
        }
        .onChange(of: focus) { _, item in
            if let item { current = item }
        }
        .onAppear { focus = current }
    }

    private var unpairMessage: String {
        L10n.tr("This TV forgets its server and credentials and shows a new pairing code for netrics cloud.", language)
    }

    private func content(narrow: Bool) -> some View {
        let state = model.device
        return VStack(alignment: .leading, spacing: 40) {
            Text(L10n.tr("Settings", language))
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)

            VStack(alignment: .leading, spacing: narrow ? 28 : 22) {
                if let server = model.server {
                    Row(label: L10n.tr("Server", language), value: server.kind == .cloud ? L10n.tr("netrics cloud", language) : L10n.tr("Your own server", language), narrow: narrow)
                    if server.kind == .custom {
                        Row(label: L10n.tr("Address", language), value: server.baseURL.absoluteString, narrow: narrow)
                    }
                    Row(
                        label: L10n.tr("Insecure connections", language),
                        value: server.policy.allowInsecureConnections ? L10n.tr("On (not recommended)", language) : L10n.tr("Off", language),
                        warning: server.policy.allowInsecureConnections, narrow: narrow
                    )
                    if let pin = server.pinnedCertificateSHA256 {
                        Row(label: L10n.tr("Pinned certificate", language), value: "SHA-256 " + CertificatePinning.display(pin), small: true, narrow: narrow)
                    }
                }
                Row(label: L10n.tr("This TV", language), value: state.device?.name ?? (state.phase == .pairing ? L10n.tr("Not paired yet", language) : "—"), narrow: narrow)
                Row(label: L10n.tr("App version", language), value: AppModel.appVersion, narrow: narrow)
                if let error = state.lastError, state.offline {
                    Row(label: L10n.tr("Last error", language), value: error, small: true, narrow: narrow)
                }
            }

            if asksInPlace {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n.tr("Unpair this TV?", language))
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(unpairMessage)
                        .font(.system(size: 24))
                        .foregroundStyle(Theme.muted)
                }
                HStack(spacing: 40) {
                    button(.confirmUnpair, L10n.tr("Unpair", language), role: .destructive, action: unpair)
                    button(.cancel, L10n.tr("Cancel", language), action: endConfirm)
                }
            } else {
                Text(L10n.tr("The server can be changed only by unpairing. After unpairing, remove this TV under TVs in netrics.", language))
                    .font(.system(size: 24))
                    .foregroundStyle(Theme.muted)

                HStack(spacing: 40) {
                    button(.done, L10n.tr("Done", language), action: close)
                    button(.unpair, L10n.tr("Unpair this TV", language), role: .destructive, action: startConfirm)
                }
            }
        }
        .padding(.horizontal, narrow ? 80 : 200)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        // Upright only: the system dialog cannot turn, so a turned screen asks in place.
        .confirmationDialog(
            L10n.tr("Unpair this TV?", language),
            isPresented: Binding(get: { confirmUnpair && !rotation.remapsFocus }, set: { confirmUnpair = $0 }),
            titleVisibility: .visible
        ) {
            Button(L10n.tr("Unpair", language), role: .destructive, action: unpair)
            Button(L10n.tr("Cancel", language), role: .cancel) {}
        } message: {
            Text(unpairMessage)
        }
    }

    /**
     * A settings button. On a turned screen only the focused one can take
     * focus, so the focus engine has nowhere to go along the panel and the
     * press reaches `onMoveCommand`.
     */
    private func button(
        _ item: Item, _ title: String, role: ButtonRole? = nil, action: @escaping () -> Void
    ) -> some View {
        let button = Button(title, role: role, action: action).focused($focus, equals: item)
        // Upright, the buttons are left to the focus engine as they are.
        return Group {
            if rotation.remapsFocus {
                button.focusable(current == item)
            } else {
                button
            }
        }
    }

    /**
     * Moves focus to a button. The button becomes focusable first; when it
     * has just appeared (asking in place, or back), focus follows on the
     * next update, once it is in the view tree.
     */
    private func move(to item: Item, appearing: Bool = false) {
        current = item
        guard appearing else {
            focus = item
            return
        }
        Task { @MainActor in focus = item }
    }

    private func startConfirm() {
        confirmUnpair = true
        // In place, focus starts on Cancel, as the system dialog's does.
        if rotation.remapsFocus { move(to: .cancel, appearing: true) }
    }

    private func endConfirm() {
        confirmUnpair = false
        move(to: .unpair, appearing: true)
    }

    private func unpair() {
        Task {
            close()
            await model.unpair()
        }
    }
}

extension FocusDirection {
    /** A press on the Siri Remote, as SwiftUI reports it (the viewer's frame). */
    init(_ press: MoveCommandDirection) {
        switch press {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        default: self = .right
        }
    }
}

private struct Row: View {
    let label: String
    let value: String
    var warning = false
    var small = false
    /** A portrait screen: the label above its value. */
    var narrow = false

    var body: some View {
        let layout = narrow
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 40))
        layout {
            Text(label)
                .foregroundStyle(Theme.muted)
                .frame(width: narrow ? nil : 420, alignment: .leading)
            Text(value)
                .foregroundStyle(warning ? Theme.warning : Theme.text)
                .font(.system(size: small ? 22 : 30))
                .lineLimit(2)
        }
        .font(.system(size: 30))
    }
}
