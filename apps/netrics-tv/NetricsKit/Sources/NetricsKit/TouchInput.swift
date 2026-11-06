import Foundation

// Touch in screen view on iPad and iPhone (ADR 0021, "Touch instead of
// focus"; #414): the slideshow's commands, which a swipe, a chrome button
// or a VoiceOver action gives, as the Siri Remote's left, right and
// Play/Pause do on Apple TV; which drag is a swipe; and when the chrome
// (pause or resume, settings) hides again. Pure, so it is tested on a Mac.

/** What the viewer asks the slideshow to do. */
public enum SlideCommand: String, Sendable, Equatable, CaseIterable {
    case next, previous, togglePause
}

extension SlideRotation {
    /**
     * Carries out a command at `now`: next or previous starts that page's
     * time afresh (paused stays paused), Play/Pause holds or resumes the
     * page. Nothing happens when nothing rotates (one page, or
     * auto-advance off). Returns whether the page on screen changed, which
     * is when the change animates.
     */
    @discardableResult
    public mutating func perform(_ command: SlideCommand, now: Date) -> Bool {
        let before = currentID
        switch command {
        case .next: next(now: now)
        case .previous: previous(now: now)
        case .togglePause: togglePause(now: now)
        }
        return currentID != before
    }
}

/** A point or a size in points, without a UI framework. */
public struct TouchPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/**
 * Which drag is a swipe between pages. Horizontal, at least `distance`
 * points, clearly more sideways than up or down, and started away from the
 * window's edges, where the system has its own gestures: the back swipe and
 * Slide Over at the sides, Notification Centre and Control Centre at the
 * top, the home indicator at the bottom. Those drags are left to the system,
 * so screen view needs no `defersSystemGestures`.
 */
public enum TouchSwipe {
    /** How far a swipe travels sideways, in points. */
    public static let distance = 60.0
    /** How much more sideways than vertical it is. */
    public static let dominance = 1.5
    /** The band along the sides and the top that belongs to the system. */
    public static let edge = 24.0
    /** The band at the bottom (the home indicator). */
    public static let bottomEdge = 40.0

    /**
     * The command a drag gives, from where it started and how far it went
     * in a window of `size` points; nil when it is no swipe. Swiping left
     * (towards the start of the next page) is next, right is previous;
     * mirrored in a right-to-left layout.
     */
    public static func command(
        start: TouchPoint, translation: TouchPoint, size: TouchPoint, rightToLeft: Bool = false
    ) -> SlideCommand? {
        guard size.x > 0, size.y > 0 else { return nil }
        guard start.x >= edge, start.x <= size.x - edge, start.y >= edge, start.y <= size.y - bottomEdge else {
            return nil
        }
        let dx = translation.x
        let dy = translation.y
        guard dx.isFinite, dy.isFinite, abs(dx) >= distance, abs(dx) >= dominance * abs(dy) else { return nil }
        let towardsNext = rightToLeft ? dx > 0 : dx < 0
        return towardsNext ? .next : .previous
    }
}

/**
 * The chrome over screen view (pause or resume, settings): hidden while the
 * dashboard plays, shown by a tap away from a widget, and hidden again
 * `visibleFor` seconds after the last touch on it. While VoiceOver or
 * Switch Control runs it stays (`pinned`), so its buttons can always be
 * reached. A value driven by the time it is given, so tests need no clock.
 */
public struct TouchChrome: Sendable, Equatable {
    /** How long the chrome stays after it was shown or used. */
    public static let visibleFor: TimeInterval = 4

    /** Until when it shows; nil while hidden. */
    public private(set) var shownUntil: Date?

    public init() {}

    /** Shows it (again) for `visibleFor` from `now`: a tap, or a press on one of its buttons. */
    public mutating func show(now: Date) {
        shownUntil = now.addingTimeInterval(Self.visibleFor)
    }

    public mutating func hide() {
        shownUntil = nil
    }

    /** A tap away from a widget: shows the chrome, or hides it when it shows. */
    public mutating func toggle(now: Date) {
        if isVisible(at: now) {
            hide()
        } else {
            show(now: now)
        }
    }

    public func isVisible(at now: Date, pinned: Bool = false) -> Bool {
        if pinned { return true }
        guard let shownUntil else { return false }
        return now < shownUntil
    }

    /** When it hides by itself; nil when it shows for good (pinned) or is hidden. */
    public func hidesAt(pinned: Bool = false) -> Date? {
        pinned ? nil : shownUntil
    }
}
