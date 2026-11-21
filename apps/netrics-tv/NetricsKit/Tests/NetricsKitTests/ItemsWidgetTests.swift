import Foundation
import Testing

@testable import NetricsKit

// The latest-items widget (#810, #811): decoding, the rotation index, the
// grid that fits, the detail sheet, the `items` feature and its images in
// the offline cache.

let itemBytes = (0..<3).map { Data("item-image-\($0)".utf8) }
let itemHashes = itemBytes.map(ImageHash.sha256)
let itemIDs = [
    "c0000000-0000-4000-8000-000000000000", "c1111111-1111-4111-8111-111111111111",
    "c2222222-2222-4222-8222-222222222222",
]
/** An image id no entry of `images` names (pruned, or a damaged entry). */
let missingItemImageID = "c9999999-9999-4999-8999-999999999999"

let itemImagesJSON = """
    [
      \(itemIDs.indices.map { i in
          """
          {"id": "\(itemIDs[i])", "sha256": "\(itemHashes[i])", "contentType": "image/jpeg", "width": 800,
           "height": 600, "bytes": \(itemBytes[i].count), "url": "/v1/device/images/\(itemIDs[i])?v=\(itemHashes[i])"}
          """
      }.joined(separator: ",\n"))
    ]
    """

/** A slide with one items widget as the server writes it (deviceItemsDataSchema). */
func itemsSlideJSON(
    layout: String = "grid", options: String? = nil, imageIds: [String?]? = nil, extraItems: String = ""
) -> String {
    let ids = imageIds ?? itemIDs
    let items = ids.enumerated().map { index, id in
        """
        {"title": "Shoe \(3 - index)", "subtitle": \(index == 0 ? "\"Red\"" : "null"),
         "time": "2026-11-2\(3 - index)T08:00:00.000Z", "imageId": \(id.map { "\"\($0)\"" } ?? "null")}
        """
    }
    return """
        [{
          "id": "\(slideA)", "name": "Shop", "durationSec": 30, "background": null,
          "widgets": [
            {"id": "w-items", "type": "items", "x": 0, "y": 0, "w": 6, "h": 4, "label": "Latest orders",
             "options": \(options ?? #"{"layout": "\#(layout)", "count": 6, "rotateSeconds": 8, "imageFit": "cover", "showTime": true}"#),
             "data": {"status": "ok", "items": [\(items.joined(separator: ","))\(extraItems)],
                      "freshness": {"kind": "continuous", "stream": "Orders", "fetchedAt": "2026-11-21T08:00:00.000Z"}}}
          ]
        }]
        """
}

private func itemsWidget(_ payload: DeviceDashboardV2) throws -> (ItemsWidgetOptions, ItemsWidgetData) {
    let widget = try #require(payload.slides.first?.widgets.first)
    guard case .items(let options, let data) = widget.content else {
        Issue.record("expected .items, got \(widget.content)")
        throw CancellationError()
    }
    return (options, data)
}

