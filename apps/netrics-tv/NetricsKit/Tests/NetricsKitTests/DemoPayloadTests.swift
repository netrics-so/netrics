import Foundation
import Testing

@testable import NetricsKit

// The demo dashboard's dates (#416): ages stay relative to now, every other
// instant keeps its wall-clock time and moves by whole days, and every time
// zone becomes the device's.

@Suite struct DemoPayloadTests {
    private let json = """
        {"timeZone": "UTC", "version": "demo-1-en",
         "slides": [{"widgets": [
           {"options": {"timeZone": "UTC"},
            "data": {"updatedAt": "2026-10-29T08:57:00.000Z",
                     "buckets": ["2026-10-28T00:00:00.000Z", "2026-10-29T00:00:00.000Z"],
                     "periodEnd": "2026-11-01T00:00:00.000Z",
                     "items": [{"lastSuccessAt": "2026-10-29T03:00:00.000Z", "name": "Payments"}],
                     "value": 12.5, "flag": true}}]}]}
        """

    private func retimed(now: String, zone: String) throws -> [String: Any] {
        let data = try DemoPayload.retime(
            Data(json.utf8), now: ISODate.parse(now)!, timeZone: TimeZone(identifier: zone)!)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func data(_ root: [String: Any]) throws -> [String: Any] {
        let slide = try #require((root["slides"] as? [[String: Any]])?.first)
        let widget = try #require((slide["widgets"] as? [[String: Any]])?.first)
        return try #require(widget["data"] as? [String: Any])
    }

    private func instant(_ value: Any?) throws -> Date {
        let text = try #require(value as? String)
        return try #require(ISODate.parse(text))
    }

    @Test func agesStayAsOldAsTheyWere() throws {
        let root = try retimed(now: "2027-03-14T12:00:00.000Z", zone: "UTC")
        let data = try data(root)
        let now = ISODate.parse("2027-03-14T12:00:00.000Z")!
        #expect(try instant(data["updatedAt"]) == now.addingTimeInterval(-3 * 60))
        let item = try #require((data["items"] as? [[String: Any]])?.first)
        #expect(try instant(item["lastSuccessAt"]) == now.addingTimeInterval(-6 * 3600))
    }

    @Test func bucketsMoveByWholeDaysAndEndToday() throws {
        let root = try retimed(now: "2027-03-14T12:00:00.000Z", zone: "UTC")
        let data = try data(root)
        let buckets = try #require(data["buckets"] as? [String])
        #expect(buckets.map { ISODate.parse($0) } == [
            ISODate.parse("2027-03-13T00:00:00.000Z"), ISODate.parse("2027-03-14T00:00:00.000Z"),
        ])
        #expect(try instant(data["periodEnd"]) == ISODate.parse("2027-03-17T00:00:00.000Z"))
    }

    @Test func wallClockTimesLandInTheDeviceZoneAcrossDaylightSaving() throws {
        // Generated in UTC; Berlin is on summer time (UTC+2) from 28 March 2027.
        let root = try retimed(now: "2027-03-30T10:00:00.000Z", zone: "Europe/Berlin")
        #expect(root["timeZone"] as? String == "Europe/Berlin")
        let data = try data(root)
        let buckets = try #require(data["buckets"] as? [String])
        // Midnight in Berlin, in summer time (UTC+2): 22:00 UTC the day before.
        #expect(buckets.last.flatMap(ISODate.parse) == ISODate.parse("2027-03-29T22:00:00.000Z"))
        #expect(buckets.first.flatMap(ISODate.parse) == ISODate.parse("2027-03-28T22:00:00.000Z"))
    }

    @Test func everyTimeZoneBecomesTheDevicesAndTheRestStays() throws {
        let root = try retimed(now: "2026-10-29T09:00:00.000Z", zone: "America/New_York")
        let slide = try #require((root["slides"] as? [[String: Any]])?.first)
        let widget = try #require((slide["widgets"] as? [[String: Any]])?.first)
        #expect((widget["options"] as? [String: Any])?["timeZone"] as? String == "America/New_York")
        #expect(root["version"] as? String == "demo-1-en")
        let data = try data(root)
        #expect(data["value"] as? Double == 12.5)
        #expect(data["flag"] as? Bool == true)
        #expect((data["items"] as? [[String: Any]])?.first?["name"] as? String == "Payments")
    }
}
