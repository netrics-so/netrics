import Foundation

// Data freshness (ADR 0025, sections 7 and 8; #706): which provider day a
// widget's numbers cover, when netrics last fetched them and when the next
// period is expected. The payload carries instants and a calendar date only;
// every word is chosen here, in the screen language ("Nov 15", "15. Nov."),
// and every time is in this device's time zone with its clock (12 or 24
// hours, as the device is set).

/** A widget's freshness (widgetFreshnessSchema): the least fresh stream its data depends on. */
public struct WidgetFreshness: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case periodic, continuous
    }

    public var kind: Kind
    /** The stream's name in the payload's language ("Sales"). */
    public var stream: String
    /** When netrics last read the stream (ISO 8601). */
    public var fetchedAt: String
    /** YYYY-MM-DD: the provider's last complete day, never converted. */
    public var dataThrough: String?
    /** The stream is published by calendar month: screens name the month. */
    public var monthly: Bool
    /** When the period after `dataThrough` should be published. */
    public var nextExpectedAt: String?
    /** A sync after `nextExpectedAt` still did not find the period. */
    public var late: Bool
    /** The connection's next scheduled sync. */
    public var nextCheckAt: String?
    /**
     * A widget whose rows come from several connectors (#784): each one's
     * summary, in name order; empty otherwise. The fields above stay the
     * least fresh source's.
     */
    public var sources: [WidgetFreshnessSource]

    public init(
        kind: Kind, stream: String, fetchedAt: String, dataThrough: String? = nil, monthly: Bool = false,
        nextExpectedAt: String? = nil, late: Bool = false, nextCheckAt: String? = nil,
        sources: [WidgetFreshnessSource] = []
    ) {
        self.sources = sources
        self.kind = kind
        self.stream = stream
        self.fetchedAt = fetchedAt
        self.dataThrough = dataThrough
        self.monthly = monthly
        self.nextExpectedAt = nextExpectedAt
        self.late = late
        self.nextCheckAt = nextCheckAt
    }

    private enum CodingKeys: String, CodingKey {
        case kind, stream, fetchedAt, dataThrough, period, nextExpectedAt, late, nextCheckAt, sources
    }

    /**
     * Throws only without a known kind or a readable `fetchedAt`; carriers
     * decode it with `lenient`, so the widget then shows `updatedAt` as
     * before. Every other field that is missing or of another shape is left
     * out on its own.
     */
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        fetchedAt = try c.decode(String.self, forKey: .fetchedAt)
        guard ISODate.parse(fetchedAt) != nil else {
            throw DecodingError.dataCorruptedError(forKey: .fetchedAt, in: c, debugDescription: "Not an instant")
        }
        stream = c.lenient(String.self, .stream) ?? ""
        dataThrough = c.lenient(String.self, .dataThrough).flatMap { CalendarDay($0) != nil ? $0 : nil }
        monthly = c.lenient(String.self, .period) == "month"
        nextExpectedAt = c.lenient(String.self, .nextExpectedAt).flatMap { ISODate.parse($0) != nil ? $0 : nil }
        late = c.lenient(Bool.self, .late) ?? false
        nextCheckAt = c.lenient(String.self, .nextCheckAt).flatMap { ISODate.parse($0) != nil ? $0 : nil }
        // Entries that do not read are left out; fewer than two is none.
        let sources = (c.lenient([LenientSource].self, .sources) ?? []).compactMap(\.source)
        self.sources = sources.count >= 2 ? sources : []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(stream, forKey: .stream)
        try c.encode(fetchedAt, forKey: .fetchedAt)
        try c.encodeIfPresent(dataThrough, forKey: .dataThrough)
        if monthly { try c.encode("month", forKey: .period) }
        try c.encodeIfPresent(nextExpectedAt, forKey: .nextExpectedAt)
        if late { try c.encode(true, forKey: .late) }
        try c.encodeIfPresent(nextCheckAt, forKey: .nextCheckAt)
        if !sources.isEmpty { try c.encode(sources, forKey: .sources) }
    }
}

