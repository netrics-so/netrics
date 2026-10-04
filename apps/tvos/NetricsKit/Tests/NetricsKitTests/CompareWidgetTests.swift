import Foundation
import Testing

@testable import NetricsKit

// The compare widget (ADR 0019 section 10): the shared vectors for ratioOf,
// compareChange and compareLayout, its texts, and decoding.

private func number(_ any: Any?) -> Double? { (any as? NSNumber)?.doubleValue }
private func double(_ any: Any?) -> Double { (any as! NSNumber).doubleValue }
private func int(_ any: Any?) -> Int { (any as! NSNumber).intValue }
private func bool(_ any: Any?) -> Bool { (any as! NSNumber).boolValue }
private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)) }

private func valueText(_ any: Any?) -> StudioLayout.TableValueText {
    let v = any as! [String: Any]
    return StudioLayout.TableValueText(full: v["full"] as! String, compact: v["compact"] as! String)
}

@Suite struct CompareVectorTests {
    @Test func ratios() {
        let cases = StudioVectors.cases("ratios")
        #expect(!cases.isEmpty)
        for c in cases {
            let ratio = StudioLayout.ratioOf(number(c["numerator"]), number(c["denominator"]))
            let expected = number(c["ratio"])
            if let expected {
                #expect(ratio.map { close($0, expected) } == true, "\(c)")
            } else {
                #expect(ratio == nil, "\(c)")
            }
        }
    }

    @Test func compareChanges() {
        let cases = StudioVectors.cases("compareChanges")
        #expect(!cases.isEmpty)
        for c in cases {
            let change = StudioLayout.compareChange(
                value: number(c["value"]), previousValue: number(c["previousValue"]),
                format: CompareFormat(rawValue: c["format"] as! String)!)
            if let expected = c["change"] as? [String: Any] {
                #expect(change?.kind.rawValue == expected["kind"] as? String, "\(c)")
                #expect(change?.direction.rawValue == expected["direction"] as? String, "\(c)")
                #expect(change.map { close($0.value, double(expected["value"])) } == true, "\(c)")
            } else {
                #expect(change == nil, "\(c)")
            }
        }
    }

    @Test func compareLayouts() {
        let cases = StudioVectors.cases("compareLayouts")
        #expect(!cases.isEmpty)
        for c in cases {
            let layout = StudioLayout.compareLayout(
                label: c["label"] as! String, width: double(c["width"]), height: double(c["height"]),
                fontScale: double(c["fontScale"]), numerator: valueText(c["numerator"]),
                denominator: valueText(c["denominator"]), ratio: c["ratio"] as! String,
                ratioLabel: c["ratioLabel"] as! String, change: c["change"] as? String)
            let e = c["layout"] as! [String: Any]
            let sizes = e["sizes"] as! [String: Any]
            #expect(close(layout.sizes.title, double(sizes["title"])), "\(c)")
            #expect(close(layout.sizes.resource, double(sizes["resource"])), "\(c)")
            #expect(close(layout.sizes.small, double(sizes["small"])), "\(c)")
            #expect(close(layout.sizes.operand, double(sizes["operand"])), "\(c)")
            #expect(close(layout.sizes.caption, double(sizes["caption"])), "\(c)")
            #expect(close(layout.sizes.ratio, double(sizes["ratio"])), "\(c)")
            #expect(close(layout.sizes.change, double(sizes["change"])), "\(c)")
            #expect(layout.titleLines == int(e["titleLines"]), "\(c)")
            #expect(layout.resourceLines == int(e["resourceLines"]), "\(c)")
            #expect(layout.showPeriod == bool(e["showPeriod"]), "\(c)")
            #expect(layout.showFooter == bool(e["showFooter"]), "\(c)")
            #expect(layout.compact == bool(e["compact"]), "\(c)")
            #expect(close(layout.captionWidth, double(e["captionWidth"])), "\(c)")
            #expect(layout.ratioLine.rawValue == e["ratioLine"] as! String, "\(c)")
        }
    }

    @Test func minimumAndTypeScale() {
        #expect(StudioLayout.minimumSize(.compare) == (4, 3))
        #expect(StudioWidgetType.compare.isData)
        #expect(StudioWidgetType.compare.hasLabel)
        let sizes = StudioLayout.typeScale(.compare, placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3))
        #expect(sizes[.operand] == 48)
        #expect(sizes[.valueMin] == 64)
    }
}

@Suite struct CompareTextTests {
    @Test func downloadsOverVisitors() {
        // The acceptance example: "32.7%" with "▲ 1.9 pt".
        let ratio = StudioLayout.ratioOf(12_500, 38_200)
        #expect(CompareText.ratio(ratio, format: .percent, unit: nil) == "32.7%")
        let change = StudioLayout.compareChange(value: 0.327, previousValue: 0.308, format: .percent)!
        #expect(CompareText.change(change) == "▲ 1.9 pt")
        #expect(CompareText.change(change, language: .de) == "▲ 1,9 Pp.")
        #expect(CompareText.ratio(0.327, format: .percent, unit: nil, language: .de) == "32,7%")
        #expect(CompareText.ratio(0.05, format: .percent, unit: nil) == "5%")
        #expect(CompareText.ratio(0.0512, format: .percent, unit: nil) == "5.12%")
    }

