import NetricsKit
import NetricsUI
import SwiftUI

/**
 * A schema 2 or 3 dashboard on Apple TV: NetricsUI's `SlideshowPlayer`
 * (slides in the screen's format, rotated by their durations) at the size
 * this view is given, which is the screen after the device's rotation
 * setting, with the Siri Remote's commands on top. Left and right change the
 * page, Play/Pause pauses the rotation (and opens the settings when there is
 * nothing to rotate), and pressing and holding the clickpad opens the
 * settings.
 */
struct SlideshowView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    let openSettings: () -> Void

    @State private var rotation: SlideRotation?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        SlideshowPlayer(state: state, payload: payload, images: images, rotation: $rotation)
            .contentShape(Rectangle())
            .focusable()
            .focusEffectDisabled()
            .onLongPressGesture(minimumDuration: 0.8, perform: openSettings)
            .onPlayPauseCommand {
                guard var next = rotation, next.rotates else {
                    openSettings()
                    return
                }
                next.togglePause(now: Date())
                rotation = next
            }
            .onMoveCommand { direction in
                guard var next = rotation, next.rotates else { return }
                switch direction {
                case .left: next.previous(now: Date())
                case .right: next.next(now: Date())
                default: return
                }
                withAnimation(SlideshowPlayer.animation(payload, reduceMotion: reduceMotion)) { rotation = next }
            }
    }
}
