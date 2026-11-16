import Foundation

/**
 * The menu a single press of the clickpad shows over the dashboard on Apple
 * TV (#737), as the system's video players do: Pause or Resume (when the
 * slides rotate), Settings and the app version. It hides by itself
 * `hideAfter` seconds after the last press, or on Back; while it shows,
 * Back closes it instead of leaving the app. Press and hold the clickpad
 * (settings) and Play/Pause stay shortcuts.
 *
 * A value type driven by the time it is given, so tests need no clock.
 */
public struct RemoteMenu: Sendable, Equatable {
    /** Seconds after the last press before the menu hides by itself. */
    public static let hideAfter: TimeInterval = 5

    public enum Item: Hashable, Sendable {
        /** Pause or resume the rotation, by `paused`. */
        case pauseResume
        case settings
    }

    /** The last press while the menu shows; nil while it is hidden. */
    public private(set) var lastPress: Date?

    public init() {}

    public var isShown: Bool { lastPress != nil }

    /** When the menu hides by itself; nil while hidden. */
    public var hidesAt: Date? { lastPress?.addingTimeInterval(Self.hideAfter) }

    /** A single press of the clickpad on the dashboard. */
    public mutating func show(now: Date) {
        lastPress = now
    }

    /** A press while the menu shows (a move, Pause or Resume): its time starts again. */
    public mutating func pressed(now: Date) {
        guard isShown else { return }
        lastPress = now
    }

    public mutating func hide() {
        lastPress = nil
    }

    /** Hides the menu when its time is up; returns whether it did. */
    @discardableResult
    public mutating func expire(now: Date) -> Bool {
        guard let hidesAt, now >= hidesAt else { return false }
        lastPress = nil
        return true
    }

    /**
     * Back (Menu on older remotes): closes the menu and returns true while it
     * shows; false when it is hidden, so Back does what it always does.
     */
    public mutating func back() -> Bool {
        guard isShown else { return false }
        lastPress = nil
        return true
    }

    /** The menu's buttons in order: Pause or Resume only when the slides rotate. */
    public static func items(canPause: Bool) -> [Item] {
        canPause ? [.pauseResume, .settings] : [.settings]
    }
}

/**
 * The one-time hint "Press the clickpad for the menu" (#737): about
 * `delay` seconds after pairing, and once after each app update. What was
 * shown is kept by app version (and build), so a reinstall of the same
 * version does not show it again but every update does.
 */
public struct MenuHint: Sendable {
    /** Seconds after the dashboard appears before the hint shows. */
    public static let delay: TimeInterval = 8
    /** Seconds the hint stays. */
    public static let duration: TimeInterval = 6
    static let defaultsKey = "NetricsMenuHintShownFor"

    private let read: @Sendable () -> String?
    private let write: @Sendable (String) -> Void

    public init(read: @escaping @Sendable () -> String?, write: @escaping @Sendable (String) -> Void) {
        self.read = read
        self.write = write
    }

    /** Kept in the app's user defaults. */
    public static func standard() -> MenuHint {
        let key = defaultsKey
        return MenuHint(
            read: { UserDefaults.standard.string(forKey: key) },
            write: { UserDefaults.standard.set($0, forKey: key) })
    }

    /** "0.3.1 (42)": what an update changes, TestFlight builds included. */
    public static func versionKey(version: String, build: String) -> String {
        "\(version) (\(build))"
    }

    /** Whether the hint is due: right after a pairing, or not yet shown for this version. */
    public func isDue(version: String, justPaired: Bool) -> Bool {
        justPaired || read() != version
    }

    /** Takes the hint when due and records it for this version; returns whether to show it. */
    public func take(version: String, justPaired: Bool) -> Bool {
        guard isDue(version: version, justPaired: justPaired) else { return false }
        write(version)
        return true
    }
}