@Suite struct ItemsWidgetDecodingTests {
    @Test func decodesItemsWidget() throws {
        let payload = v2Payload(slides: itemsSlideJSON(), images: itemImagesJSON)
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(widget.type == "items")
        #expect(widget.label == "Latest orders")
        let (options, data) = try itemsWidget(payload)
        #expect(
            options == ItemsWidgetOptions(layout: .grid, count: 6, rotateSeconds: 8, imageFit: .cover, showTime: true))
        #expect(data.status == .ok)
        // Newest first, as sent.
        #expect(data.items.map(\.title) == ["Shoe 3", "Shoe 2", "Shoe 1"])
        #expect(data.items[0].subtitle == "Red")
        #expect(data.items[1].subtitle == nil)
        #expect(data.items[0].time == "2026-11-23T08:00:00.000Z")
        #expect(data.items.map(\.imageId) == itemIDs)
        #expect(data.freshness?.stream == "Orders")
    }

    @Test func unknownLayoutFallsBackToGrid() throws {
        let (options, _) = try itemsWidget(
            v2Payload(slides: itemsSlideJSON(layout: "carousel"), images: itemImagesJSON))
        #expect(options.layout == .unknown)
        #expect(!options.rotates)
    }

    @Test func optionsAreClampedAndDefaulted() throws {
        let (clamped, _) = try itemsWidget(
            v2Payload(
                slides: itemsSlideJSON(options: #"{"layout": "rotate", "count": 80, "rotateSeconds": 1, "imageFit": "zoom"}"#),
                images: itemImagesJSON))
        #expect(clamped.rotates)
        #expect(clamped.count == 50)
        #expect(clamped.rotateSeconds == 3)
        // The server's default fit for items is cover.
        #expect(clamped.imageFit == .cover)
        #expect(clamped.showTime)
        let (defaults, _) = try itemsWidget(v2Payload(slides: itemsSlideJSON(options: "null"), images: itemImagesJSON))
        #expect(defaults == ItemsWidgetOptions())
        #expect(defaults.count == 6 && defaults.rotateSeconds == 8 && defaults.layout == .grid)
    }

    @Test func dropsAnImageIdNotInPayloadImages() throws {
        let payload = v2Payload(
            slides: itemsSlideJSON(imageIds: [itemIDs[0], missingItemImageID, nil]), images: itemImagesJSON)
        let (_, data) = try itemsWidget(payload)
        #expect(data.items.map(\.imageId) == [itemIDs[0], nil, nil])
        // Every item stays: the missing image gives a placeholder, not a gap.
        #expect(data.items.count == 3)
    }

    @Test func aDamagedItemIsDroppedNotTheWidget() throws {
        let payload = v2Payload(
            slides: itemsSlideJSON(extraItems: #", "not an item", {"title": 7, "time": null, "imageId": 3}"#),
            images: itemImagesJSON)
        let (_, data) = try itemsWidget(payload)
        // The string is dropped; the object keeps its place with unreadable fields as nil.
        #expect(data.items.count == 4)
        #expect(data.items[3] == ItemsWidgetItem(title: nil, subtitle: nil, time: nil, imageId: nil))
    }

    @Test func aWidgetWithoutDataIsUnsupported() throws {
        let json = """
            [{"id": "\(slideA)", "durationSec": 20, "widgets": [
              {"id": "w-items", "type": "items", "x": 0, "y": 0, "w": 6, "h": 4, "label": "Orders", "options": {}}]}]
            """
        let widget = try #require(v2Payload(slides: json).slides.first?.widgets.first)
        #expect(widget.content == .unsupported)
    }

    @Test func roundTripsThroughTheCache() throws {
        let payload = v2Payload(
            slides: itemsSlideJSON(layout: "rotate", imageIds: [itemIDs[0], missingItemImageID, nil]),
            images: itemImagesJSON)
        let data = try JSONEncoder().encode(DashboardPayload.v2(payload))
        let decoded = try JSONDecoder().decode(DashboardPayload.self, from: data)
        #expect(decoded == .v2(payload))
    }
}

@Suite struct ItemsRotationTests {
    @Test func rotationIndexWrapsAndStartsAtZero() {
        let t0 = T0
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0) == 0)
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 7.9) == 0)
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 8) == 1)
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 17) == 2)
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 24) == 0)
    }

    @Test func rotationIndexIsSafeAtTheEdges() {
        let t0 = T0
        #expect(itemsRotationIndex(itemCount: 0, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 100) == 0)
        #expect(itemsRotationIndex(itemCount: 1, rotateSeconds: 8, slideStartedAt: t0, at: t0 + 100) == 0)
        // A clock before the start (a changed clock) shows the first item.
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 8, slideStartedAt: t0, at: t0 - 50) == 0)
        #expect(itemsRotationIndex(itemCount: 3, rotateSeconds: 0, slideStartedAt: t0, at: t0 + 50) == 0)
    }
}

