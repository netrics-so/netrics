import NetricsKit
import SwiftUI

/**
 * A schema 2 dashboard (ADR 0015, sections 7 and 8): its enabled slides,
 * one at a time, rotated here by each slide's duration. Left and right on
 * the Siri Remote change the slide, Play/Pause pauses the rotation (and
 * opens the settings when there is nothing to rotate), and pressing and
 * holding the clickpad opens the settings. A new payload keeps the slide on
 * screen when it still exists. Slides fade in 400 ms, or switch at once
 * with Reduce Motion or the dashboard's "none" transition.
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

    private var current: DeviceSlide? {
        let id = rotation?.currentID
        return payload.slides.first { $0.id == id } ?? payload.slides.first
    }

    var body: some View {
        let colors = StudioColors(payload.theme.tokens)
        ZStack {
            colors.background.ignoresSafeArea()
            if let slide = current {
                SlideCanvasView(
                    payload: payload, slide: slide, colors: colors, state: state, images: images,
                    paused: rotation?.isPaused ?? false
                )
                .id(slide.id)
                .transition(.opacity)
            } else {
                MessageView(title: payload.dashboard?.name ?? "netrics", text: "This dashboard has no slides yet.")
            }
        }
        .ignoresSafeArea()
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
                rotation = SlideRotation(payload, now: Date())
            }
        }
        .onChange(of: payload) { _, next in
            guard var updated = rotation else { return }
            updated.update(next, now: Date())
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
    /** Canvas points per unit (canvas height / 1080). */
    let u: CGFloat
    let colors: StudioColors
    let showHeader: Bool
    let timeZone: String
    /** The pixels per point of the screen (image decoding). */
    let displayScale: CGFloat

    var fontScale: Double { colors.fontScale }

    func font(_ units: Double, _ weight: Font.Weight = .regular) -> Font {
        .system(size: CGFloat(units) * u, weight: weight)
    }

    func pt(_ units: Double) -> CGFloat { CGFloat(units) * u }
}

/**
 * One slide on a 16:9 canvas: the background image under a dim of the
 * theme background, the header band, and the widgets placed by
 * StudioLayout.widgetRect, so they sit where the web puts them.
 */
struct SlideCanvasView: View {
    let payload: DeviceDashboardV2
    let slide: DeviceSlide
    let colors: StudioColors
    let state: DeviceState
    let images: FileImageCache
    let paused: Bool

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { screen in
            // The largest 16:9 canvas on the screen (a TV is 16:9: all of it).
            let width = min(screen.size.width, screen.size.height * 16 / 9)
            let height = width * 9 / 16
            let canvas = StudioCanvas(width: Double(width), height: Double(height))
            let showHeader = payload.dashboard?.showHeader ?? true
            let env = WidgetEnv(
                u: height / 1080, colors: colors, showHeader: showHeader, timeZone: payload.timeZone,
                displayScale: displayScale)
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
                if showHeader {
                    let band = StudioLayout.frame(canvas: canvas, showHeader: true).header!
                    SlideHeaderView(
                        payload: payload, slide: slide, env: env, state: state, paused: paused,
                        logo: imageFile(payload.dashboard?.logoImageId)
                    )
                    .frame(width: width, height: CGFloat(band.height))
                }
                ForEach(slide.widgets) { widget in
                    let rect = StudioLayout.widgetRect(widget.placement, canvas: canvas, showHeader: showHeader)
                    WidgetView(widget: widget, env: env, image: imageForWidget(widget))
                        .frame(width: CGFloat(rect.width), height: CGFloat(rect.height))
                        .position(x: CGFloat(rect.x + rect.width / 2), y: CGFloat(rect.y + rect.height / 2))
                }
            }
            .frame(width: width, height: height)
            .clipped()
            .position(x: screen.size.width / 2, y: screen.size.height / 2)
        }
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

/** Logo, dashboard and slide name, offline marker and clock (ADR 0015, section 1). */
struct SlideHeaderView: View {
    let payload: DeviceDashboardV2
    let slide: DeviceSlide
    let env: WidgetEnv
    let state: DeviceState
    let paused: Bool
    let logo: StoredImage?

    var body: some View {
        let colors = env.colors
        HStack(spacing: env.pt(20)) {
            if let logo {
                let height = env.pt(48)
                let aspect = logo.image.height > 0 ? CGFloat(logo.image.width) / CGFloat(logo.image.height) : 1
                DownsampledImage(
                    file: logo.url, image: logo.image, fit: .contain, align: .center,
                    box: CGSize(width: height * aspect, height: height), displayScale: env.displayScale
                )
                .frame(width: height * aspect, height: height)
            }
            // Names shrink rather than lose their end.
            Text(payload.dashboard?.name ?? "")
                .font(env.font(36, .semibold))
                .foregroundStyle(colors.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .layoutPriority(2)
            if let name = slide.name, !name.isEmpty {
                Text(name)
                    .font(env.font(30))
                    .foregroundStyle(colors.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .layoutPriority(1)
            }
            Spacer(minLength: env.pt(24))
            HStack(spacing: env.pt(24)) {
                if paused {
                    Text("❚❚ Paused")
                        .font(env.font(30))
                        .foregroundStyle(colors.muted)
                }
                if state.offline {
                    Text("⚠ \(TVTime.offlineMarker(updatedAt: state.updatedAt, timeZone: payload.timeZone))")
                        .font(env.font(30))
                        .foregroundStyle(colors.warning)
                        .lineLimit(1)
                }
                TimelineView(.everyMinute) { context in
                    Text(TVTime.hourMinute(context.date, timeZone: payload.timeZone))
                        .font(env.font(30).monospacedDigit())
                        .foregroundStyle(colors.accent)
                }
            }
            .fixedSize()
        }
        .padding(.horizontal, env.pt(32))
        .frame(maxHeight: .infinity)
    }
}
