import Foundation
import Testing

@testable import NetricsKit

// Schema 3 (ADR 0017, section 9; deviceDashboardV3ResponseSchema): decoding,
// negotiation, the rotation setting, a slide's pages per format and their
// rotation, the header rule and what the heartbeat reports.

let slideC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

let formatsJSON = """
    {"16x9": {"columns": 12, "rows": 8, "reference": [1920, 1080]},
     "21x9": {"columns": 16, "rows": 8, "reference": [2520, 1080]},
     "4x3": {"columns": 9, "rows": 8, "reference": [1440, 1080]},
     "3x4": {"columns": 6, "rows": 10, "reference": [1080, 1440]},
     "9x16": {"columns": 6, "rows": 14, "reference": [1080, 1920]}}
    """

private func metric(_ id: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> String {
    """
    {"id": "\(id)", "type": "metric", "x": \(x), "y": \(y), "w": \(w), "h": \(h), "label": "Downloads · \(id)",
     "options": {"showSparkline": true, "showChange": true},
     "data": {"period": "last_7_days", "aggregation": "sum", "value": 12, "unit": "count", "conversion": null,
              "change": {"previousValue": 10, "delta": 2, "ratio": 0.2}, "spark": [1, 2], "status": "ok",
              "updatedAt": "2026-10-04T08:00:00.000Z", "better": "higher"}}
    """
}

private func line(_ id: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> String {
    """
    {"id": "\(id)", "type": "line", "x": \(x), "y": \(y), "w": \(w), "h": \(h), "label": "Revenue · \(id)",
     "options": {"showPrevious": false, "showAxis": true},
     "data": {"period": "last_7_days", "aggregation": "sum", "value": 9900, "unit": "count", "conversion": null,
              "change": {"previousValue": null, "delta": null, "ratio": null},
              "buckets": ["2026-09-28T00:00:00.000Z"], "values": [1], "previous": [], "status": "ok",
              "updatedAt": null, "better": "higher"}}
    """
}

/** A portrait (9x16) dashboard: three charts stacked, and one slide with a custom 16x9 layout. */
let portraitSlides = """
    [
      {"id": "\(slideA)", "name": "Charts", "durationSec": 20, "background": null,
       "widgets": [\(line("l1", 0, 0, 6, 4)), \(line("l2", 0, 4, 6, 4)), \(line("l3", 0, 8, 6, 4)),
                   \(metric("outside", 2, 12, 6, 2))],
       "layouts": [{"format": "32x9", "pages": 1, "placements": []}],
       "futureField": true},
      {"id": "\(slideB)", "name": "Numbers", "durationSec": 10, "background": null,
       "widgets": [\(metric("m1", 0, 0, 3, 2)), \(metric("m2", 3, 0, 3, 2))],
       "layouts": [{"format": "16x9", "pages": 2, "placements": [
         {"widgetId": "m1", "page": 0, "x": 0, "y": 0, "w": 6, "h": 4, "hidden": false},
         {"widgetId": "m2", "page": 1, "x": 6, "y": 4, "w": 6, "h": 4, "hidden": false}]},
         {"format": "4x3", "pages": 1, "placements": [
         {"widgetId": "m1", "page": 0, "x": 0, "y": 0, "w": 9, "h": 4, "hidden": false},
         {"widgetId": "m2", "page": 0, "x": 0, "y": 4, "w": 9, "h": 4, "hidden": true}]}]}
    ]
    """

func v3JSON(
    version: String = "v3-1", primaryFormat: String = "9x16", rotation: String = "90", slides: String? = nil
) -> String {
    """
    {
      "version": "\(version)",
      "schema": 3,
      "refreshAfterSec": 60,
      "timeZone": "Europe/Berlin",
      "locale": "en",
      "primaryFormat": "\(primaryFormat)",
      "formats": \(formatsJSON),
      "device": {"rotation": \(rotation), "displayMode": "scroll"},
      "dashboard": {"id": "4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "name": "Lobby", "showHeader": true, "logo": null},
      "theme": {"name": "netrics Dark", "tokens": {}},
      "rotation": {"autoAdvance": true, "transition": "fade"},
      "slides": \(slides ?? portraitSlides),
      "images": [],
      "aNewerField": {"x": 1}
    }
    """
}

func v3Payload(
    version: String = "v3-1", primaryFormat: String = "9x16", rotation: String = "90", slides: String? = nil
) -> DeviceDashboardV2 {
    try! JSONDecoder().decode(
        DeviceDashboardV2.self,
        from: Data(v3JSON(version: version, primaryFormat: primaryFormat, rotation: rotation, slides: slides).utf8))
}

func v3Response(version: String = "v3-1") -> HTTPResponse {
    HTTPResponse(status: 200, headers: ["etag": "\"\(version)\""], body: Data(v3JSON(version: version).utf8))
}

@Suite struct PayloadV3DecodingTests {
    @Test func decodesFormatsLayoutsAndTheDeviceSettings() throws {
        let payload = v3Payload()
        #expect(payload.schema == 3)
        #expect(payload.primaryFormat == .tall)
        // tvOS is always screen view, but the setting is read as sent.
        #expect(payload.device == DeviceDisplaySettings(rotation: .quarter, displayMode: .scroll))
        #expect(payload.language == .en)
        // Widgets are placed in the primary's grid: rows up to 14 stay, one
        // outside the 6 columns of 9x16 is left out.
        #expect(payload.slides[0].widgets.map(\.id) == ["l1", "l2", "l3"])
        #expect(payload.slides[0].widgets[2].placement == StudioPlacement(x: 0, y: 8, w: 6, h: 4))
        // A layout of a format this build does not know is dropped.
        #expect(payload.slides[0].layouts.isEmpty)
        let layouts = payload.slides[1].layouts
        #expect(layouts.map(\.format) == [.widescreen, .standard])
        #expect(layouts[0].pages == 2)
        #expect(layouts[0].placements[1] == DeviceLayoutPlacement(widgetId: "m2", page: 1, x: 6, y: 4, w: 6, h: 4))
        #expect(layouts[1].placements[1].hidden)
    }

    @Test func unknownSettingsFallBack() throws {
        // A rotation that is not a quarter turn, or a format this build does
        // not know (laid out as 16x9: widgets outside 12 × 8 are left out).
        let odd = v3Payload(primaryFormat: "32x9", rotation: "45", slides: """
            [{"id": "\(slideA)", "durationSec": 20, "widgets": [\(metric("in", 0, 0, 3, 2)), \(metric("out", 13, 0, 3, 2))]}]
            """)
        #expect(odd.primaryFormat == .widescreen)
        #expect(odd.device.rotation == .none)
        #expect(odd.slides[0].widgets.map(\.id) == ["in"])
        #expect(odd.slides[0].layouts.isEmpty)
    }

    @Test func schema2IgnoresTheNewFields() throws {
        // Schema 2 is always the 16x9 layout, unrotated, whatever it carries.
        var object = try #require(
            try JSONSerialization.jsonObject(with: Data(v2JSON().utf8)) as? [String: Any])
        object["primaryFormat"] = "9x16"
        object["device"] = ["rotation": 90, "displayMode": "screen"]
        let payload = try JSONDecoder().decode(
            DeviceDashboardV2.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(payload.schema == 2)
        #expect(payload.primaryFormat == .widescreen)
        #expect(payload.device.rotation == .none)
        // The 12 × 8 check of schema 2 still applies.
        #expect(payload.slides[0].widgets.map(\.id) == ["w-metric", "w-line", "w-bar", "w-gauge", "w-broken"])
    }

    @Test func payloadReadsSchema3AndRefusesNewerOnes() throws {
        let payload = try JSONDecoder().decode(DashboardPayload.self, from: Data(v3JSON().utf8))
        #expect(payload.schema == 3)
        #expect(payload.version == "v3-1")
        #expect(payload.hasDashboard)
        let v4 = Data(#"{"version": "x", "schema": 4, "slides": [], "tiles": []}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(DashboardPayload.self, from: v4) }
    }

    @Test func cachedSchema3PayloadsRoundTrip() throws {
        let cache = FileDashboardCache(
            fileURL: FileManager.default.temporaryDirectory.appending(path: "netrics-\(UUID().uuidString)/d.json"))
        defer { cache.clear() }
        let entry = CachedDashboard(etag: "\"v3-1\"", payload: .v2(v3Payload()), updatedAt: T0)
        cache.save(entry)
        let loaded = try #require(cache.load())
        #expect(loaded == entry)
        #expect(loaded.payload.schema == 3)
    }
}

@Suite struct SchemaThreeNegotiationTests {
    private func paired(_ routes: @escaping (ManualClock) -> [String: Handler], cached: CachedDashboard? = nil)
        -> Harness
    {
        Harness(credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) }, cached: cached, routes: routes)
    }

    @Test func asksForSchema3WhenTheServerListsIt() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2, 3]) },
                "GET /v1/device/dashboard": { _ in v3Response() },
            ]
        }
        await h.start()
        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests.map(\.query) == ["schema=3", "schema=3"])
        #expect(requests[1].header("if-none-match") == "\"v3-1\"")
        let state = await h.state
        #expect(state.payload?.schema == 3)
        #expect(state.dashboardV2?.primaryFormat == .tall)
    }

    @Test func staysOnSchema2WhenTheServerListsNoMore() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                "GET /v1/device/dashboard": { _ in v2Response() },
            ]
        }
        await h.start()
        await h.advance(0)
        #expect(h.api.callsTo("GET /v1/device/dashboard").map(\.query) == ["schema=2"])
    }

    @Test func dropsTheSchema2ETagWhenMovingTo3() async throws {
        // An upgraded server: the cached schema 2 answer and its ETag stay
        // with schema 2; schema 3 is asked for without it, then cached.
        let cached = CachedDashboard(etag: "\"v2-1\"", payload: .v2(v2Payload()), updatedAt: T0)
        let h = paired(
            { _ in
                [
                    "GET /v1/server": { _ in serverInfo(schemas: [1, 2, 3]) },
                    "GET /v1/device/dashboard": { _ in v3Response() },
                ]
            }, cached: cached)
        await h.start()
        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests[0].query == "schema=3")
        #expect(requests[0].header("if-none-match") == nil)
        #expect(requests[1].header("if-none-match") == "\"v3-1\"")
        let saved = try #require(h.cache.load())
        #expect(saved.payload.schema == 3)
        #expect(saved.etag == "\"v3-1\"")
    }

    @Test func followsAServerThatAnswersSchema2ForSchema3() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2, 3]) },
                "GET /v1/device/dashboard": { _ in v2Response() },
            ]
        }
        await h.start()
        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests.map(\.query) == ["schema=3", "schema=2"])
        #expect(requests[1].header("if-none-match") == "\"v2-1\"")
        #expect(await h.state.payload?.schema == 2)
    }

    @Test func serverInfoPrefersSchema3() throws {
        func preferred(_ schemas: [Int]) -> Int {
            ServerInfo(
                product: "netrics", deviceApiVersion: 1, version: "1", pairingUrl: "https://x.test/a",
                dashboardSchemas: schemas
            ).preferredDashboardSchema
        }
        #expect(preferred([1, 2, 3]) == 3)
        #expect(preferred([1, 2, 3, 4]) == 3)
        #expect(preferred([2, 1]) == 2)
        #expect(preferred([3]) == 3)
    }
}

