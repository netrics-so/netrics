import Foundation
import Testing

@testable import NetricsKit

@Suite struct PayloadV2DecodingTests {
    @Test func decodesEveryWidgetType() throws {
        let payload = v2Payload()
        #expect(payload.schema == 2)
        #expect(payload.dashboard?.name == "Wurfel")
        #expect(payload.dashboard?.logoImageId == logoID)
        #expect(payload.theme.name == "Midnight")
        // Colours are normalised to lower case.
        #expect(payload.theme.tokens.background == "#0b1020")
        #expect(payload.theme.tokens.accent == "#ffcc00")
        #expect(payload.theme.tokens.fontScale == 1.15)
        #expect(payload.rotation == SlideRotationSettings(autoAdvance: true, transition: .fade))

        // The slide with a numeric id is dropped, the others stay in order.
        #expect(payload.slides.map(\.id) == [slideA, slideB])
        let first = payload.slides[0]
        #expect(first.background == SlideBackground(imageId: backgroundID, dim: 40))
        // Outside the grid or without an id: dropped; everything else kept.
        #expect(first.widgets.map(\.id) == ["w-metric", "w-line", "w-bar", "w-gauge", "w-broken"])

        guard case .metric(let options, let data) = first.widgets[0].content else {
            Issue.record("metric")
            return
        }
        #expect(options == MetricWidgetOptions(showSparkline: true, showChange: false))
        #expect(data.value == 1284)
        #expect(data.spark == [1, 2, nil, 4])
        #expect(data.period == .last7Days)
        #expect(first.widgets[0].placement == StudioPlacement(x: 0, y: 0, w: 4, h: 3))
        #expect(first.widgets[0].label == "Downloads · Wurfel")

        guard case .line(let lineOptions, let line) = first.widgets[1].content else {
            Issue.record("line")
            return
        }
        #expect(lineOptions.showAxis == false)
        #expect(line.values == [100, nil])
        #expect(line.previous == [50, 60])
        #expect(line.buckets.count == 2)
        #expect(line.better == .lower)
        #expect(line.status == .stale)
        #expect(line.conversion?.displayCurrency == "EUR")

        guard case .bar(_, let bar) = first.widgets[2].content else {
            Issue.record("bar")
            return
        }
        // The damaged bar is dropped, not the widget.
        #expect(bar.bars.map(\.label) == ["Germany", "United States"])
        #expect(bar.others == BarOthers(label: "Others", value: 77, groups: 12))
    }

    @Test func unknownTypesAndUnreadableWidgetsArePlaceholders() {
        let widgets = v2Payload().slides[0].widgets
        #expect(widgets[3].type == "gauge")
        #expect(widgets[3].content == .unsupported)
        #expect(widgets[3].placement == StudioPlacement(x: 4, y: 4, w: 2, h: 2))
        #expect(widgets[4].type == "metric")
        #expect(widgets[4].content == .unsupported)
    }

    @Test func imageTextAndClock() throws {
        let widgets = v2Payload().slides[1].widgets
        #expect(widgets[0].content == .image(imageId: logoID, ImageWidgetOptions(fit: .cover, align: .end)))
        // An unknown size option falls back to body; the text stays as sent.
        #expect(widgets[1].content == .text("## Wurfel\nDaily **numbers** <b>not html</b>", TextWidgetOptions(size: .body, align: .center)))
        #expect(widgets[2].content == .clock(ClockWidgetOptions(showDate: true, hour12: false, timeZone: "America/New_York")))
    }

    @Test func imagesWithAnUnsafeHashAreDropped() {
        let images = v2Payload().images
        #expect(images.map(\.id) == [logoID, backgroundID])
        #expect(images[0].sha256 == logoHash)
        #expect(v2Payload().image(logoID)?.width == 512)
        #expect(v2Payload().image(nil) == nil)
    }

