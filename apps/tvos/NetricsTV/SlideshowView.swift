import NetricsKit
import SwiftUI

/**
 * A schema 2 or 3 dashboard (ADR 0015, sections 7 and 8; ADR 0017): its
 * enabled slides in the screen's format, one page at a time, rotated here
 * by each slide's duration (a continuation page shows for the slide's full
 * duration). The format comes from the size this view is given, which is
 * the screen after the device's rotation setting; schema 2 is always the
 * 16x9 layout. Left and right on the Siri Remote change the page,
 * Play/Pause pauses the rotation (and opens the settings when there is
 * nothing to rotate), and pressing and holding the clickpad opens the
 * settings. A new payload or format keeps the slide on screen when it
 * still exists. Pages fade in 400 ms, or switch at once with Reduce Motion
 * or the dashboard's "none" transition.
 */
struct SlideshowView: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    let openSettings: () -> Void

    @State private var rotation: SlideRotation?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var animation: Animation? {
        reduceMotion || payload.rotation.transition == .none ? nil : .easeInOut(duration: 0.4)
    }

    /** What the rotation follows: the pages and whether they advance. */
    private struct RotationInput: Equatable {
        var pages: [ScreenPage]
        var autoAdvance: Bool
    }

    var body: some View {
        GeometryReader { screen in
            let viewport = StudioCanvas(width: Double(screen.size.width), height: Double(screen.size.height))
            let format = ScreenView.format(payload, viewport: viewport)
            slideshow(pages: ScreenView.pages(payload, format: format), format: format, viewport: viewport)
        }
        .ignoresSafeArea()
    }

    private func current(_ pages: [ScreenPage]) -> ScreenPage? {
        let id = rotation?.currentID
        return pages.first { $0.id == id } ?? pages.first
    }

    private func slideshow(pages: [ScreenPage], format: ScreenFormat, viewport: StudioCanvas) -> some View {
        let colors = StudioColors(payload.theme.tokens)
        let page = current(pages)
        let slide = page.flatMap { page in payload.slides.first { $0.id == page.slideId } }
        return ZStack {
            colors.background.ignoresSafeArea()
            if let page, let slide {
                SlideCanvasView(
                    payload: payload, slide: slide, page: page, format: format, viewport: viewport, colors: colors,
                    state: state, images: images, paused: rotation?.isPaused ?? false
                )
                .id(page.id)
                .transition(.opacity)
            } else {
                MessageView(
                    title: payload.dashboard?.name ?? "netrics",
                    text: L10n.tr("This dashboard has no slides yet.", payload.language))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .focusable()
        .focusEffectDisabled()
        .onLongPressGesture(minimumDuration: 0.8, perform: openSettings)
        .onPlayPauseCommand {
            guard var next = rotation, next.rotates else {
                openSettings()
                return
            }
            next.togglePause(now: Date())
            rotation = next
        }
        .onMoveCommand { direction in
            guard var next = rotation, next.rotates else { return }
            switch direction {
            case .left: next.previous(now: Date())
            case .right: next.next(now: Date())
            default: return
            }
            withAnimation(animation) { rotation = next }
        }
        .onAppear {
            if rotation == nil {
                rotation = SlideRotation(pages: pages, autoAdvance: payload.rotation.autoAdvance, now: Date())
            }
        }
        .onChange(of: RotationInput(pages: pages, autoAdvance: payload.rotation.autoAdvance)) { _, next in
            guard var updated = rotation else { return }
            updated.update(pages: next.pages, autoAdvance: next.autoAdvance, now: Date())
            withAnimation(animation) { rotation = updated }
        }
        // One timer per scheduled change: re-armed whenever the rotation moves.
        .task(id: rotation) {
            guard let due = rotation?.nextChange() else { return }
            let wait = max(due.timeIntervalSinceNow, 0)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, var next = rotation else { return }
            if next.advance(to: Date()) {
                withAnimation(animation) { rotation = next }
            } else {
                rotation = next
            }
        }
    }
}

/** The theme's tokens as SwiftUI colours; the theme replaces the static palette. */
struct StudioColors {
    let background, surface, border, text, label, muted, accent, up, down, warning, chartLine, chartFill: Color
    let fontScale: Double

    init(_ tokens: ThemeTokens) {
        background = Color(token: tokens.background)
        surface = Color(token: tokens.surface)
        border = Color(token: tokens.border)
        text = Color(token: tokens.text)
        label = Color(token: tokens.label)
        muted = Color(token: tokens.muted)
        accent = Color(token: tokens.accent)
        up = Color(token: tokens.up)
        down = Color(token: tokens.down)
        warning = Color(token: tokens.warning)
        chartLine = Color(token: tokens.chartLine)
        chartFill = Color(token: tokens.chartFill)
        fontScale = tokens.fontScale
    }

    func tone(_ direction: MetricFormat.Direction) -> Color {
        switch direction {
        case .up: return up
        case .down: return down
        case .flat: return muted
        }
    }
}

/** What a widget needs besides itself: canvas unit, colours and context. */
struct WidgetEnv {
    /** Screen points per unit (the frame's unit: canvas height / 1080 at 16:9). */
    let u: CGFloat
    let colors: StudioColors
    let showHeader: Bool
    let timeZone: String
    /** The pixels per point of the screen (image decoding). */
    let displayScale: CGFloat
    /** The screen language: chrome and numbers (ADR 0016). */
    var language: ScreenLanguage = .en

    var fontScale: Double { colors.fontScale }

    func font(_ units: Double, _ weight: Font.Weight = .regular) -> Font {
        .system(size: CGFloat(units) * u, weight: weight)
    }

    func pt(_ units: Double) -> CGFloat { CGFloat(units) * u }
}

/**
 * One page of a slide on the screen (ADR 0017, section 2): the format's
 * grid over the whole viewport (stretched at most 4/3, else centred), the
 * background image under a dim of the theme background covering the whole
 * viewport, the header band, and the page's widgets placed by
 * StudioLayout.placementRect, so they sit where the web puts them. A
 * `16x9` slide on a 16:9 TV is exactly the canvas of ADR 0015.
 */
struct SlideCanvasView: View {
    let payload: DeviceDashboardV2
    let slide: DeviceSlide
    let page: ScreenPage
    let format: ScreenFormat
    /** Points, after the rotation setting. */
    let viewport: StudioCanvas
    let colors: StudioColors
    let state: DeviceState
    let images: FileImageCache
    let paused: Bool

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let showHeader = payload.dashboard?.showHeader ?? true
        let geometry = ScreenView.geometry(viewport: viewport, format: format, showHeader: showHeader)
        let width = CGFloat(viewport.width)
        let height = CGFloat(viewport.height)
        let env = WidgetEnv(
            u: CGFloat(geometry.frame.unit), colors: colors, showHeader: showHeader, timeZone: payload.timeZone,
            displayScale: displayScale, language: payload.language)
        let widgets = Dictionary(slide.widgets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        ZStack(alignment: .topLeading) {
            colors.background
            if let background = slide.background, let file = imageFile(background.imageId) {
                DownsampledImage(
                    file: file.url, image: file.image, fit: .cover, align: .center,
                    box: CGSize(width: width, height: height), displayScale: displayScale)
                .frame(width: width, height: height)
                .clipped()
                colors.background.opacity(Double(background.dim) / 100)
            }
            if let band = geometry.frame.header {
                SlideHeaderView(
                    payload: payload, slide: slide, format: format, pageLabel: page.pageLabel, env: env, state: state,
                    paused: paused, logo: imageFile(payload.dashboard?.logoImageId)
                )
                .frame(width: CGFloat(band.width), height: CGFloat(band.height))
                .position(x: CGFloat(band.x + band.width / 2), y: CGFloat(band.y + band.height / 2))
            }
            ForEach(page.placements, id: \.id) { cell in
                if let widget = widgets[cell.id] {
                    let placed = geometry.place(cell.cells)
                    let rect = placed.rect
                    WidgetView(widget: widget, placement: placed.placement, env: env, image: imageForWidget(widget))
                        .frame(width: CGFloat(rect.width), height: CGFloat(rect.height))
                        .position(x: CGFloat(rect.x + rect.width / 2), y: CGFloat(rect.y + rect.height / 2))
                }
            }
        }
        .frame(width: width, height: height)
        .clipped()
    }

    private func imageForWidget(_ widget: DeviceWidget) -> StoredImage? {
        if case .image(let id, _) = widget.content {
            return imageFile(id)
        }
        return nil
    }

    /** The image's file, once it is stored (offline: from earlier runs). */
    private func imageFile(_ id: String?) -> StoredImage? {
        guard let image = payload.image(id), state.storedImages.contains(image.sha256),
            let url = images.fileURL(image.sha256)
        else { return nil }
        return StoredImage(url: url, image: image)
    }
}

struct StoredImage {
    let url: URL
    let image: DeviceImage
}

/**
 * Logo, dashboard and slide name, page, offline marker and clock (ADR
 * 0015, section 1). The format's header rule (`headerFit`, ADR 0017
 * section 6): in narrow formats (3:4, 9:16) the dashboard name wraps to two
 * lines before it shrinks, and the slide name is shown only when it fits
 * beside a one-line name, so it is dropped before the dashboard name is
 * cut. The page ("1/2") is never dropped.
 */
struct SlideHeaderView: View {
    let payload: DeviceDashboardV2
    let slide: DeviceSlide
    let format: ScreenFormat
    let pageLabel: String?
    let env: WidgetEnv
    let state: DeviceState
    let paused: Bool
    let logo: StoredImage?

    var body: some View {
        let colors = env.colors
        let name = payload.dashboard?.name ?? ""
        let fit = StudioLayout.headerFit(
            name: name, slideName: slide.name, format: format,
            logoAspect: logo.flatMap { $0.image.height > 0 ? Double($0.image.width) / Double($0.image.height) : nil })
        HStack(spacing: env.pt(StudioHeaderMetrics.gap)) {
            if let logo {
                let height = env.pt(StudioHeaderMetrics.logo)
                let aspect = logo.image.height > 0 ? CGFloat(logo.image.width) / CGFloat(logo.image.height) : 1
                DownsampledImage(
                    file: logo.url, image: logo.image, fit: .contain, align: .center,
                    box: CGSize(width: height * aspect, height: height), displayScale: env.displayScale
                )
                .frame(width: height * aspect, height: height)
            }
            // Names wrap (narrow formats) or shrink rather than lose their end.
            Text(name)
                .font(env.font(StudioHeaderMetrics.name, .semibold))
                .foregroundStyle(colors.text)
                .lineLimit(fit.maxNameLines)
                .minimumScaleFactor(0.6)
                .layoutPriority(2)
            if let slideName = slide.name, !slideName.isEmpty, fit.showSlideName {
                Text(slideName)
                    .font(env.font(StudioHeaderMetrics.meta))
                    .foregroundStyle(colors.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .layoutPriority(1)
            }
            if let pageLabel {
                Text(pageLabel)
                    .font(env.font(StudioHeaderMetrics.meta).monospacedDigit())
                    .foregroundStyle(colors.muted)
                    .fixedSize()
            }
            Spacer(minLength: env.pt(StudioHeaderMetrics.clockSpace))
            HStack(spacing: env.pt(24)) {
                if paused {
                    Text("❚❚ \(L10n.tr("Paused", env.language))")
                        .font(env.font(30))
                        .foregroundStyle(colors.muted)
                }
                if state.offline {
                    Text("⚠ \(TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: payload.timeZone, language: env.language))")
                        .font(env.font(30))
                        .foregroundStyle(colors.warning)
                        .lineLimit(1)
                }
                TimelineView(.everyMinute) { context in
                    Text(TVTime.hourMinute(context.date, timeZone: payload.timeZone, language: env.language))
                        .font(env.font(StudioHeaderMetrics.meta).monospacedDigit())
                        .foregroundStyle(colors.accent)
                }
            }
            .fixedSize()
        }
        .padding(.horizontal, env.pt(StudioHeaderMetrics.padding))
        .frame(maxHeight: .infinity)
    }
}
