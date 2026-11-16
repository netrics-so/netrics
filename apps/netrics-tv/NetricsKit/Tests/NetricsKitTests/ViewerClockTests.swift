import Foundation
import Testing

@testable import NetricsKit

// #736, ADR 0025 §8: every time a viewer reads is in the zone of the
// person in front of the screen, the device's. The payload's zone (the
// workspace's; here UTC, the old default) only counts data days. Same
// rules as apps/web/src/components/studio/viewer-clock.test.tsx.

@Suite struct ViewerClockTests {
    let berlin = TimeZone(identifier: "Europe/Berlin")!
    /** 2026-11-16T16:34:00Z: 17:34 in Berlin. */
    let now = Date(timeIntervalSince1970: 1_794_846_840)

    func payload() throws -> DeviceDashboardV2 {
        let json = """
            {"version": "x", "schema": 2, "timeZone": "UTC", "dashboard": null, "slides": [],
             "theme": {"name": "netrics", "tokens": {}}, "rotation": {"autoAdvance": true, "transition": "fade"}}
            """
        return try JSONDecoder().decode(DeviceDashboardV2.self, from: Data(json.utf8))
    }

    @Test func headerClockShowsTheDeviceZoneNotThePayloads() throws {
        #expect(try payload().timeZone == "UTC")
        #expect(TVTime.viewerZone(device: berlin) == "Europe/Berlin")
        #expect(TVTime.headerTime(now, device: berlin) == "17:34")
        #expect(TVTime.headerClock(now, device: berlin) == "Mon 16 Nov, 17:34")
        #expect(TVTime.offlineMarker(updatedAt: now, device: berlin) == "Offline — last update 17:34")
    }

    @Test func clockWidgetWithoutItsOwnZoneFollowsTheDevice() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ClockWidgetOptions.self, from: Data(json.utf8)) }
        // The server sends the workspace's zone for older screens and marks it.
        let follows = try decode(#"{"showDate":false,"hour12":false,"timeZone":"UTC","followsViewer":true}"#)
        #expect(follows.followsViewer)
        #expect(follows.zone(device: berlin) == "Europe/Berlin")
        #expect(TVTime.clockWidget(now, timeZone: follows.zone(device: berlin), hour12: false, showDate: false).time == "17:34")
    }

    @Test func clockWidgetWithItsOwnZoneKeepsIt() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ClockWidgetOptions.self, from: Data(json.utf8)) }
        let tokyo = try decode(#"{"showDate":false,"hour12":false,"timeZone":"Asia/Tokyo"}"#)
        #expect(!tokyo.followsViewer)
        #expect(tokyo.zone(device: berlin) == "Asia/Tokyo")
        #expect(TVTime.clockWidget(now, timeZone: tokyo.zone(device: berlin), hour12: false, showDate: false).time == "01:34")
        // A payload from an older server, which never marks a clock: its zone, as before.
        #expect(try decode(#"{"timeZone":"UTC"}"#).zone(device: berlin) == "UTC")
        // No zone at all: the device's.
        #expect(try decode("{}").zone(device: berlin) == "Europe/Berlin")
    }
}
