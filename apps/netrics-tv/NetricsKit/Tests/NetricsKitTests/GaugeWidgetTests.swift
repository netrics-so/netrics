import Foundation
import Testing

@testable import NetricsKit

// The goal widget (ADR 0019 section 5): decoding, and the shared vectors of
// gaugeLayout, goalPercent and goalTimeText.

private func double(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }
private func int(_ any: Any?) -> Int { (any as! NSNumber).intValue }
private func bool(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }
private func optionalDouble(_ any: Any?) -> Double? { any == nil || any is NSNull ? nil : double(any) }
private func optionalString(_ any: Any?) -> String? { any as? String }
private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)) }

private let goalID = "11111111-2222-4333-8444-555555555555"

private func gauge(_ id: String, data: String? = nil, options: String = #"{"showTimeLeft": false}"#) -> String {
    let progress = """
        {"period": "this_month", "aggregation": "sum", "unit": "count", "conversion": null,
         "kind": "delta", "granularity": "day", "better": "higher", "status": "ok",
         "updatedAt": "2026-10-22T12:55:00.000Z", "goal": {"id": "\(goalID)", "name": "Monthly downloads"},
         "value": 12480, "target": 15000, "progress": 0.832, "reachedAt": null,
         "periodEnd": "2026-11-01T00:00:00+01:00"}
        """
    return """
        {"id": "\(id)", "type": "gauge", "x": 0, "y": 0, "w": 3, "h": 3, "min": {"w": 3, "h": 3},
         "label": "Monthly downloads", "options": \(options), "data": \(data ?? progress)}
        """
}

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