@Suite struct ScreenRotationTests {
    let tv = StudioCanvas(width: 1920, height: 1080)

    @Test func quarterTurnsSwapTheSides() {
        #expect(ScreenRotation.none.viewport(tv) == tv)
        #expect(ScreenRotation.half.viewport(tv) == tv)
        #expect(ScreenRotation.quarter.viewport(tv) == StudioCanvas(width: 1080, height: 1920))
        #expect(ScreenRotation.threeQuarters.viewport(tv) == StudioCanvas(width: 1080, height: 1920))
    }

    @Test func theRotatedViewportPicksTheFormat() {
        for (rotation, format) in [("0", ScreenFormat.widescreen), ("90", .tall), ("180", .widescreen), ("270", .tall)] {
            let payload = v3Payload(rotation: rotation)
            let viewport = ScreenView.rotation(payload).viewport(tv)
            #expect(ScreenView.format(payload, viewport: viewport) == format)
        }
        // Schema 2 is always the 16x9 layout, unrotated.
        #expect(ScreenView.rotation(v2Payload()) == .none)
        #expect(ScreenView.format(v2Payload(), viewport: StudioCanvas(width: 1080, height: 1920)) == .widescreen)
        #expect(ScreenView.rotation(nil) == .none)
    }

    @Test func theHeartbeatReportsTheRotatedScreen() {
        let portrait = ScreenView.report(screen: tv, scale: 1, payload: v3Payload(rotation: "90"))
        #expect(portrait == DeviceScreenReport(width: 1080, height: 1920, scale: 1, format: "9x16", mode: "screen"))
        // Apple TV is always screen view, whatever the setting says.
        #expect(portrait?.mode == "screen")
        let upsideDown = ScreenView.report(screen: tv, scale: 2, payload: v3Payload(rotation: "180"))
        #expect(upsideDown == DeviceScreenReport(width: 1920, height: 1080, scale: 2, format: "16x9", mode: "screen"))
        let older = ScreenView.report(screen: tv, scale: 1, payload: v2Payload())
        #expect(older == DeviceScreenReport(width: 1920, height: 1080, scale: 1, format: "16x9", mode: "screen"))
        #expect(ScreenView.report(screen: tv, scale: 1, payload: nil)?.format == "16x9")
        #expect(ScreenView.report(screen: StudioCanvas(width: 0, height: 0), scale: 1, payload: nil) == nil)
    }

