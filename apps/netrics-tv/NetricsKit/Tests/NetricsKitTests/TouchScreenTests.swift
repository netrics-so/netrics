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

private let padLandscape = StudioCanvas(width: 1376, height: 1032)

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
        #expect(TouchScreen.format(payload, window: size) == window.format)
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
        #expect(TouchScreen.format(payload, window: StudioCanvas(width: pad.long, height: pad.short)) == .standard)
        #expect(TouchScreen.format(payload, window: StudioCanvas(width: pad.short, height: pad.long)) == .portrait)
    }

    @Test func theRotationSettingIsIgnored() {
        // A quarter turn would make a TV lay out 1032 × 1376; the iPad keeps its window.
        let payload = padPayload()
        #expect(payload.device.rotation == .quarter)
        #expect(TouchScreen.format(payload, window: StudioCanvas(width: 1376, height: 1032)) == .standard)
        let report = TouchScreen.report(
            window: StudioCanvas(width: 1376, height: 1032), scale: 2, payload: payload, device: .pad)
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
        #expect(TouchScreen.displayMode(padPayload(displayMode: .screen), device: .pad, window: padLandscape) == .screen)
        #expect(TouchScreen.displayMode(padPayload(displayMode: .scroll), device: .pad, window: padLandscape) == .scroll)
        // Schema 2 knows no display mode: screen view, as on the TV.
        let v2 = try! JSONDecoder().decode(DeviceDashboardV2.self, from: Data(v2JSON().utf8))
        #expect(TouchScreen.displayMode(v2, device: .pad, window: padLandscape) == .screen)
        #expect(TouchScreen.format(v2, window: StudioCanvas(width: 1032, height: 1376)) == .widescreen)
        let report = TouchScreen.report(
            window: StudioCanvas(width: 820, height: 1180), scale: 2, payload: padPayload(displayMode: .scroll),
            device: .pad)
        #expect(report == DeviceScreenReport(width: 820, height: 1180, scale: 2, format: "3x4", mode: "scroll"))
    }

    @Test func screenStaysOnOnlyInScreenViewInTheForeground() {
        #expect(TouchScreen.keepsScreenOn(mode: .screen, foreground: true))
        #expect(!TouchScreen.keepsScreenOn(mode: .screen, foreground: false))
        #expect(!TouchScreen.keepsScreenOn(mode: .scroll, foreground: true))
        #expect(!TouchScreen.keepsScreenOn(mode: .scroll, foreground: false))
    }
}

// netrics TV on iPhone (#413, ADR 0021 section 3): scroll view in portrait,
// screen view in landscape in the phone's format, `display_mode = screen`
// keeping screen view in portrait, and the heartbeat reporting what is shown.

/** The iPhones iOS 27 runs on, by their full-screen size in portrait (points). */
private let phones: [(name: String, short: Double, long: Double, landscape: ScreenFormat)] = [
    ("iPhone SE (2nd and 3rd generation)", 375, 667, .widescreen),
    ("iPhone 11", 414, 896, .ultrawide),
    ("iPhone 13 mini", 375, 812, .ultrawide),
    ("iPhone 14", 390, 844, .ultrawide),
    ("iPhone 16", 393, 852, .ultrawide),
    ("iPhone 16 Pro", 402, 874, .ultrawide),
    ("iPhone 16 Pro Max", 440, 956, .ultrawide),
    ("iPhone Air", 420, 912, .ultrawide),
]

private func phonePayload(displayMode: DisplayMode = .scroll) -> DeviceDashboardV2 {
    padPayload(displayMode: displayMode)
}