    @Test func damagedThemeTokensFallBackToNetricsDark() throws {
        let json = """
            {"version": "x", "schema": 2, "dashboard": null, "slides": [],
             "theme": {"name": "Odd", "tokens": {"background": "red", "text": "#FFFFFF", "fontScale": 0.5}},
             "rotation": {"autoAdvance": false, "transition": "spin"}}
            """
        let payload = try JSONDecoder().decode(DeviceDashboardV2.self, from: Data(json.utf8))
        #expect(payload.theme.tokens.background == ThemeTokens.netricsDark.background)
        #expect(payload.theme.tokens.text == "#ffffff")
        // A font scale never lowers a minimum.
        #expect(payload.theme.tokens.fontScale == 1)
        #expect(payload.rotation == SlideRotationSettings(autoAdvance: false, transition: .fade))
        #expect(payload.refreshAfterSec == 60)
        #expect(payload.images.isEmpty)
    }

    @Test func missingDurationsTakeTheDefault() throws {
        let slides = """
            [{"id": "\(slideA)", "durationSec": 0, "widgets": []}, {"id": "\(slideB)", "widgets": []}]
            """
        let payload = v2Payload(slides: slides)
        #expect(payload.slides.map(\.durationSec) == [20, 20])
    }

    @Test func payloadPicksTheSchemaFromTheBody() throws {
        let v1 = try JSONEncoder().encode(dashboard("v1"))
        #expect(try JSONDecoder().decode(DashboardPayload.self, from: v1) == .v1(dashboard("v1")))
        let v2 = try JSONDecoder().decode(DashboardPayload.self, from: Data(v2JSON().utf8))
        #expect(v2.schema == 2)
        #expect(v2.version == "v2-1")
        #expect(v2.hasDashboard)
        // A schema this build does not know is not read as schema 1.
        let v4 = Data(#"{"version": "x", "schema": 4, "slides": [], "tiles": []}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(DashboardPayload.self, from: v4) }
    }

    @Test func cachedPayloadsRoundTrip() throws {
        let cache = FileDashboardCache(
            fileURL: FileManager.default.temporaryDirectory.appending(path: "netrics-\(UUID().uuidString)/d.json"))
        defer { cache.clear() }
        let entry = CachedDashboard(etag: "\"v2-1\"", payload: .v2(v2Payload()), updatedAt: T0)
        cache.save(entry)
        #expect(cache.load() == entry)
    }

    @Test func aCacheFileOfAnOlderBuildReadsAsSchema1() throws {
        // What builds before schema 2 wrote: the payload is a schema 1 object.
        let url = FileManager.default.temporaryDirectory.appending(path: "netrics-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(dashboard("v1")))
        let old: [String: Any] = ["etag": "\"v1\"", "payload": payload, "updatedAt": 1_759_140_000_000]
        try JSONSerialization.data(withJSONObject: old).write(to: url)
        let loaded = try #require(FileDashboardCache(fileURL: url).load())
        #expect(loaded.payload == .v1(dashboard("v1")))
        #expect(loaded.etag == "\"v1\"")
    }

    @Test func serverInfoSchemas() throws {
        func info(_ extra: String) throws -> ServerInfo {
            try JSONDecoder().decode(
                ServerInfo.self,
                from: Data(
                    #"{"product": "netrics", "deviceApiVersion": 1, "version": "1", "pairingUrl": "https://x.test/a"\#(extra)}"#
                        .utf8))
        }
        #expect(try info("").preferredDashboardSchema == 1)
        #expect(try info(#", "dashboardSchemas": [1]"#).preferredDashboardSchema == 1)
        #expect(try info(#", "dashboardSchemas": [1, 2]"#).preferredDashboardSchema == 2)
        #expect(try info(#", "dashboardSchemas": [1, 2, 3]"#).preferredDashboardSchema == 3)
        #expect(try info(#", "dashboardSchemas": [1, 2]"#).preferredDashboardSchema == 2)
        #expect(try info(#", "dashboardSchemas": "two""#).preferredDashboardSchema == 1)
    }
}

@Suite struct SchemaNegotiationTests {
    private func paired(_ routes: @escaping (ManualClock) -> [String: Handler], cached: CachedDashboard? = nil)
        -> Harness
    {
        Harness(credentials: { credentialsFor("a", accessExpiresIn: 86_400, clock: $0) }, cached: cached, routes: routes)
    }

    @Test func asksForSchema2WhenTheServerListsIt() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                "GET /v1/device/dashboard": { _ in v2Response() },
                "GET /v1/device/images/\(logoID)": { _ in HTTPResponse(status: 200, body: logoBytes) },
                "GET /v1/device/images/\(backgroundID)": { _ in HTTPResponse(status: 200, body: backgroundBytes) },
            ]
        }
        await h.start()
        await h.advance(0)
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.query == "schema=2")
        let state = await h.state
        #expect(state.dashboardV2?.version == "v2-1")
        #expect(state.dashboard == nil)
        #expect(state.payload?.schema == 2)
    }

    @Test func staysOnSchema1ForAnOlderServer() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: nil) },
                "GET /v1/device/dashboard": { _ in json(dashboard("v1")) },
            ]
        }
        await h.start()
        await h.advance(0)
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.query == nil)
        #expect(await h.state.dashboard?.version == "v1")
    }

    @Test func checksTheSchemaOnceAndAgainAfterHours() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                "GET /v1/device/dashboard": { _ in v2Response() },
            ]
        }
        await h.start()
        await h.advance(3 * 60)
        #expect(h.api.callsTo("GET /v1/server").count == 1)
        #expect(h.api.callsTo("GET /v1/device/dashboard").count == 4)
        await h.advance(DeviceClient.schemaRecheckInterval)
        #expect(h.api.callsTo("GET /v1/server").count == 2)
    }

    @Test func anUnreachableServerInfoIsNotAnOutage() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in throw TransportError.timedOut },
                "GET /v1/device/dashboard": { _ in json(dashboard("v1")) },
            ]
        }
        await h.start()
        await h.advance(60)
        // Schema 1 until the server's info answers; asked again each poll.
        #expect(h.api.callsTo("GET /v1/device/dashboard").map(\.query) == [nil, nil])
        #expect(h.api.callsTo("GET /v1/server").count == 2)
        let state = await h.state
        #expect(state.offline == false)
        #expect(state.dashboard?.version == "v1")
    }

    @Test func aCachedSchema2PayloadIsKeptWhileTheInfoIsUnknown() async throws {
        let cached = CachedDashboard(etag: "\"v2-1\"", payload: .v2(v2Payload()), updatedAt: T0)
        let h = paired(
            { _ in
                [
                    "GET /v1/server": { _ in throw TransportError.timedOut },
                    "GET /v1/device/dashboard": { _ in HTTPResponse(status: 304) },
                ]
            }, cached: cached)
        await h.start()
        await h.advance(0)
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.query == "schema=2")
        #expect(request.header("if-none-match") == "\"v2-1\"")
        #expect(await h.state.dashboardV2?.version == "v2-1")
    }

    @Test func dropsTheETagOfTheOtherSchema() async throws {
        let cached = CachedDashboard(etag: "\"v1\"", payload: dashboard("v1"), updatedAt: T0)
        let h = paired(
            { _ in
                [
                    "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                    "GET /v1/device/dashboard": { _ in v2Response() },
                ]
            }, cached: cached)
        await h.start()
        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests.count == 2)
        // The schema 1 ETag is not offered for schema 2 …
        #expect(requests[0].query == "schema=2")
        #expect(requests[0].header("if-none-match") == nil)
        // … and the schema 2 one is used from then on.
        #expect(requests[1].header("if-none-match") == "\"v2-1\"")
        #expect(await h.cache.load()?.payload.schema == 2)
    }

    @Test func followsAServerThatAnswersSchema1AnyWay() async throws {
        let h = paired { _ in
            [
                "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                "GET /v1/device/dashboard": { _ in json(dashboard("v1"), headers: ["etag": "\"v1\""]) },
            ]
        }
        await h.start()
        await h.advance(60)
        let requests = h.api.callsTo("GET /v1/device/dashboard")
        #expect(requests.map(\.query) == ["schema=2", nil])
        #expect(requests[1].header("if-none-match") == "\"v1\"")
        #expect(await h.state.dashboard?.version == "v1")
    }

    @Test func aChangedCertificateOnTheInfoBlocks() async throws {
        let h = paired { _ in
            ["GET /v1/server": { _ in throw TransportError.certificateChanged }]
        }
        await h.start()
        await h.advance(0)
        guard case .blocked = await h.state.phase else {
            Issue.record("expected blocked")
            return
        }
        #expect(h.api.callsTo("GET /v1/device/dashboard").isEmpty)
    }
}

