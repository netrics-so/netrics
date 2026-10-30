import NetricsKit
import NetricsUI
import SwiftUI
import UIKit

/**
 * A schema 2 or 3 dashboard on iPad (ADR 0021, section 3; #412). Screen view
 * by default, as on the TV: NetricsUI's `SlideshowPlayer` over the whole
 * window, its format taken from the window's size and recomputed on every
 * size change (rotation, Split View, Slide Over, Stage Manager windows of any
 * size), offline too since it is local. The device's rotation setting is
 * ignored: an iPad knows its orientation. The device setting
 * `display_mode = scroll` gives NetricsUI's scroll view instead, for an iPad
 * used in the hand. The screen stays on in screen view while the app is in
 * the foreground; scroll view follows Auto-Lock.
 */
struct PadDashboardView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache

    @State private var rotation: SlideRotation?

    var body: some View {
        let mode = PadScreen.displayMode(payload)
        Group {
            switch mode {
            case .screen:
                SlideshowPlayer(state: state, payload: payload, images: images, rotation: $rotation)
                    .statusBarHidden()
                    .persistentSystemOverlays(.hidden)
            case .scroll:
                ScrollDashboardView(state: state, payload: payload, images: images)
            }
        }
        .keepsScreenOn(in: mode)
        #if DEBUG
            .modifier(PadDebugDriver())
        #endif
    }
}

extension View {
    /**
     * Turns the idle timer off in screen view while the app is in the
     * foreground (`isIdleTimerDisabled`), and back on otherwise and when the
     * view goes away, so the system's Auto-Lock applies again.
     */
    func keepsScreenOn(in mode: DisplayMode) -> some View {
        modifier(KeepsScreenOn(mode: mode))
    }
}

private struct KeepsScreenOn: ViewModifier {
    let mode: DisplayMode
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: PadScreen.keepsScreenOn(mode: mode, foreground: scenePhase == .active), initial: true) {
                _, keepOn in
                set(keepOn)
            }
            .onDisappear { set(false) }
    }

    private func set(_ keepOn: Bool) {
        UIApplication.shared.isIdleTimerDisabled = keepOn
        #if DEBUG
            print("netrics: idle timer disabled = \(keepOn)")
        #endif
    }
}
