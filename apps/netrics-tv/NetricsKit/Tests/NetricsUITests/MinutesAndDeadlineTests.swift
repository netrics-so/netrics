import Foundation
import SwiftUI
import Testing

@testable import NetricsUI

/// The timeline of widgets with a retention deadline (#539).
@Suite struct MinutesAndDeadlineTests {
    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
    private func first(_ count: Int, _ schedule: MinutesAndDeadline, from start: Date) -> [Date] {
        Array(schedule.entries(from: start, mode: .normal).prefix(count))
    }

    @Test func ticksEveryMinuteWithoutADeadline() {
        let start = date("2026-11-08T15:29:10Z")
        #expect(
            first(3, MinutesAndDeadline(deadline: nil), from: start) == [
                start, date("2026-11-08T15:30:00Z"), date("2026-11-08T15:31:00Z"),
            ])
    }

    @Test func ticksAtTheDeadlineBetweenMinutes() {
        let start = date("2026-11-08T15:29:10Z")
        let deadline = date("2026-11-08T15:30:30Z")
        #expect(
            first(5, MinutesAndDeadline(deadline: deadline), from: start) == [
                start, date("2026-11-08T15:30:00Z"), deadline, date("2026-11-08T15:31:00Z"),
                date("2026-11-08T15:32:00Z"),
            ])
    }

    @Test func aDeadlineOnAMinuteTicksOnce() {
        let start = date("2026-11-08T15:29:10Z")
        let deadline = date("2026-11-08T15:30:00Z")
        #expect(
            first(3, MinutesAndDeadline(deadline: deadline), from: start) == [
                start, deadline, date("2026-11-08T15:31:00Z"),
            ])
    }

    @Test func aPassedDeadlineAddsNoTick() {
        let start = date("2026-11-08T15:29:10Z")
        #expect(
            first(3, MinutesAndDeadline(deadline: date("2026-11-08T15:00:00Z")), from: start)
                == first(3, MinutesAndDeadline(deadline: nil), from: start))
    }

    @Test func eachSequenceStartsAfresh() {
        let schedule = MinutesAndDeadline(deadline: date("2026-11-08T15:30:30Z"))
        let entries = schedule.entries(from: date("2026-11-08T15:29:10Z"), mode: .normal)
        #expect(Array(entries.prefix(4)) == Array(entries.prefix(4)))
    }
}