    @Test func aClassic16x9ScreenRendersExactlyAsBefore() {
        let geometry = ScreenView.geometry(viewport: tv, format: .widescreen, showHeader: true)
        #expect(geometry.classic)
        let cells = StudioPlacement(x: 4, y: 2, w: 8, h: 4)
        let placed = geometry.place(cells)
        let old = StudioLayout.widgetRect(cells, canvas: tv, showHeader: true)
        #expect(abs(placed.rect.x - old.x) < 1e-9 && abs(placed.rect.y - old.y) < 1e-9)
        #expect(abs(placed.rect.width - old.width) < 1e-9 && abs(placed.rect.height - old.height) < 1e-9)
        #expect(placed.placement.unitBox == nil)
        #expect(abs(geometry.frame.unit - 1) < 1e-12)
    }

    @Test func aPortraitViewportFillsWith9x16() throws {
        let viewport = StudioCanvas(width: 1080, height: 1920)
        let geometry = ScreenView.geometry(viewport: viewport, format: .tall, showHeader: true)
        #expect(!geometry.classic)
        #expect(geometry.frame.canvas == StudioRect(x: 0, y: 0, width: 1080, height: 1920))
        #expect(geometry.frame.columns == 6 && geometry.frame.rows == 14)
        // The whole grid width: six columns of the 9x16 grid, in units.
        let full = geometry.place(StudioPlacement(x: 0, y: 0, w: 6, h: 4))
        let box = try #require(full.placement.unitBox)
        #expect(abs(box.width - (1080 - 2 * StudioLayout.padding)) < 1e-9)
        #expect(full.placement.format == .tall)
        // A 4K TV turned 90°: the same layout at twice the points per unit.
        let large = ScreenView.geometry(
            viewport: StudioCanvas(width: 2160, height: 3840), format: .tall, showHeader: true)
        #expect(abs(large.frame.unit - 2) < 1e-12)
    }
}

