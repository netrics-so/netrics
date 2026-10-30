import Foundation

// netrics TV on iPad (ADR 0021, section 3; #412): which view a dashboard
// gets and in which format. An iPad knows its orientation, so the format
// comes from the window's size as it is (full screen, Split View, Slide Over
// or a Stage Manager window), recomputed on every change like the browser
// kiosk; the device's rotation setting is for Apple TV and kiosks and is
// ignored here. Pure, so it is tested on a Mac.

public enum PadScreen {
    /**
     * The view an iPad shows: the device setting from schema 3 (`scroll`
     * for an iPad used in the hand), else screen view, as on the TV.
     */
    public static func displayMode(_ payload: DeviceDashboardV2) -> DisplayMode {
        payload.schema >= 3 ? payload.device.displayMode : .screen
    }

    /** The format of a window of this size (points): never turned by the rotation setting. */
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
     * modes) and the mode shown.
     */
    public static func report(window: StudioCanvas, scale: Double, payload: DeviceDashboardV2?) -> DeviceScreenReport? {
        let mode = payload.map(displayMode) ?? .screen
        let format = payload.map { self.format($0, window: window) } ?? .widescreen
        return DeviceScreenReport.measured(
            width: window.width, height: window.height, scale: scale, format: format.rawValue, mode: mode.rawValue)
    }
}