    @Test func ratiosAndAmountsPerUnit() {
        // Review stars ÷ reviews: the average rating.
        #expect(CompareText.ratio(StudioLayout.ratioOf(2_310, 500), format: .ratio, unit: nil) == "4.62")
        #expect(CompareText.ratio(42, format: .ratio, unit: "EUR_minor") == "€0.42")
        let change = StudioLayout.compareChange(value: 4.62, previousValue: 4.4, format: .ratio)!
        #expect(CompareText.change(change) == "▲ +5%")
        let down = StudioLayout.compareChange(value: 4.4, previousValue: 4.62, format: .ratio)!
        #expect(CompareText.change(down) == "▼ −4.8%")
    }

    @Test func aZeroDenominatorIsADash() {
        #expect(CompareText.ratio(StudioLayout.ratioOf(5, 0), format: .percent, unit: nil) == "–")
        #expect(CompareText.ratio(.infinity, format: .ratio, unit: nil) == "–")
    }

    @Test func labelsAndOperands() {
        #expect(CompareText.ratioLabel(CompareWidgetOptions()) == "ratio")
        #expect(CompareText.ratioLabel(CompareWidgetOptions(), language: .de) == "Verhältnis")
        #expect(CompareText.ratioLabel(CompareWidgetOptions(ratioLabel: "conversion")) == "conversion")
        let operand = CompareText.operand(CompareOperand(label: "Downloads", value: 12_500, unit: "count"))
        #expect(operand.full == "12.5K")
        #expect(operand.compact == "12.5K")
        #expect(CompareText.operand(CompareOperand(label: "Visitors", value: nil, unit: "count")).full == "—")
        #expect(CompareText.footerCandidates(updatedAt: nil) == ["derived"])
    }
}

private func compare(_ id: String, data: String? = nil, options: String? = nil) -> String {
    let payload = """
        {"period": "last_7_days", "aggregation": "sum", "unit": null, "conversion": null,
         "kind": "delta", "granularity": "day", "better": "higher", "status": "ok",
         "updatedAt": "2026-10-04T08:00:00.000Z",
         "numerator": {"label": "Downloads", "value": 12500, "unit": "count"},
         "denominator": {"label": "Visitors", "value": 38200, "unit": "visitors"},
         "ratio": {"value": 0.327, "previousValue": 0.308, "format": "percent"}}
        """
    return """
        {"id": "\(id)", "type": "compare", "x": 0, "y": 0, "w": 4, "h": 3, "min": {"w": 4, "h": 3},
         "label": "Downloads · Wurfel",
         "options": \(options ?? #"{"format": "percent", "ratioLabel": "conversion", "showChange": true}"#),
         "data": \(data ?? payload)}
        """
}

private func slides(_ widgets: String) -> String {
    #"[{"id": "\#(slideA)", "durationSec": 20, "background": null, "widgets": [\#(widgets)], "layouts": []}]"#
}

@Suite struct CompareDecodingTests {
    @Test func decodesACompareWidget() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(compare("c")))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.minimum == StudioMinimum(w: 4, h: 3))
        guard case .compare(let options, let data) = widget.content else {
            Issue.record("compare")
            return
        }
        #expect(options == CompareWidgetOptions(format: .percent, ratioLabel: "conversion", showChange: true))
        #expect(data.numerator == CompareOperand(label: "Downloads", value: 12_500, unit: "count"))
        #expect(data.denominator == CompareOperand(label: "Visitors", value: 38_200, unit: "visitors"))
        #expect(data.ratio == CompareRatio(value: 0.327, previousValue: 0.308, format: .percent))
        #expect(data.unit == nil)
        #expect(data.period == .last7Days)
    }

    @Test func unknownOptionsFallBack() throws {
        let json = compare("c", options: #"{"format": "fraction", "ratioLabel": null}"#)
        let widget = try #require(v3Payload(primaryFormat: "16x9", slides: slides(json)).slides.first?.widgets.first)
        guard case .compare(let options, _) = widget.content else {
            Issue.record("compare")
            return
        }
        #expect(options == CompareWidgetOptions(format: .percent, ratioLabel: nil, showChange: true))
    }

    @Test func aMissingRatioDecodesAsNoRatio() throws {
        let data = """
            {"period": "today", "aggregation": "sum", "unit": null, "status": "no_data", "updatedAt": null,
             "numerator": {"label": "Downloads", "value": null, "unit": null},
             "denominator": {"label": "Visitors", "value": 0, "unit": "count"},
             "ratio": {"value": null, "previousValue": null, "format": "ratio"}}
            """
        let widget = try #require(
            v3Payload(primaryFormat: "16x9", slides: slides(compare("c", data: data))).slides.first?.widgets.first)
        guard case .compare(_, let decoded) = widget.content else {
            Issue.record("compare")
            return
        }
        #expect(decoded.ratio.value == nil)
        #expect(decoded.ratio.format == .ratio)
        #expect(decoded.status == .noData)
    }

    @Test func unreadableDataIsAnEmptyCell() throws {
        let payload = v3Payload(primaryFormat: "16x9", slides: slides(compare("c", data: #""not data""#)))
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.type == "compare")
        #expect(widget.content == .unsupported)
    }
}