@Suite struct PhoneScreenTests {
    @Test(arguments: phones)
    func portraitScrollsAndLandscapeIsScreenView(
        _ phone: (name: String, short: Double, long: Double, landscape: ScreenFormat)
    ) {
        let payload = phonePayload()
        let portrait = StudioCanvas(width: phone.short, height: phone.long)
        let landscape = StudioCanvas(width: phone.long, height: phone.short)
        #expect(TouchScreen.displayMode(payload, device: .phone, window: portrait) == .scroll)
        #expect(TouchScreen.displayMode(payload, device: .phone, window: landscape) == .screen)
        #expect(TouchScreen.format(payload, window: landscape) == phone.landscape)
        #expect(TouchScreen.format(payload, window: portrait) == .tall)
        // The heartbeat says what is shown: the mode and the window's format.
        #expect(
            TouchScreen.report(window: landscape, scale: 3, payload: payload, device: .phone)
                == DeviceScreenReport(
                    width: Int(phone.long), height: Int(phone.short), scale: 3, format: phone.landscape.rawValue,
                    mode: "screen"))
        #expect(
            TouchScreen.report(window: portrait, scale: 3, payload: payload, device: .phone)
                == DeviceScreenReport(
                    width: Int(phone.short), height: Int(phone.long), scale: 3, format: "9x16", mode: "scroll"))
    }

    @Test(arguments: phones)
    func screenSettingKeepsScreenViewInPortrait(
        _ phone: (name: String, short: Double, long: Double, landscape: ScreenFormat)
    ) {
        let payload = phonePayload(displayMode: .screen)
        let portrait = StudioCanvas(width: phone.short, height: phone.long)
        #expect(TouchScreen.displayMode(payload, device: .phone, window: portrait) == .screen)
        #expect(
            TouchScreen.displayMode(payload, device: .phone, window: StudioCanvas(width: phone.long, height: phone.short))
                == .screen)
        #expect(
            TouchScreen.report(window: portrait, scale: 3, payload: payload, device: .phone)?.format == "9x16")
        #expect(TouchScreen.report(window: portrait, scale: 3, payload: payload, device: .phone)?.mode == "screen")
    }

    @Test func turningThePhoneSwitchesAtOnce() {
        // Each size the window passes through decides on its own: no state, no network.
        let payload = phonePayload()
        let sizes = [(402.0, 874.0), (874, 402), (402, 874), (874, 402)]
        let modes = sizes.map {
            TouchScreen.displayMode(payload, device: .phone, window: StudioCanvas(width: $0.0, height: $0.1))
        }
        #expect(modes == [.scroll, .screen, .scroll, .screen])
        // Screen view keeps the idle timer off only while it shows, in the foreground.
        #expect(modes.map { TouchScreen.keepsScreenOn(mode: $0, foreground: true) } == [false, true, false, true])
    }

    @Test func theRotationSettingIsIgnoredOnThePhone() {
        // A quarter turn would make a TV lay out turned; the phone keeps its window.
        let payload = phonePayload()
        #expect(payload.device.rotation == .quarter)
        #expect(TouchScreen.format(payload, window: StudioCanvas(width: 874, height: 402)) == .ultrawide)
    }

    @Test func schema2PhonesScrollInPortraitAndShow16x9InLandscape() throws {
        let v2 = try JSONDecoder().decode(DeviceDashboardV2.self, from: Data(v2JSON().utf8))
        #expect(TouchScreen.displayMode(v2, device: .phone, window: StudioCanvas(width: 402, height: 874)) == .scroll)
        let landscape = StudioCanvas(width: 874, height: 402)
        #expect(TouchScreen.displayMode(v2, device: .phone, window: landscape) == .screen)
        #expect(TouchScreen.format(v2, window: landscape) == .widescreen)
    }

    @Test func iPadIgnoresTheOrientationForTheMode() {
        for mode in DisplayMode.allCases {
            let payload = padPayload(displayMode: mode)
            #expect(TouchScreen.displayMode(payload, device: .pad, window: StudioCanvas(width: 820, height: 1180)) == mode)
            #expect(TouchScreen.displayMode(payload, device: .pad, window: StudioCanvas(width: 1180, height: 820)) == mode)
        }
    }

    @Test func beforeADashboardTheReportIsTheDevicesDefault() {
        #expect(
            TouchScreen.report(window: StudioCanvas(width: 402, height: 874), scale: 3, payload: nil, device: .phone)
                == DeviceScreenReport(width: 402, height: 874, scale: 3, format: "9x16", mode: "scroll"))
        #expect(
            TouchScreen.report(window: StudioCanvas(width: 874, height: 402), scale: 3, payload: nil, device: .phone)?
                .mode == "screen")
        #expect(
            TouchScreen.report(window: StudioCanvas(width: 1180, height: 820), scale: 2, payload: nil, device: .pad)
                == DeviceScreenReport(width: 1180, height: 820, scale: 2, format: "4x3", mode: "screen"))
    }

    @Test func theDemoShowsEachDevicesDefault() {
        // One bundled payload set to screen view: the phone still scrolls in portrait.
        let payload = phonePayload(displayMode: .screen)
        let portrait = StudioCanvas(width: 402, height: 874)
        #expect(TouchScreen.displayMode(payload, device: .phone, window: portrait, demo: true) == .scroll)
        #expect(
            TouchScreen.displayMode(payload, device: .phone, window: StudioCanvas(width: 874, height: 402), demo: true)
                == .screen)
        #expect(TouchScreen.displayMode(padPayload(displayMode: .scroll), device: .pad, window: padLandscape, demo: true) == .screen)
    }
}
