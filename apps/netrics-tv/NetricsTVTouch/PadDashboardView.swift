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
 * the foreground; scroll view follows Auto-Lock. Touch (swipe, widget
 * details, chrome) is `TouchSlideshowView`'s (#414).
 */
struct PadDashboardView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    let actions: TouchActions

    @State private var rotation: SlideRotation?
    @State private var window = CGSize.zero

    var body: some View {
        let mode = TouchScreen.displayMode(payload, device: .pad, window: StudioCanvas(window))
        Group {
            switch mode {
            case .screen:
                TouchSlideshowView(
                    state: state, payload: payload, images: images, rotation: $rotation, actions: actions
                )
                .statusBarHidden()
                .persistentSystemOverlays(.hidden)
            case .scroll:
                TouchScrollView(state: state, payload: payload, images: images, refresh: nil, actions: actions)
            }
        }
        .keepsScreenOn(in: mode)
        .measuresWindow($window)
        #if DEBUG
            .modifier(PadDebugDriver())
        #endif
    }
}

extension StudioCanvas {
    init(_ size: CGSize) {
        self.init(width: Double(size.width), height: Double(size.height))
    }
}

extension View {
    /**
     * The view's size in points, now and on every change (rotation,
     * resizing). Inside the safe areas, which keeps the aspect: wider than
     * high exactly when the window is.
     */
    func measuresWindow(_ size: Binding<CGSize>) -> some View {
        background {
            Color.clear
                .ignoresSafeArea()
                .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { size.wrappedValue = $0 })
        }
    }

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
            .onChange(of: TouchScreen.keepsScreenOn(mode: mode, foreground: scenePhase == .active), initial: true) {
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
