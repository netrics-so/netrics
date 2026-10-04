import Foundation

/**
 * Which slide a screen shows (ADR 0015, section 7): rotation is local.
 * Each slide stays for its `durationSec`, then the next one follows, after
 * the last the first. A new payload keeps the current slide when its id is
 * still there (and its time on screen), else it starts at the first. With
 * `autoAdvance` off only the first slide shows. The remote moves to the
 * next or previous slide, which starts that slide's time afresh; pausing
 * holds the current slide until it is resumed.
 *
 * A value type driven by the time it is given, so tests need no clock.
 */
public struct SlideRotation: Sendable, Equatable {
    public struct Slide: Sendable, Equatable {
        public var id: String
        public var durationSec: Int

        public init(id: String, durationSec: Int) {
            self.id = id
            self.durationSec = durationSec
        }
    }

    public private(set) var slides: [Slide]
    public private(set) var autoAdvance: Bool
    /** Index into `slides`; 0 when there are none. */
    public private(set) var index: Int = 0
    /** When the current slide's time started (moved forward while paused). */
    public private(set) var shownSince: Date
    /** Set while paused: when the pause began. */
    public private(set) var pausedAt: Date?

    public init(slides: [Slide], autoAdvance: Bool, now: Date) {
        self.slides = slides
        self.autoAdvance = autoAdvance
        shownSince = now
    }

    public init(_ payload: DeviceDashboardV2, now: Date) {
        self.init(slides: Self.slides(payload), autoAdvance: payload.rotation.autoAdvance, now: now)
    }

    static func slides(_ payload: DeviceDashboardV2) -> [Slide] {
        payload.slides.map { Slide(id: $0.id, durationSec: max($0.durationSec, 1)) }
    }

    public var currentID: String? { slides.isEmpty ? nil : slides[index].id }

    public var isPaused: Bool { pausedAt != nil }

    /** Whether slides change at all: more than one, and auto-advance on. */
    public var rotates: Bool { autoAdvance && slides.count > 1 }

    /** When the current slide is due to change; nil when it does not. */
    public func nextChange() -> Date? {
        guard rotates, pausedAt == nil else { return nil }
        return shownSince.addingTimeInterval(TimeInterval(slides[index].durationSec))
    }

    /**
     * Advances past every slide whose time is up by `now` (a screen that
     * slept skips ahead as if it had rotated). Returns whether the slide
     * changed.
     */
    @discardableResult
    public mutating func advance(to now: Date) -> Bool {
        guard rotates, pausedAt == nil else { return false }
        let before = index
        // Bounded: one lap at most per call after skipping whole laps.
        let lap = slides.reduce(0) { $0 + TimeInterval($1.durationSec) }
        var elapsed = now.timeIntervalSince(shownSince)
        guard elapsed >= TimeInterval(slides[index].durationSec) else { return false }
        if lap > 0, elapsed >= lap * 2 {
            let laps = (elapsed / lap).rounded(.down) - 1
            shownSince = shownSince.addingTimeInterval(laps * lap)
            elapsed -= laps * lap
        }
        while elapsed >= TimeInterval(slides[index].durationSec) {
            let duration = TimeInterval(slides[index].durationSec)
            shownSince = shownSince.addingTimeInterval(duration)
            elapsed -= duration
            index = (index + 1) % slides.count
        }
        return index != before
    }

    /** The remote: the next slide, its time starting now. */
    public mutating func next(now: Date) {
        move(by: 1, now: now)
    }

    /** The remote: the previous slide, its time starting now. */
    public mutating func previous(now: Date) {
        move(by: -1, now: now)
    }

    private mutating func move(by step: Int, now: Date) {
        guard rotates else { return }
        index = ((index + step) % slides.count + slides.count) % slides.count
        shownSince = now
        if pausedAt != nil {
            pausedAt = now
        }
    }

    /** Play/Pause: holds the slide, or resumes with the time it had left. */
    public mutating func togglePause(now: Date) {
        guard rotates else { return }
        if let pausedAt {
            shownSince = shownSince.addingTimeInterval(max(0, now.timeIntervalSince(pausedAt)))
            self.pausedAt = nil
        } else {
            pausedAt = now
        }
    }

    /**
     * A new payload: keeps the current slide (and its time) when its id is
     * still there, else the first slide from now.
     */
    public mutating func update(_ payload: DeviceDashboardV2, now: Date) {
        update(slides: Self.slides(payload), autoAdvance: payload.rotation.autoAdvance, now: now)
    }

    public mutating func update(slides next: [Slide], autoAdvance: Bool, now: Date) {
        let current = currentID
        let wasRotating = rotates
        slides = next
        self.autoAdvance = autoAdvance
        if !autoAdvance {
            // Only the first slide shows.
            index = 0
            shownSince = now
            pausedAt = nil
            return
        }
        if let current, let kept = next.firstIndex(where: { $0.id == current }) {
            index = kept
            if !wasRotating {
                shownSince = now
            }
        } else {
            index = 0
            shownSince = now
        }
        if !rotates {
            pausedAt = nil
        }
    }
}
