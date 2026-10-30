import Foundation

// The countdown widget (ADR 0019, section 8): a port of the countdown part
// of packages/domain/src/studio-layout.ts (parseCountdownTarget,
// zonedInstant, countdownParts, countdownLayout). Both sides run the
// zonedInstants, countdownParts and countdownLayouts vectors of
// studio-layout.json, so keep the arithmetic in the same order.

/** A countdown's unit: days, hours, minutes. */
public enum CountdownUnit: String, Sendable, Equatable, CaseIterable {
    case d, h, m
}

/** One number of the time left and its unit: "14" and "h". */
public struct CountdownGroup: Sendable, Equatable {
    /** The number as shown: "2", "05" after a larger unit, "< 1". */
    public var value: String
    public var unit: CountdownUnit

    public init(value: String, unit: CountdownUnit) {
        self.value = value
        self.unit = unit
    }
}

/** The time left: done at and after the target, else up to three groups. */
public struct CountdownParts: Sendable, Equatable {
    public var done: Bool
    public var groups: [CountdownGroup]
}

/** The countdown's sizes in units (countdownLayout in the domain). */
public struct CountdownLayout: Sendable, Equatable {
    public var title: Double
    public var resource: Double
    public var target: Double
    /** The numbers' size, and their unit letters'. */
    public var value: Double
    public var unit: Double
    /** The text when reached. */
    public var done: Double
    public var titleLines: Int
    public var resourceLines: Int
    /** Between a number and its letter, and between groups. */
    public var unitGap: Double
    public var groupGap: Double
    /** The target line is on and fits below the time left. */
    public var showTarget: Bool
    /** Lines of the text when reached; 0 before. */
    public var doneLines: Int
}

extension StudioLayout {
    /** The years a countdown's target may lie in. */
    public static let countdownTargetYears = 2000...2100

    /** Unit letters are a third of the numbers, never below the change role. */
    public static let countdownUnitShare = 1.0 / 3.0
    /** Between a number and its letter, as a share of the numbers' size. */
    public static let countdownUnitGap = 0.08
    /** Between two groups, as a share of the numbers' size. */
    public static let countdownGroupGap = 0.3
    static let countdownStackGap = 8.0
    static let countdownLineHeight = 1.15
    /** A tick this late after the minute still counts as on it. */
    static let countdownTickTolerance: TimeInterval = 1

    /**
     * A countdown's target, "YYYY-MM-DDTHH:mm", as its parts; nil unless it
     * is a real date and time in the years 2000–2100.
     */
    public static func parseCountdownTarget(_ target: String)
        -> (year: Int, month: Int, day: Int, hour: Int, minute: Int)?
    {
        let scalars = Array(target.unicodeScalars)
        guard scalars.count == 16, scalars[4] == "-", scalars[7] == "-", scalars[10] == "T", scalars[13] == ":"
        else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                let scalar = scalars[index]
                guard scalar >= "0" && scalar <= "9" else { return nil }
                value = value * 10 + Int(scalar.value - 48)
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
            let hour = number(11..<13), let minute = number(14..<16)
        else { return nil }
        guard countdownTargetYears.contains(year), (1...12).contains(month), day >= 1, hour <= 23, minute <= 59
        else { return nil }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        guard day <= days else { return nil }
        return (year, month, day, hour, minute)
    }

    /** Milliseconds since 1970 of a date and time read as UTC (Date.UTC). */
    static func utcMilliseconds(year: Int, month: Int, day: Int, hour: Int, minute: Int) -> Double {
        // Days from the civil date (Howard Hinnant's days_from_civil).
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146_097 + doe - 719_468
        return (Double(days) * 86_400 + Double(hour) * 3600 + Double(minute) * 60) * 1000
    }

    /**
     * The instant of a local date and time in a zone: a countdown's
     * `targetAt`. A time in a spring-forward gap moves forward by the gap,
     * a time that exists twice takes the earlier offset. Nil for a target
     * that does not parse; an unknown zone counts as UTC.
     */
    public static func zonedInstant(_ target: String, timeZone: String) -> Date? {
        guard let parts = parseCountdownTarget(target) else { return nil }
        let local = utcMilliseconds(
            year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute)
        func offsetAt(_ instant: Double) -> Int {
            zoneOffsetMinutes(timeZone, at: Date(timeIntervalSince1970: instant / 1000)) ?? 0
        }
        let day = 86_400_000.0
        let before = offsetAt(local - day)
        let after = offsetAt(local + day)
        var found: Double?
        for offset in [before, after] {
            let instant = local - Double(offset) * 60_000
            if offsetAt(instant) == offset && (found == nil || instant < found!) {
                found = instant
            }
        }
        return Date(timeIntervalSince1970: (found ?? local - Double(before) * 60_000) / 1000)
    }

