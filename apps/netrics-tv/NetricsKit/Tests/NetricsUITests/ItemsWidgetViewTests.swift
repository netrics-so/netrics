import Foundation
import NetricsKit
import Testing

@testable import NetricsUI

// The latest-items widget as netrics TV, iPad and iPhone draw it (#811):
// a grid of readable tiles (extra items are left out, never shrunk), one
// item at a time when rotating, and a themed placeholder where an image is
// missing.

@MainActor @Suite struct ItemsWidgetViewTests {
    private static let ids = (0..<8).map { "d000000\($0)-0000-4000-8000-000000000000" }

    private static func data(_ count: Int = 8, imageIds: [String?]? = nil) -> ItemsWidgetData {
        let ids = imageIds ?? Array(Self.ids.prefix(count))
        return ItemsWidgetData(
            items: ids.enumerated().map { index, id in
                ItemsWidgetItem(
                    title: "Item \(index + 1)", subtitle: index == 0 ? "Red" : nil,
                    time: "2026-11-21T0\(index):00:00.000Z", imageId: id)
            })
    }

    private static func stored(_ id: String?) -> StoredImage? {
        guard let id, id != Self.ids[1] else { return nil }
        let image = DeviceImage(
            id: id, sha256: String(repeating: "a", count: 64), contentType: "image/jpeg", width: 800, height: 600,
            bytes: 1, url: "/v1/device/images/\(id)")
        return StoredImage(url: URL(fileURLWithPath: "/tmp/\(id).img"), image: image)
    }

    private static let t0 = Date(timeIntervalSince1970: 1_795_000_000)

    private static func plan(
        cells: StudioPlacement, options: ItemsWidgetOptions = ItemsWidgetOptions(count: 8), data: ItemsWidgetData = data(),
        fontScale: Double = 1, at date: Date = t0
    ) -> ItemsWidgetView.Plan {
        ItemsWidgetView.plan(
            label: "Latest orders", options: options, data: data, placement: ScreenPlacement(cells: cells),
            fontScale: fontScale, showHeader: true, image: Self.stored, slideStartedAt: t0, at: date)
    }

    @Test func gridFitsItemsAtReadableSize() throws {
        for fontScale in [1.0, 1.15, 1.3] {
            let cells = StudioPlacement(x: 0, y: 0, w: 4, h: 2)
            let plan = Self.plan(cells: cells, fontScale: fontScale)
            let grid = try #require(plan.grid)
            #expect(plan.tiles.count == grid.shown)
            #expect(plan.tiles.count <= 8)
            #expect(plan.tiles.count >= 1)
            // Each cell is at least the readable tile, its text at least the type's minimums.
            #expect(plan.tileWidth >= ItemsLayout.tileMinWidth, "fontScale \(fontScale)")
            #expect(plan.imageHeight >= ItemsLayout.imageMinHeight || grid.rows == 1, "fontScale \(fontScale)")
            #expect(plan.body >= StudioLayout.Minimum.body * fontScale - 0.001)
            #expect(plan.cell >= StudioLayout.Minimum.cell * fontScale - 0.001)
            // Newest first.
            #expect(plan.tiles.first?.item.title == "Item 1")
        }
        // A larger widget shows more items, never more than `count`.
        let large = Self.plan(cells: StudioPlacement(x: 0, y: 0, w: 12, h: 8))
        #expect(large.tiles.count > Self.plan(cells: StudioPlacement(x: 0, y: 0, w: 4, h: 2)).tiles.count)
        #expect(large.tiles.count <= 8)
        let capped = Self.plan(cells: StudioPlacement(x: 0, y: 0, w: 12, h: 8), options: ItemsWidgetOptions(count: 2))
        #expect(capped.tiles.count == 2)
    }

    @Test func rotateShowsOneItem() {
        let options = ItemsWidgetOptions(layout: .rotate, count: 3, rotateSeconds: 8)
        let cells = StudioPlacement(x: 0, y: 0, w: 4, h: 4)
        let first = Self.plan(cells: cells, options: options)
        #expect(first.grid == nil)
        #expect(first.tiles.map(\.item.title) == ["Item 1"])
        #expect(Self.plan(cells: cells, options: options, at: Self.t0 + 9).tiles.map(\.item.title) == ["Item 2"])
        // Only the newest `count` items take turns.
        #expect(Self.plan(cells: cells, options: options, at: Self.t0 + 24).tiles.map(\.item.title) == ["Item 1"])
    }

    @Test func missingImageUsesPlaceholder() {
        let data = Self.data(imageIds: [Self.ids[0], Self.ids[1], nil])
        let plan = Self.plan(cells: StudioPlacement(x: 0, y: 0, w: 12, h: 8), data: data)
        #expect(plan.tiles.count == 3)
        // Stored: the file; not stored (yet), pruned or none: a placeholder.
        #expect(plan.tiles[0].image != nil)
        #expect(plan.tiles[1].image == nil)
        #expect(plan.tiles[2].image == nil)
    }

    @Test func noItemsShowsTheEmptyText() {
        let plan = Self.plan(cells: StudioPlacement(x: 0, y: 0, w: 4, h: 4), data: ItemsWidgetData(status: .noData, items: []))
        #expect(plan.tiles.isEmpty)
    }

    @Test func stringsHaveGerman() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Sources/NetricsUI/Resources/Localizable.xcstrings")
        let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let strings = try #require(catalog?["strings"] as? [String: Any])
        let expected = ["No items yet": "Noch keine Einträge", "Latest items": "Neueste Einträge", "No image": "Kein Bild"]
        for (key, german) in expected {
            let entry = strings[key] as? [String: Any]
            let localizations = entry?["localizations"] as? [String: Any]
            let de = (localizations?["de"] as? [String: Any])?["stringUnit"] as? [String: Any]
            #expect(de?["value"] as? String == german, "\(key)")
        }
    }
}