@Suite struct ScreenPageTests {
    @Test func aPortraitDesignOnALandscapeTVContinuesOnPages() {
        let payload = v3Payload()
        let pages = ScreenView.pages(payload, format: .widescreen)
        // Slide A: three 6 × 4 charts stacked are 12 rows; 16x9 has 8. Slide
        // B has a custom 16x9 layout of two pages.
        #expect(pages.map(\.id) == [slideA, "\(slideA)#2", slideB, "\(slideB)#2"])
        #expect(pages.map(\.pageLabel) == ["1/2", "2/2", "1/2", "2/2"])
        // Each page shows for the slide's full duration.
        #expect(pages.map(\.durationSec) == [20, 20, 10, 10])
        #expect(pages[0].placements.map(\.id) == ["l1", "l2"])
        #expect(pages[1].placements.map(\.id) == ["l3"])
        #expect(pages[3].placements == [LayoutPlacement(id: "m2", x: 6, y: 4, w: 6, h: 4)])
        for page in pages {
            for placement in page.placements {
                #expect(StudioLayout.isInsideFormatGrid(placement.cells, format: .widescreen))
            }
        }
    }

    @Test func thePrimaryFormatShowsTheDesignOnOnePage() {
        let pages = ScreenView.pages(v3Payload(), format: .tall)
        #expect(pages.map(\.id) == [slideA, slideB])
        #expect(pages.allSatisfy { $0.pageLabel == nil })
        #expect(pages[0].placements.map(\.cells) == [
            StudioPlacement(x: 0, y: 0, w: 6, h: 4), StudioPlacement(x: 0, y: 4, w: 6, h: 4),
            StudioPlacement(x: 0, y: 8, w: 6, h: 4),
        ])
    }

    @Test func hiddenWidgetsAreLeftOutOfACustomLayout() {
        let pages = ScreenView.pages(v3Payload(), format: .standard)
        let numbers = pages.filter { $0.slideId == slideB }
        #expect(numbers.count == 1)
        #expect(numbers[0].placements == [LayoutPlacement(id: "m1", x: 0, y: 0, w: 9, h: 4)])
    }

    @Test func aCustomLayoutIsCompletedForAWidgetItDoesNotKnow() {
        // The stored layout predates m3: it is placed automatically.
        let slides = """
            [{"id": "\(slideB)", "durationSec": 10,
              "widgets": [\(metric("m1", 0, 0, 3, 2)), \(metric("m3", 3, 0, 3, 2))],
              "layouts": [{"format": "16x9", "pages": 1, "placements": [
                {"widgetId": "m1", "page": 0, "x": 0, "y": 0, "w": 6, "h": 4, "hidden": false},
                {"widgetId": "gone", "page": 0, "x": 6, "y": 0, "w": 6, "h": 4, "hidden": false}]}]}]
            """
        let pages = ScreenView.pages(v3Payload(slides: slides), format: .widescreen)
        let ids = Set(pages.flatMap { $0.placements.map(\.id) })
        #expect(ids == ["m1", "m3"])
    }

    @Test func a16x9DashboardReflowsOnAPortraitTV() {
        // The schema 2 fixture's first slide as a schema 3 16x9 dashboard.
        let landscape = v3Payload(primaryFormat: "16x9", rotation: "90", slides: defaultSlides)
        let pages = ScreenView.pages(landscape, format: .tall)
        #expect(pages.first?.id == slideA)
        for page in pages {
            for placement in page.placements {
                #expect(StudioLayout.isInsideFormatGrid(placement.cells, format: .tall))
            }
        }
        // Nothing dropped: every widget of each slide is on one of its pages.
        for slide in landscape.slides {
            let placed = pages.filter { $0.slideId == slide.id }.flatMap { $0.placements.map(\.id) }
            #expect(placed.sorted() == slide.widgets.map(\.id).sorted())
        }
    }

    @Test func aSlideWithoutWidgetsIsOneEmptyPage() {
        let empty = v3Payload(slides: #"[{"id": "\#(slideC)", "durationSec": 5, "widgets": []}]"#)
        let pages = ScreenView.pages(empty, format: .widescreen)
        #expect(pages.count == 1)
        #expect(pages[0].placements.isEmpty)
    }

    @Test func pageIdsRoundTrip() {
        #expect(ScreenView.pageEntryId(slideId: "s", page: 0) == "s")
        #expect(ScreenView.pageEntryId(slideId: "s", page: 2) == "s#3")
        #expect(ScreenView.parsePageEntryId("s#3") == ("s", 2))
        #expect(ScreenView.parsePageEntryId("s") == ("s", 0))
        #expect(ScreenView.parsePageEntryId("s#1") == ("s#1", 0))
        #expect(ScreenView.parsePageEntryId("s#x") == ("s#x", 0))
    }
}