@Suite struct ItemsLayoutTests {
    // Web: itemsGridLayout in apps/web/src/components/studio/items-widget.tsx.
    @Test func gridMatchesTheWeb() {
        // 6 × 4 cells on 16:9: three columns of tiles at least 240 wide.
        #expect(
            ItemsLayout.grid(width: 900, height: 500, textHeight: 80, count: 6, items: 6)
                == ItemsLayout.Grid(columns: 3, rows: 2, shown: 6))
        // Never more than `count` nor the items there are.
        #expect(
            ItemsLayout.grid(width: 900, height: 500, textHeight: 80, count: 2, items: 6)
                == ItemsLayout.Grid(columns: 2, rows: 1, shown: 2))
        #expect(
            ItemsLayout.grid(width: 900, height: 500, textHeight: 80, count: 6, items: 1)
                == ItemsLayout.Grid(columns: 1, rows: 1, shown: 1))
        // A box too small still shows one item.
        #expect(
            ItemsLayout.grid(width: 100, height: 50, textHeight: 80, count: 6, items: 6)
                == ItemsLayout.Grid(columns: 1, rows: 1, shown: 1))
        // Extra items are left out, not shrunk: a narrow box has one column.
        #expect(
            ItemsLayout.grid(width: 400, height: 900, textHeight: 80, count: 6, items: 6)
                == ItemsLayout.Grid(columns: 1, rows: 4, shown: 4))
    }

    @Test func itemTimeIsADateOrRelative() throws {
        let now = try #require(ISODate.parse("2026-11-21T10:00:00.000Z"))
        let utc = try #require(TimeZone(identifier: "UTC"))
        // As the web words it (Intl.RelativeTimeFormat, short, numeric "auto").
        #expect(ItemsText.time("2026-11-21T08:00:00.000Z", now: now, language: .en, timeZone: utc) == "2 hr. ago")
        #expect(ItemsText.time("2026-11-21T08:00:00.000Z", now: now, language: .de, timeZone: utc) == "vor 2 Std.")
        #expect(ItemsText.time("2026-11-21T09:55:00.000Z", now: now, language: .en, timeZone: utc) == "5 min. ago")
        #expect(ItemsText.time("2026-11-21T09:59:30.000Z", now: now, language: .en, timeZone: utc) == "now")
        #expect(ItemsText.time("2026-11-21T09:59:30.000Z", now: now, language: .de, timeZone: utc) == "jetzt")
        // A day ago is "yesterday", as on the web, not "1 day ago" (#835).
        #expect(ItemsText.time("2026-11-20T09:00:00.000Z", now: now, language: .en, timeZone: utc) == "yesterday")
        #expect(ItemsText.time("2026-11-20T09:00:00.000Z", now: now, language: .de, timeZone: utc) == "gestern")
        #expect(ItemsText.time("2026-11-19T09:00:00.000Z", now: now, language: .en, timeZone: utc) == "2 days ago")
        #expect(ItemsText.time("2026-11-19T09:00:00.000Z", now: now, language: .de, timeZone: utc) == "vorgestern")
        #expect(ItemsText.time("2026-10-12T10:00:00.000Z", now: now, language: .de, timeZone: utc) == "vor 40 Tagen")
        #expect(ItemsText.time("2026-11-20", now: now, language: .en, timeZone: utc) == "Nov 20, 2026")
        #expect(ItemsText.time(nil, now: now, language: .en, timeZone: utc) == nil)
        #expect(ItemsText.time("", now: now, language: .en, timeZone: utc) == nil)
        // Unreadable text is shown as stored.
        #expect(ItemsText.time("yesterday", now: now, language: .en, timeZone: utc) == "yesterday")
    }

    @Test func countIsWordedInBothLanguages() {
        #expect(ItemsText.count(1, language: .en) == "1 item")
        #expect(ItemsText.count(3, language: .en) == "3 items")
        #expect(ItemsText.count(1, language: .de) == "1 Eintrag")
        #expect(ItemsText.count(3, language: .de) == "3 Einträge")
    }
}

@Suite struct ItemsWidgetDetailTests {
    @Test func detailListsTitles() throws {
        let payload = v2Payload(slides: itemsSlideJSON(), images: itemImagesJSON)
        let widget = try #require(payload.slides.first?.widgets.first)
        #expect(WidgetDetail.available(widget))
        let now = try #require(ISODate.parse("2026-11-23T10:00:00.000Z"))
        let utc = try #require(TimeZone(identifier: "UTC"))
        let detail = try #require(WidgetDetail.make(widget, now: now, language: .en, timeZone: utc))
        #expect(detail.title == "Latest orders")
        #expect(detail.text(.value) == "3 items")
        #expect(detail.items.map(\.label) == ["Shoe 3", "Shoe 2", "Shoe 1"])
        #expect(detail.items[0].value == "2 hr. ago")
        #expect(detail.items[0].lines == [WidgetDetail.Item.Line(text: "Red", warning: false)])
        #expect(detail.text(.updated) != nil)

        let german = try #require(WidgetDetail.make(widget, now: now, language: .de))
        #expect(german.text(.value) == "3 Einträge")
    }
}

