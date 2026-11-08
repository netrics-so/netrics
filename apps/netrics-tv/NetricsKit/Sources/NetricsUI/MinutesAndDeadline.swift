import Foundation
import SwiftUI

/**
 * Every minute, like `.everyMinute`, plus the moment a widget's values reach
 * their retention deadline (#539): a screen playing its last payload offline
 * hides them then, not up to a minute later.
 */
public struct MinutesAndDeadline: TimelineSchedule {
    public let deadline: Date?

    public init(deadline: Date?) {
        self.deadline = deadline
    }

    public func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnySequence<Date> {
        let deadline = deadline
        return AnySequence {
            var last: Date?
            var deadlinePending = deadline.map { $0 > startDate } ?? false
            return AnyIterator {
                guard let previous = last else {
                    last = startDate
                    return startDate
                }
                let minute = Date(
                    timeIntervalSinceReferenceDate:
                        (previous.timeIntervalSinceReferenceDate / 60).rounded(.down) * 60 + 60)
                if deadlinePending, let deadline, deadline <= minute {
                    deadlinePending = false
                    last = deadline
                    return deadline
                }
                last = minute
                return minute
            }
        }
    }
}
