import NetricsKit
import NetricsUI
import SwiftUI

/** Pause and Resume for the clickpad menu, when the slides rotate. */
struct RemotePause {
    var paused: Bool
    var toggle: () -> Void
}

extension View {
    /**
     * The Siri Remote on a paired dashboard (#737). A single press of the
     * clickpad shows a small menu at the bottom, as the system's video
     * players do: Pause or Resume (when the slides rotate), Settings and the
     * app version. It hides `RemoteMenu.hideAfter` seconds after the last
     * press, or on Back, which then does not leave the app. Press and hold
     * the clickpad opens the settings and Play/Pause pauses (or opens the
     * settings when there is nothing to rotate), as before.
     *
     * `move` gets left and right while the menu is hidden (the slides).
     * `hint` shows "Press the clickpad for the menu" until the menu opens.
     * Without `menu` (the demo) a single press does nothing.
     */
    func remoteMenu(
        menu enabled: Bool = true, rotation: ScreenRotation = .none, pause: RemotePause? = nil,
        hint: Binding<Bool> = .constant(false), move: ((MoveCommandDirection) -> Void)? = nil,
        openSettings: @escaping () -> Void
    ) -> some View {
        modifier(
            RemoteMenuModifier(
                enabled: enabled, rotation: rotation, pause: pause, hint: hint, move: move, openSettings: openSettings))
    }
}

private struct RemoteMenuModifier: ViewModifier {
    @Environment(\.screenLanguage) private var language
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let enabled: Bool
    let rotation: ScreenRotation
    let pause: RemotePause?
    @Binding var hint: Bool
    let move: ((MoveCommandDirection) -> Void)?
    let openSettings: () -> Void

    @State private var menu = RemoteMenu()
    /** The focused button as the app keeps it on a turned screen (as in the settings). */
    @State private var current: RemoteMenu.Item = .settings
    @FocusState private var focus: RemoteMenu.Item?

    private var items: [RemoteMenu.Item] { RemoteMenu.items(canPause: pause != nil) }

    private var animation: Animation? { reduceMotion ? nil : .easeInOut(duration: 0.2) }

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            // While the menu shows, its buttons take the focus.
            .focusable(!menu.isShown)
            .focusEffectDisabled()
            .onTapGesture {
                guard enabled else { return }
                show()
            }
            .onLongPressGesture(minimumDuration: 0.8) {
                hide()
                openSettings()
            }
            .overlay(alignment: .bottom) {
                if menu.isShown {
                    bar.transition(.opacity)
                } else if hint {
                    hintPill.transition(.opacity)
                }
            }
            // Below the menu's buttons too, so the commands reach these while one has the focus.
            .onPlayPauseCommand {
                if let pause {
                    pause.toggle()
                    menu.pressed(now: Date())
                } else {
                    hide()
                    openSettings()
                }
            }
            .onMoveCommand { press in
                guard menu.isShown else {
                    move?(press)
                    return
                }
                menu.pressed(now: Date())
                // A turned screen: the app moves the focus by the press as the viewer sees it.
                guard rotation.remapsFocus,
                    let next = FocusGrid([items]).target(from: current, press: FocusDirection(press))
                else { return }
                current = next
                focus = next
            }
            // Back closes the menu while it shows; otherwise it is the system's (leave the app).
            .onExitCommand(perform: menu.isShown ? { hide() } : nil)
            // A new payload that no longer rotates takes Pause away: the focus stays in the menu.
            .onChange(of: items) { _, next in
                guard menu.isShown, !next.contains(current) else { return }
                current = next[0]
                focus = current
            }
            .onChange(of: focus) { _, item in
                if let item {
                    current = item
                    menu.pressed(now: Date())
                }
            }
            .task(id: menu.hidesAt) {
                guard let due = menu.hidesAt else { return }
                try? await Task.sleep(for: .seconds(max(due.timeIntervalSinceNow, 0)))
                guard !Task.isCancelled else { return }
                withAnimation(animation) { _ = menu.expire(now: Date()) }
            }
    }

    private func show() {
        withAnimation(animation) {
            menu.show(now: Date())
            hint = false
        }
        current = items[0]
        // The buttons are in the view tree on the next update.
        Task { @MainActor in focus = current }
    }

    private func hide() {
        withAnimation(animation) { menu.hide() }
        focus = nil
    }

    /** The menu: plain, as the settings screen (#737); a redesign comes separately. */
    private var bar: some View {
        HStack(spacing: 40) {
            ForEach(items, id: \.self) { item in
                button(item)
            }
            Spacer(minLength: 40)
            Text(L10n.tr("Version %@", language, DeviceSession.appVersionAndBuild))
                .font(.system(size: 24))
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
        }
        .padding(.horizontal, 60)
        .padding(.vertical, 32)
        .background(Theme.tile.opacity(0.95), in: RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(Theme.tileBorder, lineWidth: 2))
        .padding(.horizontal, 80)
        .padding(.bottom, 60)
    }

    private func button(_ item: RemoteMenu.Item) -> some View {
        let button = Button(title(item)) {
            switch item {
            case .pauseResume:
                pause?.toggle()
                menu.pressed(now: Date())
            case .settings:
                hide()
                openSettings()
            }
        }
        .focused($focus, equals: item)
        // Upright, the focus engine moves between the buttons; turned, only the focused one can take focus.
        return Group {
            if rotation.remapsFocus {
                button.focusable(current == item)
            } else {
                button
            }
        }
    }

    private func title(_ item: RemoteMenu.Item) -> String {
        switch item {
        case .pauseResume:
            let paused = pause?.paused == true
            return L10n.tr(paused ? "Resume" : "Pause", language)
        case .settings:
            return L10n.tr("Settings", language)
        }
    }

    private var hintPill: some View {
        Text(L10n.tr("Press the clickpad for the menu", language))
            .font(.system(size: 26, weight: .medium))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 32)
            .padding(.vertical, 16)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 120)
            .allowsHitTesting(false)
    }
}