@Suite struct ItemsWidgetClientTests {
    @Test func asksForItemsFeature() async throws {
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) },
            routes: { _ in
                [
                    "GET /v1/server": { _ in serverInfo(schemas: [1, 2, 3]) },
                    "GET /v1/device/dashboard": { _ in v2Response() },
                ]
            })
        await h.start()
        await h.advance(0)
        let request = try #require(h.api.callsTo("GET /v1/device/dashboard").first)
        #expect(request.query == "schema=3&features=measure_split,items")
    }

    private static func itemRoutes(fail: Set<Int> = []) -> [String: Handler] {
        var routes: [String: Handler] = [
            "GET /v1/server": { _ in serverInfo(schemas: [1, 2]) },
            "GET /v1/device/dashboard": { _ in v2Response(slides: itemsSlideJSON(), images: itemImagesJSON) },
        ]
        for index in itemIDs.indices {
            let bytes = itemBytes[index]
            let failing = fail.contains(index)
            routes["GET /v1/device/images/\(itemIDs[index])"] = { _ in
                failing ? HTTPResponse(status: 404) : HTTPResponse(status: 200, body: bytes)
            }
        }
        return routes
    }

    @Test func offlineStartShowsCachedItemImages() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "netrics-items-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let images = FileImageCache.inFolder(folder)
        let dashboards = FileDashboardCache.inFolder(folder)

        let online = Harness(
            credentials: { credentialsFor("a", clock: $0) }, routes: { _ in Self.itemRoutes() }, images: images,
            dashboardCache: dashboards)
        await online.start()
        await online.advance(0)
        #expect(await online.state.storedImages == Set(itemHashes))

        // A new start with the network gone: the payload and the item images come from disk.
        let offline = Harness(
            credentials: { credentialsFor("a", clock: $0) }, cached: nil, routes: { _ in [:] },
            images: FileImageCache.inFolder(folder), dashboardCache: FileDashboardCache.inFolder(folder))
        await offline.start()
        let state = await offline.state
        #expect(state.storedImages == Set(itemHashes))
        let payload = try #require(state.dashboardV2)
        let (_, data) = try itemsWidget(payload)
        #expect(data.items.map(\.imageId) == itemIDs)
        for hash in itemHashes {
            #expect(FileImageCache.inFolder(folder).data(hash) != nil)
        }
    }

    @Test func aMissingItemImageIsRetriedWithTheNextPoll() async throws {
        // A 404 races the payload (the server memoizes item image ids for
        // 10 s): never a failure, the next poll asks again.
        let images = InMemoryImageCache()
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) }, routes: { _ in Self.itemRoutes(fail: [1]) },
            images: images)
        await h.start()
        await h.advance(0)
        var state = await h.state
        #expect(state.dashboardV2 != nil)
        #expect(state.lastError == nil)
        #expect(state.storedImages == [itemHashes[0], itemHashes[2]])
        await h.advance(60)
        state = await h.state
        #expect(h.api.callsTo("GET /v1/device/images/\(itemIDs[1])").count == 2)
        #expect(state.storedImages == [itemHashes[0], itemHashes[2]])
    }

    @Test func itemImagesBeyondTheBudgetAreNeitherStoredNorKept() async throws {
        // #830: item images count against the budget. Two of the three fit
        // (12 bytes each); the third is never fetched and shows its placeholder.
        let budget = itemBytes[0].count + itemBytes[1].count
        let images = InMemoryImageCache()
        // Stored by an earlier run (before #830): evicted once over budget.
        images.store(itemBytes[2], sha256: itemHashes[2])
        images.touch([itemHashes[2]], at: T0.addingTimeInterval(-60))
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) }, routes: { _ in Self.itemRoutes() }, images: images,
            imageBudget: budget)
        await h.start()
        await h.advance(0)
        await h.advance(60)
        #expect(h.api.callsTo("GET /v1/device/images/\(itemIDs[2])").isEmpty)
        #expect(await h.state.storedImages == [itemHashes[0], itemHashes[1]])
        #expect(images.hashes == [itemHashes[0], itemHashes[1]])
    }

    @Test func itemImagesSurviveEvictionWhileReferenced() async throws {
        let images = InMemoryImageCache()
        // An old, unreferenced image beyond the budget goes; the item images stay.
        let old = Data(repeating: 9, count: ImageCacheLimits.budget)
        let oldHash = ImageHash.sha256(old)
        images.store(old, sha256: oldHash)
        images.touch([oldHash], at: T0.addingTimeInterval(-86_400))
        let h = Harness(
            credentials: { credentialsFor("a", clock: $0) }, routes: { _ in Self.itemRoutes() }, images: images)
        await h.start()
        await h.advance(0)
        #expect(!images.contains(oldHash))
        for hash in itemHashes {
            #expect(images.contains(hash))
        }
        // Referenced item images survive any budget.
        images.evict(keeping: Set(itemHashes), budget: 0)
        for hash in itemHashes {
            #expect(images.contains(hash))
        }
    }
}