/**
 * One source of a widget that combines sources (widgetFreshnessSourceSchema,
 * #784): its short name ("App Store") and its own summary.
 */
public struct WidgetFreshnessSource: Codable, Sendable, Equatable {
    /** The source's name in the payload's language ("App Store"). */
    public var source: String
    public var freshness: WidgetFreshness

    public init(source: String, freshness: WidgetFreshness) {
        self.source = source
        self.freshness = freshness
    }

    private enum CodingKeys: String, CodingKey { case source }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(String.self, forKey: .source).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "No name")
        }
        freshness = try WidgetFreshness(from: decoder)
        freshness.sources = []
    }

    public func encode(to encoder: Encoder) throws {
        try freshness.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(source, forKey: .source)
    }
}

/** A source entry that never fails its list: nil when it does not read. */
private struct LenientSource: Decodable {
    var source: WidgetFreshnessSource?
    init(from decoder: Decoder) throws { source = try? WidgetFreshnessSource(from: decoder) }
}

/** A calendar date as the provider names it ("2026-11-15"): no time, no zone. */
public struct CalendarDay: Sendable, Equatable {
    public var year: Int
    public var month: Int
    public var day: Int

    public init?(_ text: String) {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            (1...12).contains(month), day >= 1, day <= CalendarDay.days(year: year, month: month)
        else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    static func days(year: Int, month: Int) -> Int {
        switch month {
        case 2: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    /** The day after. */
    public var next: CalendarDay {
        if day < CalendarDay.days(year: year, month: month) { return CalendarDay(year: year, month: month, day: day + 1) }
        return month == 12
            ? CalendarDay(year: year + 1, month: 1, day: 1) : CalendarDay(year: year, month: month + 1, day: 1)
    }

    /** The first day of the following month. */
    public var nextMonth: CalendarDay {
        month == 12 ? CalendarDay(year: year + 1, month: 1, day: 1) : CalendarDay(year: year, month: month + 1, day: 1)
    }
}

/**
 * The freshness line in words (ADR 0025 section 8). `timeZone` is this
 * device's zone, which decides the local day and time; `region` is the
 * device's locale, whose 12- or 24-hour clock times use. Words and dates
 * follow the screen language, as on the web. Relative times are worded
 * from `now`, the device clock.
 */
public struct FreshnessText: Sendable {
    public var language: ScreenLanguage
    public var timeZone: TimeZone
    /** The locale times and dates are formatted in: the screen language with the device's clock. */
    public var locale: Locale

    public init(language: ScreenLanguage, timeZone: TimeZone = .current, region: Locale = .autoupdatingCurrent) {
        self.language = language
        self.timeZone = timeZone
        self.locale = FreshnessText.formattingLocale(language, region: region)
    }

    /**
     * The screen language's dates ("Nov 15" in English, "15. Nov." in
     * German, as the ADR and the web word them) with the device's hour
     * cycle: an English screen on a German device keeps 21:00, a German
     * screen on a device set to 12 hours shows 9:00 PM.
     */
    public static func formattingLocale(_ language: ScreenLanguage, region: Locale) -> Locale {
        var components = Locale.Components(identifier: language == .en ? "en_US" : "de_DE")
        components.hourCycle = region.hourCycle
        return Locale(components: components)
    }

    /**
     * A line that follows a prefix ("derived · checked 5 min. ago"): its
     * first letter lower-cased. A line that starts on its own keeps the
     * capital ("Checked 5 min. ago").
     */
    public static func midLine(_ line: String) -> String {
        guard let first = line.first else { return line }
        return first.lowercased() + line.dropFirst()
    }

    private func text(_ key: KitText, _ arguments: CVarArg...) -> String {
        KitStrings.text(key, language, arguments: arguments)
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = locale
        return calendar
    }

    private func format(_ date: Date, template: String, zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }

    // MARK: Parts

    /**
     * The provider's day as written ("Nov 15", "15. Nov."), never moved to
     * another zone; a monthly stream's month ("October"), with the year when
     * it is not this year on the device.
     */
    public func day(_ day: CalendarDay, monthly: Bool, now: Date) -> String {
        let utc = TimeZone(identifier: "UTC")!
        var utcCalendar = Calendar(identifier: .gregorian)
        utcCalendar.timeZone = utc
        let date = utcCalendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12))!
        guard monthly else { return format(date, template: "MMMd", zone: utc) }
        let thisYear = calendar.component(.year, from: now)
        return format(date, template: day.year == thisYear ? "LLLL" : "MMMMy", zone: utc)
    }

    /**
     * An instant ahead, in local time: "~21:00" today, "tomorrow ~09:00",
     * "Fri ~09:00" within a week, "~Nov 18" beyond.
     */
    public func expected(_ date: Date, now: Date) -> String {
        let calendar = calendar
        let days =
            calendar.dateComponents(
                [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)
            ).day ?? 0
        let time = text(.freshApprox, format(date, template: "jmm", zone: timeZone))
        switch days {
        case ...0: return time
        case 1: return text(.freshTomorrow, time)
        case 2...6: return "\(format(date, template: "EEE", zone: timeZone)) \(time)"
        default: return text(.freshApprox, format(date, template: "MMMd", zone: timeZone))
        }
    }

    /** "10 min. ago" under a day (later than now reads "now"), else the local date. */
    private func since(_ date: Date, now: Date) -> (text: String, relative: Bool) {
        let shown = min(date, now)
        if now.timeIntervalSince(shown) < 24 * 3600 {
            let relative = WidgetFooter.relativeTime(ISODate.format(shown), now: now, language: language) ?? ""
            return (relative, true)
        }
        return (format(shown, template: "MMMd", zone: timeZone), false)
    }

    private func fetched(_ f: WidgetFreshness, now: Date) -> String? {
        guard let date = ISODate.parse(f.fetchedAt) else { return nil }
        let since = since(date, now: now)
        return text(since.relative ? .freshFetched : .freshFetchedOn, since.text)
    }

    private func checked(_ f: WidgetFreshness, stream: String?, now: Date) -> String? {
        guard let date = ISODate.parse(f.fetchedAt) else { return nil }
        let since = since(date, now: now)
        if let stream {
            return text(since.relative ? .freshStreamChecked : .freshStreamCheckedOn, stream, since.text)
        }
        return text(since.relative ? .freshChecked : .freshCheckedOn, since.text)
    }

    private func upTo(_ f: WidgetFreshness, stream: String?, now: Date) -> String? {
        guard let through = f.dataThrough.flatMap(CalendarDay.init) else { return nil }
        let shown = day(through, monthly: f.monthly, now: now)
        return stream.map { text(.freshStreamUpTo, $0, shown) } ?? text(.freshUpTo, shown)
    }

    /** "Nov 15 not published yet": the period after `dataThrough`. */
    private func notPublished(_ f: WidgetFreshness, now: Date) -> String? {
        guard let through = f.dataThrough.flatMap(CalendarDay.init) else { return nil }
        return text(.freshNotPublished, day(f.monthly ? through.nextMonth : through.next, monthly: f.monthly, now: now))
    }

    /** "next ~21:00", "next any minute" once it is past (and not late). */
    private func next(_ iso: String?, now: Date, key: KitText, soon: KitText) -> String? {
        guard let date = iso.flatMap(ISODate.parse) else { return nil }
        return date <= now ? text(soon) : text(key, expected(date, now: now))
    }

    // MARK: Lines

    /** Which line a widget's status calls for (ADR 0025 section 8, precedence). */
    enum Mode { case normal, late, failing }

    static func mode(_ f: WidgetFreshness, status: DeviceTileStatus) -> Mode {
        switch status {
        case .authFailed, .outage, .stale: return .failing
        default: return f.kind == .periodic && f.late && f.dataThrough != nil ? .late : .normal
        }
    }

    /** The line's parts, most important first; narrow widgets drop them from the end. */
    func parts(
        _ f: WidgetFreshness, status: DeviceTileStatus, stream: String? = nil, now: Date, paused: Bool = false,
        fetched includeFetched: Bool = false
    ) -> [String] {
        let mode = Self.mode(f, status: status)
        // Paused syncs: no next time of any kind.
        func next(_ iso: String?, now: Date, key: KitText, soon: KitText) -> String? {
            paused ? nil : self.next(iso, now: now, key: key, soon: soon)
        }
        if f.kind == .continuous {
            let checked = checked(f, stream: stream, now: now)
            guard mode != .failing else { return [checked].compactMap { $0 } }
            return [
                checked, next(f.nextCheckAt, now: now, key: .freshNextCheck, soon: .freshNextCheckSoon),
            ].compactMap { $0 }
        }
        let upTo = upTo(f, stream: stream, now: now)
        switch mode {
        case .failing:
            // netrics may not fetch it: the day only, never "next".
            return [upTo ?? fetched(f, now: now)].compactMap { $0 }
        case .late:
            return [
                upTo, notPublished(f, now: now),
                next(f.nextCheckAt, now: now, key: .freshCheckingAgain, soon: .freshCheckingAgainSoon),
            ].compactMap { $0 }
        case .normal:
            // A widget detail names the stream with the day and drops "fetched";
            // a status board keeps it (#727, as the web).
            return [
                upTo, includeFetched || stream == nil || upTo == nil ? fetched(f, now: now) : nil,
                next(f.nextExpectedAt, now: now, key: .freshNext, soon: .freshNextSoon),
            ].compactMap { $0 }
        }
    }

    /**
     * The footer's candidates, longest first: "Up to Nov 15 · fetched 10
     * min. ago · next ~21:00", "Up to Nov 15 · fetched 10 min. ago", "Up to
     * Nov 15". Under a failing or stale connection only the day.
     */
    public func footer(_ f: WidgetFreshness, status: DeviceTileStatus = .ok, now: Date = Date()) -> [String] {
        let parts = parts(f, status: status, now: now)
        return (0..<parts.count).reversed().map { parts[0...$0].joined(separator: " · ") }
    }

    /** A provider's day in numbers ("11/17", "17.11."); a month keeps its name. */
    public func shortDay(_ day: CalendarDay, monthly: Bool, now: Date) -> String {
        guard !monthly else { return self.day(day, monthly: true, now: now) }
        let utc = TimeZone(identifier: "UTC")!
        var utcCalendar = Calendar(identifier: .gregorian)
        utcCalendar.timeZone = utc
        let date = utcCalendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12))!
        return format(date, template: "Md", zone: utc)
    }

    /**
     * The forms of a freshness line that lists several sources (#784, ADR
     * 0025 section 8), longest first, each form its lines: every source's
     * day and next time with "fetched" at the end; without "fetched"; each
     * source's day only; with numeric days; a line per source. Screens show
     * the first form that fits (StudioLayout.freshnessLevelFit). Under a
     * failing or stale connection a source keeps its day (and "not
     * published yet" when late), never "next". Empty without `sources`.
     */
    public func sourceLevels(
        _ f: WidgetFreshness, status: DeviceTileStatus = .ok, now: Date = Date(), paused: Bool = false
    ) -> [[String]] {
        guard f.sources.count >= 2 else { return [] }
        let warning = Self.mode(f, status: status) == .failing
        let sources = f.sources.map { entry -> (parts: [String], short: String?, shortest: String?) in
            let s = entry.freshness, name = entry.source
            if s.kind == .continuous {
                let parts =
                    warning
                    ? [checked(s, stream: name, now: now)].compactMap { $0 }
                    : self.parts(s, status: .ok, stream: name, now: now, paused: paused)
                return (parts, parts.first, parts.first)
            }
            let short = s.dataThrough.flatMap(CalendarDay.init).map {
                text(.freshStreamUpTo, name, shortDay($0, monthly: s.monthly, now: now))
            }
            // Shortest: the store and its day alone ("App Store 11/17").
            let shortest =
                s.monthly
                ? short
                : s.dataThrough.flatMap(CalendarDay.init).map { "\(name) \(shortDay($0, monthly: false, now: now))" }
                    ?? short
            if warning {
                let parts = [
                    upTo(s, stream: name, now: now), s.late ? notPublished(s, now: now) : nil,
                ].compactMap { $0 }
                return (parts, short ?? parts.first, shortest ?? parts.first)
            }
            let parts = self.parts(s, status: .ok, stream: name, now: now, paused: paused)
            return (parts, short ?? parts.first, shortest ?? parts.first)
        }.filter { !$0.parts.isEmpty }
        guard !sources.isEmpty else { return [] }
        let all = sources.flatMap(\.parts)
        let firsts = sources.map { $0.parts[0] }
        let shorts = sources.map { $0.short ?? $0.parts[0] }
        let shortests = sources.map { $0.shortest ?? $0.parts[0] }
        let fetched = warning ? nil : fetched(f, now: now)
        return [
            [(all + (fetched.map { [$0] } ?? [])).joined(separator: " · ")],
            [all.joined(separator: " · ")],
            [firsts.joined(separator: " · ")],
            [shorts.joined(separator: " · ")],
            [shortests.joined(separator: " · ")],
            shorts,
        ]
    }

    /**
     * The warning notice of a failing or stale widget with freshness: a
     * provider overdue by 24 hours (stale and late) reads "Up to Nov 14 ·
     * Nov 15 not published yet"; otherwise the notice keeps its words and
     * gains the day ("Source unreachable · Up to Nov 14"). Nil for the
     * other states, and `notice` itself when there is no day to add.
     */
    public func notice(_ f: WidgetFreshness, status: DeviceTileStatus, notice: String?, now: Date = Date()) -> String? {
        guard let notice, f.kind == .periodic, let upTo = upTo(f, stream: nil, now: now) else { return notice }
        switch status {
        case .stale where f.late:
            return [upTo, notPublished(f, now: now)].compactMap { $0 }.joined(separator: " · ")
        case .stale, .outage:
            return "\(notice) · \(upTo)"
        default:
            return notice
        }
    }

    /**
     * The warning of a provider overdue by a day (status stale and late):
     * "Up to Nov 14 · Nov 15 not published yet"; nil otherwise.
     */
    public func overdueWarning(_ f: WidgetFreshness, status: DeviceTileStatus, now: Date = Date()) -> String? {
        guard status == .stale, f.kind == .periodic, f.late, let upTo = upTo(f, stream: nil, now: now) else {
            return nil
        }
        return [upTo, notPublished(f, now: now)].compactMap { $0 }.joined(separator: " · ")
    }

    /**
     * A status board's stream line, longest first (#727; web:
     * `statusStreamText`): the stream's name first, "Sales up to Nov 15 ·
     * fetched 10 min. ago · next ~21:00". Overdue: only the covered day and the late wording, as
     * a warning; a continuous stream then has nothing to say. While syncs
     * are paused (credentials failed) no "next", "checking again" or "next
     * check".
     */
    public func streamCandidates(_ stream: StatusStream, paused: Bool, now: Date = Date()) -> [String] {
        let f = stream.freshness
        let trimmed = f.stream.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? nil : trimmed
        let parts: [String]
        if stream.overdue {
            guard f.kind == .periodic else { return [] }
            parts = [upTo(f, stream: name, now: now), f.late ? notPublished(f, now: now) : nil].compactMap { $0 }
        } else {
            parts = self.parts(f, status: .ok, stream: name, now: now, paused: paused, fetched: true)
        }
        return (0..<parts.count).reversed().map { parts[0...$0].joined(separator: " · ") }
    }

    /**
     * For lists and the detail sheet, which name the stream: "Sales up to
     * Nov 15 · next ~21:00", "Reviews checked 10 min. ago · next check ~14:30".
     */
    public func detail(_ f: WidgetFreshness, status: DeviceTileStatus = .ok, now: Date = Date()) -> String {
        let stream = f.stream.trimmingCharacters(in: .whitespacesAndNewlines)
        return parts(f, status: status, stream: stream.isEmpty ? nil : stream, now: now).joined(separator: " · ")
    }
}