@Suite struct ImageSyncTests {
    private func harness(
        images: InMemoryImageCache, logo: @escaping @Sendable () -> HTTPResponse = { HTTPResponse(status: 200, body: logoBytes) },
        imagesJSON: String? = nil
    ) -> Harness {
        Harness(
            credentials: { credentialsFor("a", clock: $0) },
            routes: { _ in
                [
                    "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
                    "GET /v1/device/dashboard": { call in
                        call.header("if-none-match") == nil
                            ? v2Response(images: imagesJSON) : HTTPResponse(status: 304)
                    },
                    "GET /v1/device/images/\(logoID)": { _ in logo() },
                    "GET /v1/device/images/\(backgroundID)": { _ in HTTPResponse(status: 200, body: backgroundBytes) },
                ]
            }, images: images)
    }

    @Test func downloadsMissingImagesWithTheDeviceToken() async throws {
        let images = InMemoryImageCache()
        let h = harness(images: images)
        await h.start()
        await h.advance(0)
        let request = try #require(h.api.callsTo("GET /v1/device/images/\(logoID)").first)
        #expect(request.header("authorization") == "Bearer access-a")
        #expect(request.query == "v=\(logoHash)")
        #expect(images.hashes == [logoHash, backgroundHash])
        #expect(await h.state.storedImages == [logoHash, backgroundHash])

        // Stored images are never fetched again.
        await h.advance(120)
        #expect(h.api.callsTo("GET /v1/device/images/\(logoID)").count == 1)
    }