@Suite struct PageRotationTests {
    private func at(_ seconds: TimeInterval) -> Date { T0.addingTimeInterval(seconds) }

    @Test func continuationPagesRotateForTheSlidesFullDuration() {
        var rotation = SlideRotation(pages: ScreenView.pages(v3Payload(), format: .widescreen), autoAdvance: true, now: T0)
        #expect(rotation.currentID == slideA)
        rotation.advance(to: at(20))
        #expect(rotation.currentID == "\(slideA)#2")
        #expect(rotation.nextChange() == at(40))
        rotation.advance(to: at(40))
        #expect(rotation.currentID == slideB)
        rotation.advance(to: at(50))
        #expect(rotation.currentID == "\(slideB)#2")
        rotation.advance(to: at(60))
        #expect(rotation.currentID == slideA)
    }

    @Test func aRotationChangeKeepsTheSlideWhenItsPageIsGone() {
        let payload = v3Payload()
        var rotation = SlideRotation(pages: ScreenView.pages(payload, format: .widescreen), autoAdvance: true, now: T0)
        rotation.advance(to: at(25))
        #expect(rotation.currentID == "\(slideA)#2")
        // Turned to portrait: the slide fits one page; its first page stays,
        // with the time it has had.
        rotation.update(pages: ScreenView.pages(payload, format: .tall), autoAdvance: true, now: at(26))
        #expect(rotation.currentID == slideA)
        #expect(rotation.nextChange() == at(40))
        // And back: page 1 is still there, so it stays.
        rotation.update(pages: ScreenView.pages(payload, format: .widescreen), autoAdvance: true, now: at(27))
        #expect(rotation.currentID == slideA)
    }

