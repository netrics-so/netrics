import Foundation
import Testing

@testable import NetricsKit

// netrics TV on iPad (#412, ADR 0021 section 3): the format from the window's
// size across the windows current iPads open, the rotation setting ignored,
// the display mode setting, the idle timer rule and the heartbeat's screen.

/** Window sizes in points, portrait side first where the window is the full screen. */
private struct PadWindow: CustomTestStringConvertible, Sendable {
    var name: String
    var width: Double
    var height: Double
    var format: ScreenFormat

    var testDescription: String { "\(name) \(Int(width))×\(Int(height))" }
}

/**
 * The full screens of the iPads iPadOS 27 runs on, in both orientations.
 * iPad mini in portrait (0.657) is the closest to the 3x4 / 9x16 boundary
 * (0.65) and stays 3x4; in landscape (1.523) it stays 4x3 below 1.54.
 */
private let fullScreens: [(name: String, short: Double, long: Double)] = [
    ("iPad Pro 13-inch", 1032, 1376),
    ("iPad Pro 11-inch", 834, 1210),
    ("iPad Air 13-inch", 1024, 1366),
    ("iPad Air 11-inch", 820, 1180),
    ("iPad 11-inch", 820, 1180),
    ("iPad mini", 744, 1133),
]

private let fullScreenWindows: [PadWindow] = fullScreens.flatMap { pad in
    [
        PadWindow(name: "\(pad.name) landscape", width: pad.long, height: pad.short, format: .standard),
        PadWindow(name: "\(pad.name) portrait", width: pad.short, height: pad.long, format: .portrait),
    ]
}

/**
 * Split View, Slide Over and Stage Manager windows (sizes as iPadOS reports
 * them, rounded): every size gets screen view in the format of its aspect.
 */
private let otherWindows: [PadWindow] = [
    // Split View on a landscape iPad Pro 13-inch: halves, thirds.
    PadWindow(name: "Split View 1/2", width: 678, height: 1032, format: .portrait),
    PadWindow(name: "Split View 1/3", width: 375, height: 1032, format: .tall),
    PadWindow(name: "Split View 2/3", width: 991, height: 1032, format: .portrait),
    // Split View on a portrait iPad Pro 11-inch.
    PadWindow(name: "Split View portrait 1/2", width: 414, height: 1210, format: .tall),
    // Slide Over.
    PadWindow(name: "Slide Over", width: 375, height: 1000, format: .tall),
    // Stage Manager: the smallest window, and wide and square ones.
    PadWindow(name: "Stage Manager smallest", width: 320, height: 568, format: .tall),
    PadWindow(name: "Stage Manager wide", width: 1300, height: 620, format: .ultrawide),
    PadWindow(name: "Stage Manager 16:9", width: 1280, height: 720, format: .widescreen),
    PadWindow(name: "Stage Manager square", width: 800, height: 800, format: .standard),
    PadWindow(name: "Stage Manager nearly square", width: 790, height: 800, format: .portrait),
]