    @Test func bytesThatDoNotMatchTheHashAreNotStored() async throws {
        let images = InMemoryImageCache()
        let h = harness(images: images, logo: { HTTPResponse(status: 200, body: Data("tampered".utf8)) })
        await h.start()
        await h.advance(0)
        #expect(images.hashes == [backgroundHash])
        let state = await h.state
        #expect(state.storedImages == [backgroundHash])
        #expect(state.offline == false)
        // Retried with the next poll.
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/images/\(logoID)").count == 2)
    }

    @Test func aFailingImageNeverFailsTheDashboard() async throws {
        let images = InMemoryImageCache()
        let h = harness(images: images, logo: { HTTPResponse(status: 404) })
        await h.start()
        await h.advance(0)
        let state = await h.state
        #expect(state.dashboardV2 != nil)
        #expect(state.offline == false)
        #expect(state.lastError == nil)
    }

    @Test func onlyDeviceImagePathsOnTheServerAreFetched() async throws {
        let evil = [
            "https://evil.test/v1/device/images/x", "//evil.test/v1/device/images/x",
            "/v1/device/images/../../v1/device/me", "/v1/device/me", "/v1/device/images/@evil.test",
        ]
        let entries = evil.enumerated().map { index, url in
            let hash = ImageHash.sha256(Data("\(index)".utf8))
            return """
                {"id": "4444444\(index)-4444-4444-8444-444444444444", "sha256": "\(hash)", "contentType": "image/png",
                 "width": 1, "height": 1, "bytes": 1, "url": "\(url)"}
                """
        }
        let images = InMemoryImageCache()
        let h = harness(images: images, imagesJSON: "[\(entries.joined(separator: ","))]")
        await h.start()
        await h.advance(0)
        let paths = h.api.calls.map(\.path)
        #expect(paths.allSatisfy { !$0.contains("evil") && $0 != "/v1/device/me" })
        #expect(h.api.calls.filter { $0.path.hasPrefix("/v1/device/images") }.isEmpty)
        #expect(images.hashes.isEmpty)
    }

