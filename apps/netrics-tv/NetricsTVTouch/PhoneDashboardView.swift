import NetricsKit
import NetricsUI
import SwiftUI

/**
 * A schema 2 or 3 dashboard on iPhone (ADR 0021, section 3; #413). Portrait
 * shows the scroll view (NetricsUI's `ScrollDashboardView`: the web's scroll
 * cards, Dynamic Type, pull to refresh); landscape shows screen view full
 * screen in the phone's format (`21x9`, `16x9` on an iPhone SE) with the
 * slides rotating and the screen kept on. The device setting
 * `display_mode = screen` keeps screen view in portrait too (`9x16`, a phone
 * on a desk stand). The mode comes from the window's size (`TouchScreen`),
 * so turning the phone switches at once, offline too; the slideshow's
 * rotation is kept here, so it goes on where it was when the phone turns back.
 */
struct PhoneDashboardView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    /** Pull to refresh in scroll view; nil offers none (the demo). */
    let refresh: (@MainActor () async -> Void)?

    @State private var rotation: SlideRotation?
    @State private var window = CGSize.zero
    @Environment(\.demoMode) private var demo

    var body: some View {
        // The demo shows the phone's default: scroll view in portrait, screen view in landscape.
        let mode = TouchScreen.displayMode(payload, device: .phone, window: StudioCanvas(window), demo: demo)
        Group {
            switch mode {
            case .screen:
                SlideshowPlayer(state: state, payload: payload, images: images, rotation: $rotation)
                    .statusBarHidden()
                    .persistentSystemOverlays(.hidden)
            case .scroll:
                ScrollDashboardView(state: state, payload: payload, images: images, refresh: refresh)
            }
        }
        .keepsScreenOn(in: mode)
        .measuresWindow($window)
        #if DEBUG
            .onChange(of: mode, initial: true) { _, mode in
                print("netrics: phone \(Int(window.width))×\(Int(window.height)) shows \(mode.rawValue)")
            }
            .modifier(PhoneDebugDriver())
        #endif
    }
}