private func metricJSON(_ id: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> String {
    """
    {"id": "\(id)", "type": "metric", "x": \(x), "y": \(y), "w": \(w), "h": \(h), "label": "Signups · \(id)",
     "options": {"showSparkline": true, "showChange": true},
     "data": {"period": "last_7_days", "aggregation": "sum", "value": 1200, "unit": "count", "conversion": null,
              "change": {"previousValue": 1000, "delta": 200, "ratio": 0.2}, "spark": [1, 2, 3], "status": "ok",
              "updatedAt": "2026-10-04T08:00:00.000Z", "better": "higher"}}
    """
}

private func lineJSON(_ id: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> String {
    """
    {"id": "\(id)", "type": "line", "x": \(x), "y": \(y), "w": \(w), "h": \(h), "label": "Revenue · \(id)",
     "options": {"showPrevious": false, "showAxis": true},
     "data": {"period": "last_7_days", "aggregation": "sum", "value": 9900, "unit": "count", "conversion": null,
              "change": {"previousValue": null, "delta": null, "ratio": null},
              "buckets": ["2026-09-28T00:00:00.000Z"], "values": [1], "previous": [], "status": "ok",
              "updatedAt": null, "better": "higher"}}
    """
}

/** A typical 16x9 dashboard: four metrics over a wide chart, and a second slide. */
private let widescreenSlides = """
    [
      {"id": "\(slideA)", "name": "Sales", "durationSec": 20, "background": null,
       "widgets": [\(metricJSON("m1", 0, 0, 3, 3)), \(metricJSON("m2", 3, 0, 3, 3)), \(metricJSON("m3", 6, 0, 3, 3)),
                   \(metricJSON("m4", 9, 0, 3, 3)), \(lineJSON("l1", 0, 3, 12, 5))]},
      {"id": "\(slideB)", "name": "Team", "durationSec": 10, "background": null,
       "widgets": [\(metricJSON("t1", 0, 0, 6, 4)), \(metricJSON("t2", 6, 0, 6, 4))]}
    ]
    """

/** The 16x9 dashboard above, with the device set to a quarter turn and screen view. */
private func padPayload(displayMode: DisplayMode = .screen) -> DeviceDashboardV2 {
    var payload = v3Payload(primaryFormat: "16x9", rotation: "90", slides: widescreenSlides)
    payload.device.displayMode = displayMode
    return payload
}

@Suite struct PadScreenTests {
    @Test(arguments: fullScreenWindows + otherWindows)
    fileprivate func formatFollowsTheWindow(_ window: PadWindow) {
        let payload = padPayload()
        let size = StudioCanvas(width: window.width, height: window.height)
        #expect(PadScreen.format(payload, window: size) == window.format)
        // The slide's frame stays inside the window, whatever its size.
        let geometry = ScreenView.geometry(viewport: size, format: window.format, showHeader: true)
        let canvas = geometry.frame.canvas
        #expect(canvas.x >= -0.001 && canvas.y >= -0.001)
        #expect(canvas.x + canvas.width <= window.width + 0.001)
        #expect(canvas.y + canvas.height <= window.height + 0.001)
    }

    @Test(arguments: fullScreens)
    func turningTheIPadSwitchesBetween4x3And3x4(_ pad: (name: String, short: Double, long: Double)) {
        let payload = padPayload()
        #expect(PadScreen.format(payload, window: StudioCanvas(width: pad.long, height: pad.short)) == .standard)
        #expect(PadScreen.format(payload, window: StudioCanvas(width: pad.short, height: pad.long)) == .portrait)
    }

    @Test func theRotationSettingIsIgnored() {
        // A quarter turn would make a TV lay out 1032 × 1376; the iPad keeps its window.
        let payload = padPayload()
        #expect(payload.device.rotation == .quarter)
        #expect(PadScreen.format(payload, window: StudioCanvas(width: 1376, height: 1032)) == .standard)
        let report = PadScreen.report(window: StudioCanvas(width: 1376, height: 1032), scale: 2, payload: payload)
        #expect(report == DeviceScreenReport(width: 1376, height: 1032, scale: 2, format: "4x3", mode: "screen"))
    }

    @Test(arguments: [ScreenFormat.standard, .portrait])
    func everyWidgetShowsIn4x3And3x4(_ format: ScreenFormat) {
        // No widget is left out: the auto reflow places each one on a page.
        let payload = padPayload()
        let pages = ScreenView.pages(payload, format: format)
        for slide in payload.slides {
            let shown = pages.filter { $0.slideId == slide.id }.flatMap(\.placements).map(\.id)
            #expect(Set(shown) == Set(slide.widgets.map(\.id)))
            #expect(shown.count == slide.widgets.count)
        }
        // Every placement lies inside the format's grid.
        for page in pages {
            for placement in page.placements {
                #expect(placement.x >= 0 && placement.y >= 0)
                #expect(placement.x + placement.w <= format.spec.columns)
                #expect(placement.y + placement.h <= format.spec.rows)
            }
        }
        // The header shows the dashboard's name in full.
        #expect(StudioLayout.headerFit(name: "Lobby", slideName: "Sales", format: format, logoAspect: nil).fits)
    }

    @Test func displayModeFollowsTheDeviceSetting() {
        #expect(PadScreen.displayMode(padPayload(displayMode: .screen)) == .screen)
        #expect(PadScreen.displayMode(padPayload(displayMode: .scroll)) == .scroll)
        // Schema 2 knows no display mode: screen view, as on the TV.
        let v2 = try! JSONDecoder().decode(DeviceDashboardV2.self, from: Data(v2JSON().utf8))
        #expect(PadScreen.displayMode(v2) == .screen)
        #expect(PadScreen.format(v2, window: StudioCanvas(width: 1032, height: 1376)) == .widescreen)
        let report = PadScreen.report(
            window: StudioCanvas(width: 820, height: 1180), scale: 2, payload: padPayload(displayMode: .scroll))
        #expect(report == DeviceScreenReport(width: 820, height: 1180, scale: 2, format: "3x4", mode: "scroll"))
    }

    @Test func screenStaysOnOnlyInScreenViewInTheForeground() {
        #expect(PadScreen.keepsScreenOn(mode: .screen, foreground: true))
        #expect(!PadScreen.keepsScreenOn(mode: .screen, foreground: false))
        #expect(!PadScreen.keepsScreenOn(mode: .scroll, foreground: true))
        #expect(!PadScreen.keepsScreenOn(mode: .scroll, foreground: false))
    }
}