    @Test func unpairingClearsTheImages() async throws {
        let images = InMemoryImageCache()
        let h = harness(images: images)
        await h.start()
        await h.advance(0)
        #expect(!images.hashes.isEmpty)
        await h.client.unpair()
        #expect(images.hashes.isEmpty)
    }

    @Test func anOfflineStartListsTheStoredImages() async throws {
        let images = InMemoryImageCache()
        images.store(logoBytes, sha256: logoHash)
        let cached = CachedDashboard(etag: "\"v2-1\"", payload: .v2(v2Payload()), updatedAt: T0)
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) }, cached: cached,
            routes: { _ in [:] }, images: images)
        await h.start()
        let state = await h.state
        #expect(state.dashboardV2?.version == "v2-1")
        #expect(state.storedImages == [logoHash])
    }
}

@Suite struct ImageCacheTests {
    @Test func evictsUnreferencedLeastRecentlyUsedBeyondTheBudget() {
        let entries = [
            ImageEviction.Entry(sha256: "a", size: 40, lastUsed: T0),
            ImageEviction.Entry(sha256: "b", size: 40, lastUsed: T0.addingTimeInterval(10)),
            ImageEviction.Entry(sha256: "c", size: 40, lastUsed: T0.addingTimeInterval(20)),
            ImageEviction.Entry(sha256: "d", size: 40, lastUsed: T0.addingTimeInterval(-10)),
        ]
        // Within the budget nothing goes.
        #expect(ImageEviction.victims(entries, keeping: [], budget: 160).isEmpty)
        // Oldest first, until within budget; referenced ones never.
        #expect(ImageEviction.victims(entries, keeping: [], budget: 100) == ["d", "a"])
        #expect(ImageEviction.victims(entries, keeping: ["d"], budget: 100) == ["a", "b"])
        // Everything referenced: over budget, but kept.
        #expect(ImageEviction.victims(entries, keeping: ["a", "b", "c", "d"], budget: 10).isEmpty)
    }

    @Test func fileCacheStoresTouchesAndEvicts() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "netrics-images-\(UUID().uuidString)")
        let clock = ManualClock()
        let cache = FileImageCache(directory: directory, now: { clock.now })
        defer { cache.clear() }
        let one = Data(repeating: 1, count: 100)
        let two = Data(repeating: 2, count: 100)
        let three = Data(repeating: 3, count: 100)
        let (h1, h2, h3) = (ImageHash.sha256(one), ImageHash.sha256(two), ImageHash.sha256(three))
        cache.store(one, sha256: h1)
        clock.advance(seconds: 10)
        cache.store(two, sha256: h2)
        clock.advance(seconds: 10)
        cache.store(three, sha256: h3)
        #expect(cache.data(h2) == two)
        // Using the first image makes the second the least recently used.
        cache.touch([h1], at: clock.now.addingTimeInterval(10))
        cache.evict(keeping: [], budget: 250)
        #expect(cache.contains(h1))
        #expect(!cache.contains(h2))
        #expect(cache.contains(h3))
        // Referenced images survive any budget.
        cache.evict(keeping: [h1, h3], budget: 0)
        #expect(cache.contains(h1) && cache.contains(h3))
        cache.evict(keeping: [h3], budget: 0)
        #expect(!cache.contains(h1))
    }

    @Test func fileCacheRefusesNamesThatAreNotHashes() {
        let directory = FileManager.default.temporaryDirectory.appending(path: "netrics-images-\(UUID().uuidString)")
        let cache = FileImageCache(directory: directory)
        defer { cache.clear() }
        cache.store(Data("x".utf8), sha256: "../escape")
        #expect(cache.fileURL("../escape") == nil)
        #expect(!FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().appending(path: "escape.img").path))
        #expect(ImageHash.isValid(ImageHash.sha256(Data())))
        #expect(!ImageHash.isValid(String(repeating: "A", count: 64)))
    }
}