@Suite struct ImageBudgetTests {
    private let logoImageJSON = """
        {"id": "\(logoID)", "sha256": "\(logoHash)", "contentType": "image/png", "width": 512, "height": 512,
         "bytes": \(logoBytes.count), "url": "/v1/device/images/\(logoID)?v=\(logoHash)"}
        """

    private func payload(slides: String) -> DeviceDashboardV2 {
        let items = itemImagesJSON.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().dropLast()
        return v2Payload(slides: slides, images: "[\(logoImageJSON), \(items)]")
    }

    @Test func dashboardImagesAreAlwaysKept() {
        // ADR 0015: the logo stays even when it alone is over budget.
        let kept = ImageBudget.kept(payload(slides: itemsSlideJSON()), budget: 0)
        #expect(kept == [logoHash])
    }

    @Test func newestItemsFillWhatTheBudgetLeaves() {
        let full = ImageBudget.kept(payload(slides: itemsSlideJSON()), budget: ImageCacheLimits.budget)
        #expect(full == Set([logoHash] + itemHashes))
        let two = logoBytes.count + itemBytes[0].count + itemBytes[1].count
        #expect(ImageBudget.kept(payload(slides: itemsSlideJSON()), budget: two) == [logoHash, itemHashes[0], itemHashes[1]])
    }

    @Test func eachWidgetGetsItsNewestItemFirst() {
        // Widget A lists items 0 and 1, widget B (another slide) item 2: room
        // for two keeps both newest items, 0 and 2.
        let first = itemsSlideJSON(imageIds: [itemIDs[0], itemIDs[1]])
        let second = itemsSlideJSON(imageIds: [itemIDs[2]]).replacingOccurrences(of: slideA, with: slideB)
        let slides = "[\(first.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().dropLast()), "
            + "\(second.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().dropLast())]"
        let budget = logoBytes.count + itemBytes[0].count + itemBytes[2].count
        #expect(ImageBudget.kept(payload(slides: slides), budget: budget) == [logoHash, itemHashes[0], itemHashes[2]])
    }

    @Test func aNewerImageIsNeverSkippedForAnOlderOne() {
        // #830 review: item 0 (newest) is too large for what is left; the
        // smaller items 1 and 2 would fit, but are older: none is kept.
        let sizes = [1_000, 10, 10]
        let images = itemIDs.indices.map { i in
            """
            {"id": "\(itemIDs[i])", "sha256": "\(itemHashes[i])", "contentType": "image/jpeg", "width": 800,
             "height": 600, "bytes": \(sizes[i]), "url": "/v1/device/images/\(itemIDs[i])?v=\(itemHashes[i])"}
            """
        }
        let payload = v2Payload(
            slides: itemsSlideJSON(), images: "[\(logoImageJSON), \(images.joined(separator: ","))]")
        #expect(ImageBudget.kept(payload, budget: logoBytes.count + 500) == [logoHash])
        // With room for item 0, the next ones follow while they fit.
        #expect(
            ImageBudget.kept(payload, budget: logoBytes.count + 1_015) == [logoHash, itemHashes[0], itemHashes[1]])
    }

    @Test func itemsBeyondCountAreNotKept() {
        let slides = itemsSlideJSON(
            options: #"{"layout": "grid", "count": 1, "rotateSeconds": 8, "imageFit": "cover", "showTime": true}"#)
        #expect(ImageBudget.kept(payload(slides: slides), budget: ImageCacheLimits.budget) == [logoHash, itemHashes[0]])
    }
}
