import Foundation
import Testing

@testable import NetricsKit

// The countdown widget (ADR 0019 section 8): the vectors the TypeScript
// generates (zonedInstants, countdownParts, countdownLayouts), decoding,
// and what the screen shows across a DST change.

private func double(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }
private func int(_ any: Any?) -> Int { (any as! NSNumber).intValue }
private func bool(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }
private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)) }
private func instant(_ text: String) -> Date { ISODate.parse(text)! }

@Suite struct CountdownVectorTests {
    @Test func zonedInstants() {
        let cases = StudioVectors.cases("zonedInstants")
        #expect(!cases.isEmpty)
        for c in cases {
            let resolved = StudioLayout.zonedInstant(c["target"] as! String, timeZone: c["timeZone"] as! String)
            if c["targetAt"] is NSNull {
                #expect(resolved == nil, "\(c)")
            } else {
                #expect(resolved.map(ISODate.format) == (c["targetAt"] as! String), "\(c)")
            }
        }
    }

    @Test func countdownParts() {
        let cases = StudioVectors.cases("countdownParts")
        #expect(!cases.isEmpty)
        for c in cases {
            let parts = StudioLayout.countdownParts(
                now: instant(c["now"] as! String), targetAt: instant(c["targetAt"] as! String))
            #expect(parts.done == bool(c["done"]), "\(c)")
            let groups = (c["groups"] as! [[String: Any]]).map {
                CountdownGroup(value: $0["value"] as! String, unit: CountdownUnit(rawValue: $0["unit"] as! String)!)
            }
            #expect(parts.groups == groups, "\(c)")
        }
    }

    @Test func countdownLayouts() {
        let cases = StudioVectors.cases("countdownLayouts")
        #expect(!cases.isEmpty)
        for c in cases {
            let box = c["box"] as! [String: Any]
            let groups = (c["groups"] as! [[String: Any]]).map {
                (value: $0["value"] as! String, unit: $0["unit"] as! String)
            }
            let layout = StudioLayout.countdownLayout(
                placement: StudioPlacement(x: 0, y: 0, w: int(c["w"]), h: int(c["h"])),
                box: (double(box["width"]), double(box["height"])), fontScale: double(c["fontScale"]),
                showHeader: true, label: c["label"] as! String, groups: groups,
                target: c["target"] as? String, doneText: c["doneText"] as? String)
            let e = c["layout"] as! [String: Any]
            let sizes = e["sizes"] as! [String: Any]
            #expect(close(layout.title, double(sizes["title"])), "\(c)")
            #expect(close(layout.resource, double(sizes["resource"])), "\(c)")
            #expect(close(layout.target, double(sizes["target"])), "\(c)")
            #expect(close(layout.value, double(sizes["value"])), "\(c)")
            #expect(close(layout.unit, double(sizes["unit"])), "\(c)")
            #expect(close(layout.done, double(sizes["done"])), "\(c)")
            #expect(layout.titleLines == int(e["titleLines"]), "\(c)")
            #expect(layout.resourceLines == int(e["resourceLines"]), "\(c)")
            #expect(close(layout.unitGap, double(e["unitGap"])), "\(c)")
            #expect(close(layout.groupGap, double(e["groupGap"])), "\(c)")
            #expect(layout.showTarget == bool(e["showTarget"]), "\(c)")
            #expect(layout.doneLines == int(e["doneLines"]), "\(c)")
        }
    }

    @Test func minimumAndTypeScale() {
        #expect(StudioLayout.minimumSize(.countdown) == (3, 2))
        let sizes = StudioLayout.typeScale(.countdown, placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2))
        #expect(sizes[.valueMin] == 64)
        #expect(sizes[.change] == 28)
        #expect(sizes[.heading] == 56)
        #expect(StudioWidgetType.countdown.hasLabel)
        #expect(!StudioWidgetType.countdown.isData)
    }
}

private func countdown(_ options: String, label: String = "Launch in") -> String {
    """
    {"id": "c", "type": "countdown", "x": 0, "y": 0, "w": 3, "h": 2, "min": {"w": 3, "h": 2},
     "label": "\(label)", "options": \(options)}
    """
}

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

