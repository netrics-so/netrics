import NetricsKit
import NetricsUI
import SwiftUI

/**
 * Screen view on iPhone and iPad with touch on top of NetricsUI's
 * `SlideshowPlayer` (ADR 0021, "Touch instead of focus"; #414), the
 * counterpart of the Siri Remote on Apple TV and on the same commands
 * (`SlideRotation.perform`):
 *
 * - Swiping left or right changes the page and starts its time afresh.
 *   Drags that start at the window's edges are left to the system (back
 *   swipe, Slide Over, Control Centre, the home indicator; `TouchSwipe`).
 * - Tapping a widget with numbers opens its detail sheet, from the payload
 *   only.
 * - Tapping anywhere else shows the chrome (pause or resume, settings, or
 *   "Leave demo" in the demo) for a few seconds (`TouchChrome`); it also
 *   shows for a moment when the dashboard opens, so the way to settings is
 *   seen once. While VoiceOver or Switch Control runs it stays.
 * - VoiceOver has next, previous and pause as actions on every widget.
 *
 * Page changes fade, or switch at once with Reduce Motion, as on the TV.
 */
struct TouchSlideshowView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    @Binding var rotation: SlideRotation?
    let actions: TouchActions

    @State private var chrome = TouchChrome()
    @State private var detail: WidgetDetailSelection?
    @State private var size = CGSize.zero
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilitySwitchControlEnabled) private var switchControl
    @Environment(\.layoutDirection) private var layoutDirection

    private var language: ScreenLanguage { payload.language }
    private var pinned: Bool { voiceOver || switchControl }
    private var rotates: Bool { rotation?.rotates ?? false }

    var body: some View {
        SlideshowPlayer(
            state: state, payload: payload, images: images, rotation: $rotation, interaction: interaction
        )
        .contentShape(Rectangle())
        .onTapGesture { update { $0.toggle(now: Date()) } }
        .simultaneousGesture(swipe)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { size = $0 })
        .overlay(alignment: .bottomTrailing) {
            if chrome.isVisible(at: Date(), pinned: pinned) {
                chromeBar
                    .padding()
                    .transition(.opacity)
            }
        }
        .onAppear { update { $0.show(now: Date()) } }
        // One timer per showing: re-armed whenever the chrome is shown again.
        .task(id: chrome.hidesAt(pinned: pinned)) {
            guard let due = chrome.hidesAt(pinned: pinned) else { return }
            try? await Task.sleep(for: .seconds(max(due.timeIntervalSinceNow, 0)))
            guard !Task.isCancelled else { return }
            update { $0.hide() }
        }
        .sheet(item: $detail) { selection in
            WidgetDetailSheet(widget: current(selection.widget), language: language)
        }
    }

    private var interaction: WidgetInteraction {
        WidgetInteraction(
            openWidget: { widget in detail = WidgetDetailSelection(widget: widget) },
            actions: rotates
                ? [
                    .init(name: L10n.tr("Next slide", language)) { perform(.next) },
                    .init(name: L10n.tr("Previous slide", language)) { perform(.previous) },
                    .init(
                        name: L10n.tr(rotation?.isPaused == true ? "Resume rotation" : "Pause rotation", language)
                    ) { perform(.togglePause) },
                ] : [])
    }

    /** The widget as the latest payload has it (a refresh while the sheet is open), else as it was tapped. */
    private func current(_ widget: DeviceWidget) -> DeviceWidget {
        payload.slides.lazy.flatMap(\.widgets).first { $0.id == widget.id } ?? widget
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                guard
                    let command = TouchSwipe.command(
                        start: TouchPoint(x: value.startLocation.x, y: value.startLocation.y),
                        translation: TouchPoint(x: value.translation.width, y: value.translation.height),
                        size: TouchPoint(x: size.width, y: size.height),
                        rightToLeft: layoutDirection == .rightToLeft)
                else { return }
                perform(command)
            }
    }

    private func perform(_ command: SlideCommand) {
        guard var next = rotation, next.rotates else { return }
        let changed = next.perform(command, now: Date())
        if changed {
            withAnimation(SlideshowPlayer.animation(payload, reduceMotion: reduceMotion)) { rotation = next }
        } else {
            rotation = next
        }
    }

    private func update(_ change: (inout TouchChrome) -> Void) {
        var next = chrome
        change(&next)
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { chrome = next }
    }

    /** Pause or resume (when the slides rotate), then settings or "Leave demo". */
    private var chromeBar: some View {
        HStack(spacing: 12) {
            if rotates {
                let paused = rotation?.isPaused ?? false
                Button {
                    perform(.togglePause)
                    update { $0.show(now: Date()) }
                } label: {
                    Image(systemName: paused ? "play.fill" : "pause.fill")
                        .font(.title3)
                        .frame(width: 28, height: 28)
                        .padding(6)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel(L10n.tr(paused ? "Resume rotation" : "Pause rotation", language))
            }
            TouchSettingsButton(actions: actions, language: language)
        }
    }
}

/** The widget whose detail sheet is open. */
struct WidgetDetailSelection: Identifiable {
    let widget: DeviceWidget
    var id: String { widget.id }
}

/** What the dashboard's controls do: open settings, or leave the demo there. */
struct TouchActions {
    let openSettings: () -> Void
    /** Set in the demo: the button leaves it instead of opening settings. */
    var leaveDemo: (() -> Void)? = nil
}

/** The gear that opens settings, or "Leave demo" in the demo (#416). */
struct TouchSettingsButton: View {
    let actions: TouchActions
    let language: ScreenLanguage

    var body: some View {
        if let leaveDemo = actions.leaveDemo {
            Button(action: leaveDemo) {
                Label(L10n.tr("Leave demo", language), systemImage: "xmark")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.glass)
        } else {
            Button(action: actions.openSettings) {
                Image(systemName: "gearshape")
                    .font(.title3)
                    .frame(width: 28, height: 28)
                    .padding(6)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel(L10n.tr("Settings", language))
        }
    }
}
