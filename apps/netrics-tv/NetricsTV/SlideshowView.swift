import NetricsKit
import NetricsUI
import SwiftUI

/**
 * A schema 2 or 3 dashboard on Apple TV: NetricsUI's `SlideshowPlayer`
 * (slides in the screen's format, rotated by their durations) at the size
 * this view is given, which is the screen after the device's rotation
 * setting, with the Siri Remote's commands on top (`remoteMenu`). Left and
 * right change the page, a single press of the clickpad shows the menu
 * (Pause or Resume, Settings, the version; not in the demo), Play/Pause
 * pauses the rotation (and opens the settings when there is nothing to
 * rotate), and pressing and holding the clickpad opens the settings.
 */
struct SlideshowView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    /** The clickpad menu (#737); off in the demo, which has its own. */
    var menu = true
    var rotationSetting: ScreenRotation = .none
    var hint: Binding<Bool> = .constant(false)
    let openSettings: () -> Void

    @State private var rotation: SlideRotation?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var pause: RemotePause? {
        guard let current = rotation, current.rotates else { return nil }
        return RemotePause(paused: current.isPaused) {
            guard var next = rotation, next.rotates else { return }
            next.togglePause(now: Date())
            rotation = next
        }
    }

    var body: some View {
        SlideshowPlayer(state: state, payload: payload, images: images, rotation: $rotation)
            .remoteMenu(
                menu: menu, rotation: rotationSetting, pause: pause, hint: hint, move: move,
                openSettings: openSettings)
    }

    private func move(_ direction: MoveCommandDirection) {
        guard var next = rotation, next.rotates else { return }
        switch direction {
        case .left: next.previous(now: Date())
        case .right: next.next(now: Date())
        default: return
        }
        withAnimation(SlideshowPlayer.animation(payload, reduceMotion: reduceMotion)) { rotation = next }
    }
}
