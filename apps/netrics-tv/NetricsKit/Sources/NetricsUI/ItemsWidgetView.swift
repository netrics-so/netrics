import NetricsKit
import SwiftUI

/**
 * The latest-items widget (#810, #811), the counterpart of the web's
 * `ItemsWidgetView` (apps/web/src/components/studio/items-widget.tsx): the
 * label, then the newest items as a grid (as many as fit at a readable
 * size, never more than `count`; extra items are left out, not shrunk) or
 * one at a time, cross-faded every `rotateSeconds` (no animation with
 * Reduce Motion). Images come from the offline cache, decoded at display
 * size; an item without a stored image (none, not downloaded yet, pruned)
 * shows a themed placeholder, never a broken picture or an error.
 */
struct ItemsWidgetView: View {
    let label: String
    let options: ItemsWidgetOptions
    let data: ItemsWidgetData
    let env: WidgetEnv
    let placement: ScreenPlacement
    let image: (String?) -> StoredImage?
    let slideStartedAt: Date

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /** An item and its stored image (nil: the placeholder). */
    struct Tile {
        let item: ItemsWidgetItem
        let image: StoredImage?
    }

    /** What the widget draws at one moment, in units. */
    struct Plan {
        let label: StudioRender.LabelLayout
        /** The title's size; the subtitle and time take `cell`. */
        let body: Double
        let cell: Double
        /** Nil when rotating. */
        let grid: ItemsLayout.Grid?
        let tiles: [Tile]
        /** Each tile's box and its image's height. */
        let tileWidth: Double
        let tileHeight: Double
        let imageHeight: Double
        let subtitles: Bool
    }

    static func plan(
        label: String, options: ItemsWidgetOptions, data: ItemsWidgetData, placement: ScreenPlacement,
        fontScale: Double, showHeader: Bool, image: (String?) -> StoredImage?, slideStartedAt: Date, at date: Date
    ) -> Plan {
        let box = StudioRender.contentBox(placement.cells, showHeader: showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(.items, placement: placement.cells, fontScale: fontScale, showHeader: showHeader)
        let body = sizes[.body] ?? StudioLayout.Minimum.body
        let cell = sizes[.cell] ?? StudioLayout.Minimum.cell
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let items = Array(data.items.prefix(options.count))
        let subtitles = items.contains { $0.subtitle?.isEmpty == false }
        let textHeight = ItemsLayout.textHeight(body: body, cell: cell, subtitles: subtitles, showTime: options.showTime)
        let height = max(0, box.height - labelLayout.height - StudioRender.stackGap)
        func item(_ item: ItemsWidgetItem) -> StoredImage? { item.imageId.flatMap { image($0) } }
        if options.rotates {
            let index = itemsRotationIndex(
                itemCount: items.count, rotateSeconds: options.rotateSeconds, slideStartedAt: slideStartedAt, at: date)
            return Plan(
                label: labelLayout, body: body, cell: cell, grid: nil,
                tiles: items.isEmpty ? [] : [Tile(item: items[index], image: item(items[index]))], tileWidth: box.width, tileHeight: height,
                imageHeight: max(0, height - textHeight), subtitles: subtitles)
        }
        let grid = ItemsLayout.grid(
            width: box.width, height: height, textHeight: textHeight, count: options.count, items: items.count)
        let gap = ItemsLayout.gap
        let tileWidth = (box.width - gap * Double(grid.columns - 1)) / Double(grid.columns)
        let tileHeight = (height - gap * Double(grid.rows - 1)) / Double(grid.rows)
        return Plan(
            label: labelLayout, body: body, cell: cell, grid: grid, tiles: items.prefix(grid.shown).map { Tile(item: $0, image: item($0)) },
            tileWidth: tileWidth, tileHeight: tileHeight, imageHeight: max(0, tileHeight - textHeight),
            subtitles: subtitles)
    }

    var body: some View {
        if options.rotates {
            // One step per item; the relative times are worded at each step.
            TimelineView(.periodic(from: slideStartedAt, by: TimeInterval(options.rotateSeconds))) { context in
                content(at: context.date)
            }
        } else {
            TimelineView(.everyMinute) { context in
                content(at: context.date)
            }
        }
    }

    private func content(at date: Date) -> some View {
        let plan = Self.plan(
            label: label, options: options, data: data, placement: placement, fontScale: env.fontScale,
            showHeader: env.showHeader, image: image, slideStartedAt: slideStartedAt, at: date)
        return VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: plan.label, env: env)
            if plan.tiles.isEmpty {
                Text(L10n.tr("No items yet", env.language))
                    .font(env.font(plan.body))
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(2)
                Spacer(minLength: 0)
            } else if let grid = plan.grid {
                let gap = env.pt(ItemsLayout.gap)
                VStack(alignment: .leading, spacing: gap) {
                    ForEach(0..<grid.rows, id: \.self) { row in
                        HStack(alignment: .top, spacing: gap) {
                            ForEach(0..<grid.columns, id: \.self) { column in
                                let index = row * grid.columns + column
                                if index < plan.tiles.count {
                                    tileView(plan.tiles[index], plan: plan, now: date)
                                } else {
                                    Color.clear.frame(width: env.pt(plan.tileWidth), height: env.pt(plan.tileHeight))
                                }
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            } else if let tile = plan.tiles.first {
                let index = itemsRotationIndex(
                    itemCount: min(data.items.count, options.count), rotateSeconds: options.rotateSeconds,
                    slideStartedAt: slideStartedAt, at: date)
                ZStack(alignment: .topLeading) {
                    tileView(tile, plan: plan, now: date)
                        .id(index)
                        .transition(.opacity)
                }
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: index)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func tileView(_ tile: Tile, plan: Plan, now: Date) -> some View {
        let width = env.pt(plan.tileWidth)
        let imageHeight = env.pt(plan.imageHeight)
        let shape = RoundedRectangle(cornerRadius: env.pt(10))
        let time =
            options.showTime
            ? ItemsText.time(
                tile.item.time, now: now, language: env.language,
                timeZone: TimeZone(identifier: env.timeZone) ?? .current)
            : nil
        return VStack(alignment: .leading, spacing: 0) {
            Group {
                if let stored = tile.image {
                    DownsampledImage(
                        file: stored.url, image: stored.image, fit: options.imageFit, align: .center,
                        box: CGSize(width: width, height: imageHeight), displayScale: env.displayScale)
                } else {
                    // A themed tile in the skeleton's tone, never a broken picture.
                    shape.fill(Color(env.colors.derived.skeleton))
                        .accessibilityElement()
                        .accessibilityLabel(L10n.tr("No image", env.language))
                }
            }
            .frame(width: width, height: imageHeight)
            .clipShape(shape)
            Text(tile.item.title ?? "")
                .font(env.font(plan.body, .semibold))
                .foregroundStyle(env.colors.text)
                .lineLimit(1)
                .truncationMode(.tail)
            if plan.subtitles {
                Text(tile.item.subtitle ?? "")
                    .font(env.font(plan.cell))
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if options.showTime {
                Text(time ?? "")
                    .font(env.font(plan.cell).monospacedDigit())
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(1)
            }
        }
        .frame(width: width, height: env.pt(plan.tileHeight), alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}