    @Test func withoutAutoAdvanceOnlyTheFirstPageShows() {
        let rotation = SlideRotation(
            pages: ScreenView.pages(v3Payload(), format: .widescreen), autoAdvance: false, now: T0)
        #expect(rotation.currentID == slideA)
        #expect(!rotation.rotates)
    }
}

@Suite struct HeaderFitTests {
    @Test func keepsShortNamesOnOneLineWithTheSlideName() {
        for format in ScreenFormat.allCases {
            let fit = StudioLayout.headerFit(name: "Overview", slideName: "Sales", format: format, logoAspect: 1)
            #expect(fit.nameLines == 1 && fit.showSlideName && fit.fits)
        }
    }

    @Test func dropsTheSlideNameBeforeTheDashboardNameWrapsOrIsCut() {
        let name = "Unternehmenskennzahlen Vertrieb und Marketing Europa"
        let wide = StudioLayout.headerFit(name: name, slideName: "Heute", format: .widescreen, logoAspect: 1)
        #expect(wide.nameLines == 1 && wide.showSlideName && wide.fits)
        let standard = StudioLayout.headerFit(name: name, slideName: "Heute", format: .standard, logoAspect: 1)
        #expect(standard.nameLines == 1 && !standard.showSlideName && standard.fits)
        // Narrow formats wrap the name to two lines before it would shrink.
        let tall = StudioLayout.headerFit(name: name, slideName: "Heute", format: .tall, logoAspect: 1)
        #expect(tall == HeaderFit(width: tall.width, nameLines: 2, maxNameLines: 2, showSlideName: false, fits: true))
    }

    @Test func countsTheLogosWidthAtItsAspectRatio() {
        typealias M = StudioHeaderMetrics
        let without = StudioLayout.headerFit(name: "A", slideName: nil, format: .widescreen, logoAspect: nil)
        let wide = StudioLayout.headerFit(name: "A", slideName: nil, format: .widescreen, logoAspect: 3)
        #expect(abs((without.width - wide.width) - (M.logo * 3 + M.gap)) < 1e-9)
        // A logo without a usable size counts as none.
        #expect(StudioLayout.headerFit(name: "A", slideName: nil, format: .widescreen, logoAspect: 0).width == without.width)
        let expected =
            1920 - 2 * M.padding - 2 * M.gap - M.clockSpace - StudioLayout.estimateTextWidth("12:00 PM", fontSize: M.meta)
        #expect(abs(without.width - expected) < 1e-9)
    }
}

@Suite struct ScreenRenderTests {
    @Test func widgetsMeasureTheirScreenBoxOffTheClassicCanvas() {
        let cells = StudioPlacement(x: 0, y: 0, w: 6, h: 4)
        let classic = StudioRender.contentBox(cells, showHeader: true)
        let box = StudioCanvas(width: 1016, height: 470)
        let screen = StudioRender.contentBox(cells, showHeader: true, unitBox: box)
        #expect(screen.width == 1016 - 2 * StudioLayout.widgetPadding)
        #expect(screen.height == 470 - 2 * StudioLayout.widgetPadding)
        #expect(classic.width < screen.width)
        let chart = StudioRender.chartLayout(
            type: .line, label: "Revenue · App", value: ("1", "1"), notice: nil, placement: cells, showHeader: true,
            fontScale: 1, unitBox: box)
        #expect(chart.chartWidth <= screen.width)
    }

    @Test func textIsMeasuredInItsFormat() {
        // Six columns are the whole width in 9x16 but half of it in 16x9.
        let cells = StudioPlacement(x: 0, y: 0, w: 6, h: 2)
        let wide = StudioRender.contentBox(cells, format: .widescreen, showHeader: true)
        let tall = StudioRender.contentBox(cells, format: .tall, showHeader: true)
        #expect(tall.width > wide.width)
        let text = "A headline that needs several words to say it"
        let atWide = StudioRender.textLayout(text, size: .display, placement: cells, fontScale: 1, showHeader: true)
        let atTall = StudioRender.textLayout(
            text, size: .display, placement: cells, fontScale: 1, showHeader: true, format: .tall)
        #expect(atWide == StudioRender.textLayout(
            text, size: .display, placement: cells, fontScale: 1, showHeader: true, format: .widescreen))
        // The wider box of 9x16 never needs a smaller size than 16x9.
        let rank: [StudioTextSize: Int] = [.body: 0, .heading: 1, .display: 2]
        #expect(rank[atTall.size]! >= rank[atWide.size]!)
        #expect(atWide.size != .display)
    }
}