@Suite struct CountdownDecodingTests {
    @Test func decodesACountdown() throws {
        let json = countdown(
            #"{"target": "2026-10-07T10:00", "timeZone": "Europe/Berlin", "showTarget": true, "doneText": null, "targetAt": "2026-10-07T08:00:00.000Z"}"#
        )
        let widget = try #require(v3Payload(primaryFormat: "16x9", slides: slides(json)).slides.first?.widgets.first)
        #expect(
            widget.content
                == .countdown(
                    CountdownWidgetOptions(
                        target: "2026-10-07T10:00", timeZone: "Europe/Berlin",
                        targetAt: instant("2026-10-07T08:00:00.000Z"))))
        #expect(widget.label == "Launch in")
    }

    @Test func optionsFallBackAndABlankTextIsNone() throws {
        let json = countdown(#"{"targetAt": "2026-10-07T08:00:00Z", "showTarget": "yes", "doneText": "  "}"#)
        let widget = try #require(v3Payload(primaryFormat: "16x9", slides: slides(json)).slides.first?.widgets.first)
        guard case .countdown(let options) = widget.content else {
            Issue.record("countdown")
            return
        }
        #expect(options.showTarget)
        #expect(options.doneText == nil)
    }

    @Test func aCountdownWithoutTargetAtIsAnEmptyCell() throws {
        let json = countdown(#"{"target": "2026-10-07T10:00"}"#)
        let widget = try #require(v3Payload(primaryFormat: "16x9", slides: slides(json)).slides.first?.widgets.first)
        #expect(widget.type == "countdown")
        #expect(widget.content == .unsupported)
    }

    @Test func countdownsSurviveTheCache() throws {
        let json = countdown(
            #"{"target": "2026-10-07T10:00", "timeZone": "Europe/Berlin", "doneText": "Live", "targetAt": "2026-10-07T08:00:00.000Z"}"#
        )
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(json))
        let again = try JSONDecoder().decode(DeviceDashboardV2.self, from: JSONEncoder().encode(payload))
        #expect(again.slides == payload.slides)
    }
}

@Suite struct CountdownViewTests {
    private let options = CountdownWidgetOptions(
        target: "2026-10-07T10:00", timeZone: "Europe/Berlin", targetAt: instant("2026-10-07T08:00:00.000Z"))

    private func view(_ now: String, _ options: CountdownWidgetOptions? = nil, language: ScreenLanguage = .en)
        -> CountdownView
    {
        StudioRender.countdownView(
            now: instant(now), label: "Launch in", options: options ?? self.options, timeZone: "Europe/Berlin",
            placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), fontScale: 1, showHeader: true, language: language)
    }

    @Test func showsTheTimeLeftAndTheTargetAsOnTheWeb() {
        let english = view("2026-10-04T17:55:00Z")
        #expect(english.text == "2 d 14 h 05 m")
        #expect(english.target == "Wed 7 Oct \u{00B7} 10:00")
        #expect(english.layout.value >= 64)
        let german = view("2026-10-04T17:55:00Z", language: .de)
        #expect(german.text == "2 T 14 Std 05 Min")
        // Foundation writes the German weekday without a comma, as the clock.
        #expect(german.target == "Mi. 7. Okt. \u{00B7} 10:00")
        #expect(view("2026-10-07T07:19:00Z").text == "41 m")
        #expect(view("2026-10-07T07:59:30Z").text == "< 1 m")
    }

    @Test func switchesToTheTextWhenReachedAtTenInBerlin() {
        #expect(!view("2026-10-07T07:59:00Z").done)
        let done = view("2026-10-07T08:00:00Z")
        #expect(done.done)
        #expect(done.doneText == "Now")
        #expect(done.layout.done == 56)
        #expect(view("2026-10-08T00:00:00Z", language: .de).doneText == "Jetzt")
        var own = options
        own.doneText = "We are live"
        #expect(view("2026-10-08T00:00:00Z", own).doneText == "We are live")
    }

    @Test func countsDownAcrossTheDaylightSavingChange() {
        // 10:00 in Berlin after the clocks went back on 25 October.
        let after = StudioLayout.zonedInstant("2026-10-27T10:00", timeZone: "Europe/Berlin")!
        #expect(ISODate.format(after) == "2026-10-27T09:00:00.000Z")
        let options = CountdownWidgetOptions(target: "2026-10-27T10:00", timeZone: "Europe/Berlin", targetAt: after)
        #expect(view("2026-10-24T08:00:00Z", options).text == "3 d 01 h 00 m")
        #expect(!view("2026-10-27T08:59:00Z", options).done)
        #expect(view("2026-10-27T09:00:00Z", options).done)
    }

    @Test func addsTheYearForAnotherYear() {
        #expect(
            TVTime.countdownTargetLine(
                instant("2027-10-07T08:00:00Z"), timeZone: "Europe/Berlin", now: instant("2026-10-04T12:00:00Z"))
                == "Thu 7 Oct 2027 \u{00B7} 10:00")
    }
}