    /**
     * The time left in whole minutes: "2 d 14 h 05 m" from one day on,
     * "14 h 05 m", "41 m", "< 1 m" in the last minute; done at the target.
     */
    public static func countdownParts(now: Date, targetAt: Date) -> CountdownParts {
        // In whole milliseconds, as the TypeScript's Date arithmetic.
        let left = (targetAt.timeIntervalSince1970 * 1000).rounded() - (now.timeIntervalSince1970 * 1000).rounded()
        if !(left > 0) { return CountdownParts(done: true, groups: []) }
        let total = Int(((left + countdownTickTolerance * 1000) / 60_000).rounded(.down))
        if total < 1 { return CountdownParts(done: false, groups: [CountdownGroup(value: "< 1", unit: .m)]) }
        let days = total / 1440
        let hours = (total % 1440) / 60
        let minutes = total % 60
        func two(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
        if days > 0 {
            return CountdownParts(
                done: false,
                groups: [
                    CountdownGroup(value: "\(days)", unit: .d), CountdownGroup(value: two(hours), unit: .h),
                    CountdownGroup(value: two(minutes), unit: .m),
                ])
        }
        if hours > 0 {
            return CountdownParts(
                done: false,
                groups: [CountdownGroup(value: "\(hours)", unit: .h), CountdownGroup(value: two(minutes), unit: .m)])
        }
        return CountdownParts(done: false, groups: [CountdownGroup(value: "\(minutes)", unit: .m)])
    }

    /**
     * The countdown's content (countdownLayout in the domain): the label,
     * the numbers (at least the value minimum, as large as fits on their
     * widest digits) with letters a third of their size, the target line
     * below, or the text when reached at heading size once done.
     */
    public static func countdownLayout(
        placement: StudioPlacement, box: (width: Double, height: Double), fontScale: Double? = nil,
        showHeader: Bool = true, label: String, groups: [(value: String, unit: String)], target: String?,
        doneText: String?
    ) -> CountdownLayout {
        let scale = effectiveFontScale(fontScale)
        let sizes = typeScale(.countdown, placement: placement, fontScale: scale, showHeader: showHeader)
        let width = Swift.max(0, box.width)
        let height = box.height
        let title = sizes[.title]!
        let resource = sizes[.resource]!
        let targetSize = sizes[.any]!
        let unitMin = sizes[.change]!
        let valueMin = sizes[.valueMin]!
        let heading = sizes[.heading]!

        let parts = labelParts(label)
        let titleLines = Swift.min(
            labelMaxLines, Swift.max(1, wrappedLineCount(parts.title, maxWidth: width, fontSize: title, weight: .semibold)))
        let resourceLines = parts.resource.map {
            Swift.min(
                labelMaxLines, Swift.max(1, wrappedLineCount($0, maxWidth: width, fontSize: resource, weight: .semibold)))
        } ?? 0
        let labelHeight =
            Double(titleLines) * title * countdownLineHeight + Double(resourceLines) * resource * countdownLineHeight
        let targetHeight = countdownStackGap + targetSize * countdownLineHeight
        let done = doneText != nil

        let middleMin = done ? heading * countdownLineHeight : valueMin
        let showTarget = target != nil && labelHeight + countdownStackGap + middleMin + targetHeight <= height
        let middle = height - labelHeight - countdownStackGap - (showTarget ? targetHeight : 0)

        var doneSize = heading
        var doneLines = 0
        if let text = doneText {
            let floor = Swift.min(targetSize, heading)
            func linesAt(_ size: Double) -> Int {
                Swift.max(1, wrappedLineCount(text, maxWidth: width, fontSize: size, weight: .semibold))
            }
            doneSize = floor
            var size = heading
            while size > floor {
                if Double(linesAt(size)) * size * countdownLineHeight <= middle {
                    doneSize = size
                    break
                }
                size -= 1
            }
            doneLines = linesAt(doneSize)
        }

        var numbers = 0.0
        var letters = 0.0
        for group in groups {
            let widest = String(String.UnicodeScalarView(group.value.unicodeScalars.map {
                $0 >= "0" && $0 <= "9" ? "0" : $0
            }))
            numbers += estimateTextWidth(widest, fontSize: 1, weight: .semibold)
            letters += estimateTextWidth(group.unit, fontSize: 1)
        }
        let count = Double(groups.count)
        let a = groups.isEmpty ? 0 : numbers + countdownUnitGap * count + countdownGroupGap * (count - 1)
        let b = letters
        let k = countdownUnitShare
        let valueMax = Swift.max(valueMin, Swift.min(sizes[.valueMax]!, middle))
        var value = valueMax
        if a > 0 {
            let knee = unitMin / k
            let fit = a * knee + b * unitMin <= width ? width / (a + b * k) : (width - b * unitMin) / a
            value = Swift.max(valueMin, Swift.min(valueMax, fit))
        }
        return CountdownLayout(
            title: title, resource: resource, target: targetSize, value: value, unit: Swift.max(unitMin, k * value),
            done: doneSize, titleLines: titleLines, resourceLines: resourceLines,
            unitGap: countdownUnitGap * value, groupGap: countdownGroupGap * value, showTarget: showTarget,
            doneLines: doneLines)
    }
}

extension KitStrings {
    /** The unit letters after a countdown's numbers: d/h/m, T/Std/Min. */
    public static func countdownUnit(_ unit: CountdownUnit, _ language: ScreenLanguage) -> String {
        switch unit {
        case .d: return text(.countdownDays, language)
        case .h: return text(.countdownHours, language)
        case .m: return text(.countdownMinutes, language)
        }
    }
}

extension TVTime {
    /**
     * A countdown's target line: "Wed 7 Oct · 10:00" ("Mi., 7. Okt. ·
     * 10:00") in the target's zone, with the year when it is not this year,
     * as on the web.
     */
    public static func countdownTargetLine(
        _ targetAt: Date, timeZone: String, now: Date, language: ScreenLanguage = .en
    ) -> String {
        let text = clockWidget(targetAt, timeZone: timeZone, hour12: false, showDate: true, language: language)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone(timeZone)
        let year = calendar.component(.year, from: targetAt)
        let day = text.date ?? ""
        let date = year == calendar.component(.year, from: now) ? day : "\(day) \(year)"
        return "\(date) \u{00B7} \(text.time)"
    }
}

/** One number of the time left with its letter in the screen's language. */
public struct CountdownShownGroup: Sendable, Equatable {
    public var value: String
    public var unit: String
}

/** What a countdown shows at a moment (web: countdownView). */
public struct CountdownView: Sendable, Equatable {
    public var done: Bool
    public var groups: [CountdownShownGroup]
    /** "2 d 14 h 05 m", for VoiceOver. */
    public var text: String
    public var doneText: String?
    public var target: String?
    public var layout: CountdownLayout
}

extension StudioRender {
    /**
     * A countdown at `now` at its size: the time left or the text when
     * reached, the target line and the layout.
     */
    public static func countdownView(
        now: Date, label: String, options: CountdownWidgetOptions, timeZone: String, placement: StudioPlacement,
        fontScale: Double, showHeader: Bool, unitBox: StudioCanvas? = nil, language: ScreenLanguage = .en
    ) -> CountdownView {
        let parts = StudioLayout.countdownParts(now: now, targetAt: options.targetAt)
        let groups = parts.groups.map {
            CountdownShownGroup(value: $0.value, unit: KitStrings.countdownUnit($0.unit, language))
        }
        let doneText = parts.done ? (options.doneText ?? KitStrings.text(.countdownDone, language)) : nil
        let target =
            options.showTarget
            ? TVTime.countdownTargetLine(options.targetAt, timeZone: timeZone, now: now, language: language) : nil
        let box = contentBox(placement, showHeader: showHeader, unitBox: unitBox)
        let layout = StudioLayout.countdownLayout(
            placement: placement, box: box, fontScale: fontScale, showHeader: showHeader, label: label,
            groups: groups.map { (value: $0.value, unit: $0.unit) }, target: target, doneText: doneText)
        return CountdownView(
            done: parts.done, groups: groups, text: groups.map { "\($0.value) \($0.unit)" }.joined(separator: " "),
            doneText: doneText, target: target, layout: layout)
    }
}
