import Foundation

// netrics TV on iPad and iPhone (ADR 0021, section 3; #412, #413): which
// view a dashboard gets and in which format. A touch device knows its
// orientation, so the format comes from the window's size as it is (full
// screen, Split View, Slide Over or a Stage Manager window on iPad; the
// phone turned either way), recomputed on every change like the browser
// kiosk; the device's rotation setting is for Apple TV and kiosks and is
// ignored here. Everything is local, so turning the device switches at once,
// offline too. Pure, so it is tested on a Mac.

/** The kind of touch device: the rules for the view differ (ADR 0021, section 3). */
public enum TouchDevice: String, Sendable, Equatable, CaseIterable {
    case pad, phone
}

public enum TouchScreen {
    /**
     * The view a dashboard shows in a window of this size (points).
     *
     * - iPad: the device setting from schema 3 (`scroll` for an iPad used
     *   in the hand), else screen view, as on the TV; in both orientations.
     * - iPhone: screen view in landscape, scroll view in portrait; the
     *   device setting `screen` keeps screen view in portrait too (a phone
     *   on a desk stand). Schema 2 knows no setting: the phone default.
     *
     * `demo`: the bundled demo (#416) is one payload for every device, so its
     * setting is ignored and each device shows its own default.
     */
    public static func displayMode(
        _ payload: DeviceDashboardV2, device: TouchDevice, window: StudioCanvas, demo: Bool = false
    ) -> DisplayMode {
        let setting: DisplayMode? = payload.schema >= 3 && !demo ? payload.device.displayMode : nil
        switch device {
        case .pad:
            return setting ?? .screen
        case .phone:
            if setting == .screen || isLandscape(window) { return .screen }
            return .scroll
        }
    }

    /** A window wider than high: a phone turned on its side. */
    public static func isLandscape(_ window: StudioCanvas) -> Bool {
        window.width.isFinite && window.height.isFinite && window.width > window.height
    }

    /**
     * The format of a window of this size (points): never turned by the
     * rotation setting. A landscape iPhone is `21x9` (about 2.16; `16x9` on
     * the 16:9 iPhone SE), a portrait one `9x16`, an iPad `4x3` or `3x4`.
     */
    public static func format(_ payload: DeviceDashboardV2, window: StudioCanvas) -> ScreenFormat {
        ScreenView.format(payload, viewport: window)
    }

    /**
     * Whether the screen stays on: in screen view while the app is in the
     * foreground. Scroll view follows the system's Auto-Lock.
     */
    public static func keepsScreenOn(mode: DisplayMode, foreground: Bool) -> Bool {
        mode == .screen && foreground
    }

    /**
     * What the heartbeat reports (ADR 0017, section 7): the window's size,
     * the scale, the window's format (as the web kiosk reports it in both
     * modes) and the mode in use. Before a dashboard: the device's default
     * view for the window.
     */
    public static func report(
        window: StudioCanvas, scale: Double, payload: DeviceDashboardV2?, device: TouchDevice
    ) -> DeviceScreenReport? {
        let mode =
            payload.map { displayMode($0, device: device, window: window) }
            ?? (device == .phone && !isLandscape(window) ? .scroll : .screen)
        let format = payload.map { self.format($0, window: window) } ?? StudioLayout.formatFor(
            width: window.width, height: window.height)
        return DeviceScreenReport.measured(
            width: window.width, height: window.height, scale: scale, format: format.rawValue, mode: mode.rawValue)
    }
}