@Suite struct GaugeWidgetDecodingTests {
    @Test func decodesAGauge() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(gauge("g")))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.minimum == StudioMinimum(w: 3, h: 3))
        guard case .gauge(let options, let data) = widget.content else {
            Issue.record("gauge")
            return
        }
        #expect(options == GaugeWidgetOptions(showTimeLeft: false))
        #expect(data.goal == GoalReference(id: goalID, name: "Monthly downloads"))
        #expect(data.period == .thisMonth)
        #expect(data.value == 12480)
        #expect(data.target == 15000)
        #expect(data.progress == 0.832)
        #expect(data.reachedAt == nil)
        #expect(data.periodEnd == "2026-11-01T00:00:00+01:00")
        #expect(data.status == .ok)
    }

    @Test func decodesADeletedGoal() throws {
        let deleted = """
            {"period": null, "aggregation": null, "unit": null, "conversion": null, "kind": null,
             "granularity": null, "better": "higher", "status": "no_data", "updatedAt": null, "goal": null,
             "value": null, "target": null, "progress": null, "reachedAt": null, "periodEnd": null}
            """
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(gauge("g", data: deleted, options: "{}")))
        let widget = try #require(payload.slides.first?.widgets.first)
        guard case .gauge(let options, let data) = widget.content else {
            Issue.record("gauge")
            return
        }
        // The option's default.
        #expect(options.showTimeLeft)
        #expect(data.goal == nil)
        #expect(data.period == nil)
        #expect(data.status == .noData)
        #expect(data.progress == nil)
    }

    @Test func aGaugeWithUnreadableDataIsAnEmptyCell() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(gauge("g", data: #""not data""#)))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.content == .unsupported)
    }

    @Test func gaugesSurviveTheCache() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(gauge("g")))
        let again = try JSONDecoder().decode(DeviceDashboardV2.self, from: JSONEncoder().encode(payload))
        #expect(again.slides == payload.slides)
    }

    @Test func aGaugeKeepsItsOwnMinimum() {
        let payload = v3Payload(
            primaryFormat: "16x9",
            slides: slides(gauge("g").replacingOccurrences(of: #""min": {"w": 3, "h": 3}"#, with: #""min": {"w": 1, "h": 1}"#)))
        let placement = ScreenView.pages(payload, format: .tall).first?.placements.first
        #expect(placement.map { $0.w >= 3 && $0.h >= 3 } == true)
    }
}

@Suite struct GaugeVectorTests {
    @Test func gaugeLayouts() {
        let cases = StudioVectors.cases("gaugeLayouts")
        #expect(!cases.isEmpty)
        for c in cases {
            let value = (c["value"] as? [String: Any]).map {
                StudioLayout.TableValueText(full: $0["full"] as! String, compact: $0["compact"] as! String)
            }
            let layout = StudioLayout.gaugeLayout(
                label: c["label"] as! String, width: double(c["width"]), height: double(c["height"]),
                fontScale: double(c["fontScale"]), value: value, suffix: optionalString(c["suffix"]),
                progress: optionalString(c["progress"]))
            let e = c["layout"] as! [String: Any]
            let sizes = e["sizes"] as! [String: Any]
            let ring = e["ring"] as! [String: Any]
            #expect(layout.orientation.rawValue == e["orientation"] as! String, "\(c)")
            #expect(close(layout.sizes.title, double(sizes["title"])), "\(c)")
            #expect(close(layout.sizes.resource, double(sizes["resource"])), "\(c)")
            #expect(close(layout.sizes.target, double(sizes["target"])), "\(c)")
            #expect(close(layout.sizes.progress, double(sizes["progress"])), "\(c)")
            #expect(close(layout.sizes.footer, double(sizes["footer"])), "\(c)")
            #expect(close(layout.sizes.value, double(sizes["value"])), "\(c)")
            #expect(close(layout.sizes.suffix, double(sizes["suffix"])), "\(c)")
            #expect(layout.titleLines == int(e["titleLines"]), "\(c)")
            #expect(layout.resourceLines == int(e["resourceLines"]), "\(c)")
            #expect(layout.showTarget == bool(e["showTarget"]), "\(c)")
            #expect(layout.showFooter == bool(e["showFooter"]), "\(c)")
            #expect(layout.progressLines == int(e["progressLines"]), "\(c)")
            #expect(close(layout.textWidth, double(e["textWidth"])), "\(c)")
            #expect(close(layout.ringDiameter, double(ring["diameter"])), "\(c)")
            #expect(close(layout.ringStroke, double(ring["stroke"])), "\(c)")
            #expect(layout.compact == bool(e["compact"]), "\(c)")
            #expect(layout.fits == bool(e["fits"]), "\(c)")
        }
    }

    @Test func goalPercents() {
        let cases = StudioVectors.cases("goalPercents")
        #expect(!cases.isEmpty)
        for c in cases {
            let progress = optionalDouble(c["progress"])
            #expect(Goals.percent(progress) == (c["percent"] is NSNull ? nil : int(c["percent"])), "\(c)")
            #expect(Goals.reached(progress) == bool(c["reached"]), "\(c)")
        }
    }

    @Test func goalTimeTexts() {
        let cases = StudioVectors.cases("goalTimeTexts")
        #expect(!cases.isEmpty)
        for c in cases {
            let text = Goals.timeText(
                period: c["period"] as! String, periodEnd: c["periodEnd"] as! String,
                reachedAt: optionalString(c["reachedAt"]), progress: optionalDouble(c["progress"]),
                now: ISODate.parse(c["now"] as! String)!, timeZone: c["timeZone"] as! String)
            let expected: GoalTimeText? = (c["text"] as? [String: Any]).map {
                switch $0["kind"] as! String {
                case "days": return .days(int($0["days"]))
                case "last_day": return .lastDay
                case "hours": return .hours(int($0["hours"]))
                case "under_hour": return .underHour
                default: return .early(int($0["days"]))
                }
            }
            #expect(text == expected, "\(c)")
        }
    }

    @Test func aReachedGoalIsTintedTowardsUp() {
        let derived = DerivedSurfaces(.netricsDark)
        #expect(derived.kind == .layered)
        #expect(derived.reachedBorder == TintedColor(ThemeColor.parse(ThemeTokens.netricsDark.up)!, 0.35))
        #expect(derived.reachedGlow != nil)
        #expect(derived.reachedTop != derived.widgetTop)
    }

    @Test func wordsTheTimeInBothLanguages() {
        #expect(Goals.words(.days(9), language: .en) == "9 days left")
        #expect(Goals.words(.days(1), language: .de) == "noch 1 Tag")
        #expect(Goals.words(.early(2), language: .en) == "2 days early")
        #expect(Goals.words(.hours(5), language: .de) == "noch 5 Std.")
        #expect(Goals.words(.lastDay, language: .de) == "letzter Tag")
    }
}
