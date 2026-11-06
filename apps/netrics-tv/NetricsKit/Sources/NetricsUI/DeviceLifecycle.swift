import NetricsKit
import SwiftUI

extension View {
    /**
     * Ties the device session to the scene (ADR 0021, section 3): in the
     * background its client stops polling and heartbeats; back in the
     * foreground it goes on at once with the same pairing, or refreshes the
     * tokens when due, polls with `If-None-Match` and sends a heartbeat, with
     * the last dashboard on screen meanwhile. Inactive (Control Center, the
     * app switcher, a call banner) keeps it running.
     */
    public func deviceLifecycle(_ session: DeviceSession) -> some View {
        modifier(DeviceLifecycleModifier(session: session))
    }
}

private struct DeviceLifecycleModifier: ViewModifier {
    let session: DeviceSession
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.onChange(of: scenePhase == .background, initial: true) { _, background in
            if background {
                session.enterBackground()
            } else {
                session.enterForeground()
            }
        }
    }
}
