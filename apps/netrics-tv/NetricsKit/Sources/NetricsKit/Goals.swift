import Foundation

// What a goal widget shows (ADR 0019 section 5), a port of goalReached,
// goalPercent and goalTimeText in packages/domain/src/goals.ts. Both sides
// run the vectors in packages/domain/test-vectors/studio-layout.json
// (`goalPercents`, `goalTimeTexts`).

/** The time part of a goal's progress line, for the screen to word. */
public enum GoalTimeText: Sendable, Equatable {
    /** "9 days left". */
    case days(Int)
    case lastDay
    /** "5 h left" (a goal for today). */
    case hours(Int)
    case underHour
    /** "2 days early" (reached). */
    case early(Int)
}

public enum Goals {
    /** Progress at or above the target. */
    public static func reached(_ progress: Double?) -> Bool {
        guard let progress, progress.isFinite else { return false }
        return progress >= 1
    }

    /**
     * The whole percent shown: rounded down, never 100 before the goal is
     * reached (99.9 % is 99); 1.224 is 122. Nil without progress.
     */
    public static func percent(_ progress: Double?) -> Int? {
        guard let progress, progress.isFinite else { return nil }
        let percent = Int((progress * 100 + 1e-9).rounded(.down))
        return progress < 1 ? Swift.min(99, Swift.max(0, percent)) : percent
    }

    /** The calendar of the zone (UTC when the zone is unknown). */
    static func calendar(_ timeZone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZone) ?? TimeZone(identifier: "UTC")!
        return calendar
    }

    /** Whole days between the civil dates of two instants in the zone. */
    static func daysBetween(_ from: Date, _ to: Date, calendar: Calendar) -> Int {
        let a = calendar.dateComponents([.year, .month, .day], from: from)
        let b = calendar.dateComponents([.year, .month, .day], from: to)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard let start = utc.date(from: a), let end = utc.date(from: b) else { return 0 }
        return Int((end.timeIntervalSince(start) / 86_400).rounded())
    }

    /**
     * What a goal widget says about time, from the payload and the screen's
     * own clock (goalTimeText): whole days after today until the period
     * ends, "last day"; for `today` whole hours, "< 1 h"; once reached the
     * whole days after the day it was reached ("early"), not for `today`.
     * Nil when there is nothing to say.
     */
    public static func timeText(
        period: String, periodEnd: String, reachedAt: String?, progress: Double?, now: Date, timeZone: String
    ) -> GoalTimeText? {
        guard progress != nil, let end = ISODate.parse(periodEnd) else { return nil }
        let calendar = calendar(timeZone)
        if reached(progress) {
            guard period != "today", let reachedAt, let at = ISODate.parse(reachedAt) else { return nil }
            let days = daysBetween(at, end, calendar: calendar) - 1
            return days >= 1 ? .early(days) : nil
        }
        let left = end.timeIntervalSince(now)
        if left <= 0 { return nil }
        if period == "today" {
            let hours = Int((left / 3600).rounded(.down))
            return hours >= 1 ? .hours(hours) : .underHour
        }
        let days = daysBetween(now, end, calendar: calendar) - 1
        return days >= 1 ? .days(days) : .lastDay
    }

    /** The time part worded: "9 days left", "last day", "5 h left", "2 days early". */
    public static func words(_ text: GoalTimeText, language: ScreenLanguage) -> String {
        switch text {
        case .days(let days):
            return days == 1
                ? KitStrings.text(.goalDaysLeftOne, language) : KitStrings.text(.goalDaysLeftOther, language, days)
        case .lastDay:
            return KitStrings.text(.goalLastDay, language)
        case .hours(let hours):
            return KitStrings.text(.goalHoursLeft, language, hours)
        case .underHour:
            return KitStrings.text(.goalUnderHour, language)
        case .early(let days):
            return days == 1
                ? KitStrings.text(.goalEarlyOne, language) : KitStrings.text(.goalEarlyOther, language, days)
        }
    }
}
