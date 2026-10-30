import NetricsKit
import SwiftUI

/**
 * The scroll view of a schema 2 or 3 dashboard (ADR 0017 section 5), as the
 * web's `ScrollView` (apps/web/src/components/scroll/scroll-view.tsx): the
 * header (logo, name, live or offline), then every slide as a section with
 * its name as heading and all its widgets, clocks included, in the primary
 * layout's reading order over 1–3 columns (`ScrollGeometry`, on
 * `ScreenLayout.scrollLayout`). A slide's background image is its
 * section's backdrop under the slide's dim; the cards and the heading band
 * keep the theme's surface, so text never sits on the image. No rotation,
 * no canvases. Text follows Dynamic Type: 1 rem is the body size.
 *
 * The cards are the screen's widget views at the column's width: charts
 * 16:9 (200 to 360 points high), images in their aspect (at most half the
 * viewport high), the others as many units high as in the primary layout.
 */
public struct ScrollDashboardView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache

    public init(state: DeviceState, payload: DeviceDashboardV2, images: FileImageCache) {
        self.state = state
        self.payload = payload
        self.images = images
    }

    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.demoMode) private var demo
    /** 1 rem: 16 points at the default text size, scaled by Dynamic Type. */
    @ScaledMetric(relativeTo: .body) private var rem = ScrollGeometry.rem

    public var body: some View {
        let colors = StudioColors(payload.theme.tokens)
        GeometryReader { view in
            let width = Double(view.size.width)
            let sections = ScrollGeometry.sections(payload.slides, width: width)
            let contentWidth = CGFloat(
                sections.first?.layout.contentWidth ?? min(width, ScreenLayout.scrollMaxContentWidth))
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    header(colors)
                    ForEach(Array(sections.enumerated()), id: \.element.id) { position, section in
                        if position > 0 {
                            colors.border.frame(height: 1)
                        }
                        sectionView(section, colors: colors, viewportHeight: Double(view.size.height))
                    }
                }
                .frame(width: max(0, contentWidth), alignment: .leading)
                .background(colors.background)
                .frame(maxWidth: .infinity)
            }
            .accessibilityLabel(L10n.tr("Slides of %@", payload.language, payload.dashboard?.name ?? ""))
        }
        .background(colors.background.ignoresSafeArea())
        .environment(\.enterProgress, 1)
        .environment(\.motionCues, !reduceMotion)
    }

    private func header(_ colors: StudioColors) -> some View {
        let logo = imageFile(payload.dashboard?.logoImageId)
        let language = payload.language
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                if let logo {
                    let height = CGFloat(2 * rem)
                    let aspect = logo.image.height > 0 ? CGFloat(logo.image.width) / CGFloat(logo.image.height) : 1
                    DownsampledImage(
                        file: logo.url, image: logo.image, fit: .contain, align: .center,
                        box: CGSize(width: height * aspect, height: height), displayScale: displayScale
                    )
                    .frame(width: height * aspect, height: height)
                    .accessibilityHidden(true)
                }
                Text(payload.dashboard?.name ?? "")
                    .font(.system(size: CGFloat(1.375 * rem), weight: .semibold))
                    .foregroundStyle(colors.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if demo {
                    DemoBadge(text: L10n.tr("Demo", language), size: CGFloat(0.875 * rem), colors: colors)
                } else {
                    liveMarker(colors, language: language)
                }
            }
            .padding(EdgeInsets(top: 16, leading: 12, bottom: 12, trailing: 12))
            colors.border.frame(height: 1)
        }
    }

    /** "Live" with a green dot, or the offline marker in the warning colour. */
    private func liveMarker(_ colors: StudioColors, language: ScreenLanguage) -> some View {
        HStack(spacing: CGFloat(0.4 * rem)) {
            Circle()
                .fill(state.offline ? colors.warning : colors.up)
                .frame(width: CGFloat(0.5 * rem), height: CGFloat(0.5 * rem))
                .accessibilityHidden(true)
            // "Offline — last update 14:05", as the TV's header.
            Text(
                state.offline
                    ? TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: payload.timeZone, language: language)
                    : L10n.tr("Live", language)
            )
                .font(.system(size: CGFloat(0.875 * rem)))
                .foregroundStyle(state.offline ? colors.warning : colors.muted)
        }
    }

    private func sectionView(_ section: ScrollGeometry.Section, colors: StudioColors, viewportHeight: Double)
        -> some View
    {
        let slide = section.slide
        let layout = section.layout
        let showHeader = payload.dashboard?.showHeader ?? true
        let u = CGFloat(ScrollGeometry.unit(rem: Double(rem)))
        let env = WidgetEnv(
            u: u, colors: colors, showHeader: showHeader, timeZone: payload.timeZone, displayScale: displayScale,
            language: payload.language)
        let widgets = Dictionary(slide.widgets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let padding = CGFloat(ScrollGeometry.sectionPadding)
        let gap = CGFloat(ScrollGeometry.gap)
        return VStack(alignment: .leading, spacing: gap) {
            Text(slide.name ?? L10n.tr("Slide %@", payload.language, String(section.index + 1)))
                .font(.system(size: CGFloat(1.125 * rem), weight: .semibold))
                .foregroundStyle(colors.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(colors.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(colors.border, lineWidth: 1))
                .accessibilityAddTraits(.isHeader)
            if layout.items.isEmpty {
                Text(L10n.tr("This slide has no widgets yet.", payload.language))
                    .font(.system(size: CGFloat(rem)))
                    .foregroundStyle(colors.muted)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(colors.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(colors.border, lineWidth: 1))
            } else {
                ForEach(Array(ScrollGeometry.rows(layout).enumerated()), id: \.offset) { _, row in
                    // Items flow in reading order; a row's cards are top-aligned (web: `align-items: start`).
                    ZStack(alignment: .topLeading) {
                        Color.clear.frame(height: 0)
                        ForEach(row, id: \.id) { item in
                            if let widget = widgets[item.id] {
                                card(widget, item: item, layout: layout, env: env, viewportHeight: viewportHeight)
                                    .offset(x: CGFloat(ScrollGeometry.itemX(layout, column: item.column)))
                            }
                        }
                    }
                    .frame(width: CGFloat(layout.contentWidth) - 2 * padding, alignment: .topLeading)
                }
            }
        }
        .padding(padding)
        .background {
            if let background = slide.background, let file = imageFile(background.imageId) {
                GeometryReader { box in
                    ZStack {
                        DownsampledImage(
                            file: file.url, image: file.image, fit: .cover, align: .center, box: box.size,
                            displayScale: displayScale)
                        colors.background.opacity(Double(background.dim) / 100)
                    }
                }
                .clipped()
                .accessibilityHidden(true)
            }
        }
    }

    /** One card: the widget's view at the item's width, as high as its height rule says. */
    private func card(
        _ widget: DeviceWidget, item: ScrollItem, layout: ScrollLayout, env: WidgetEnv, viewportHeight: Double
    ) -> some View
    {
        let width = ScrollGeometry.itemWidth(layout, span: item.span)
        let height: Double
        switch item.height {
        case .chart:
            height = ScrollGeometry.chartHeight(width: width)
        case .image:
            let image = imageForWidget(widget)?.image
            let aspect = image.flatMap { $0.height > 0 ? Double($0.width) / Double($0.height) : nil }
            height = ScrollGeometry.imageHeight(width: width, aspect: aspect, viewportHeight: viewportHeight)
        case .content:
            height = ScrollGeometry.contentHeight(
                placement: widget.placement, primaryFormat: payload.primaryFormat, showHeader: env.showHeader,
                unit: Double(env.u))
        }
        let u = Double(env.u)
        let placement = ScreenPlacement(
            cells: widget.placement, format: payload.primaryFormat,
            unitBox: u > 0 ? StudioCanvas(width: width / u, height: height / u) : nil)
        return WidgetView(widget: widget, placement: placement, env: env, image: imageForWidget(widget))
            .frame(width: CGFloat(width), height: CGFloat(height))
    }

    private func imageForWidget(_ widget: DeviceWidget) -> StoredImage? {
        StoredImage.forWidget(widget, payload: payload, state: state, images: images)
    }

    private func imageFile(_ id: String?) -> StoredImage? {
        StoredImage.find(id, payload: payload, state: state, images: images)
    }
}
