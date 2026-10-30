import NetricsKit
import SwiftUI

/**
 * Screen view of a schema 2 or 3 dashboard (ADR 0015, sections 7 and 8;
 * ADR 0017), shared by Apple TV and iPad: its enabled slides in the format
 * of the size this view is given, one page at a time, rotated here by each
 * slide's duration (a continuation page shows for the slide's full
 * duration). Schema 2 is always the 16x9 layout. The format is recomputed
 * whenever the size changes (a turned iPad, a resized window), and a new
 * payload or format keeps the slide on screen when it still exists. Pages
 * fade in 400 ms, or switch at once with Reduce Motion or the dashboard's
 * "none" transition. While the rotation moves on by itself, the slide footer
 * says where it is and what comes next (ADR 0018 section 5).
 *
 * The rotation is the caller's state, so each platform adds its own input
 * on top: the Siri Remote on tvOS, touch on iPad.
 */
public struct SlideshowPlayer: View {
    let state: DeviceState
    let payload: DeviceDashboardV2
    let images: FileImageCache
    @Binding var rotation: SlideRotation?

    public init(
        state: DeviceState, payload: DeviceDashboardV2, images: FileImageCache, rotation: Binding<SlideRotation?>
    ) {
        self.state = state
        self.payload = payload
        self.images = images
        _rotation = rotation
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /** How a page change animates: a 400 ms fade, none with Reduce Motion or the "none" transition. */
    public static func animation(_ payload: DeviceDashboardV2, reduceMotion: Bool) -> Animation? {
        reduceMotion || payload.rotation.transition == .none ? nil : .easeInOut(duration: 0.4)
    }

    private var animation: Animation? { Self.animation(payload, reduceMotion: reduceMotion) }

    /** What the rotation follows: the pages and whether they advance. */
    private struct RotationInput: Equatable {
        var pages: [ScreenPage]
        var autoAdvance: Bool
    }

    public var body: some View {
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

    /** "2 / 3 · Sales · next: Team" and the slide's time, while the rotation moves on by itself. */
    private func footer(pages: [ScreenPage], page: ScreenPage) -> SlideFooterInfo? {
        guard let rotation, rotation.rotates, let index = pages.firstIndex(where: { $0.id == page.id }) else {
            return nil
        }
        func name(_ entry: ScreenPage) -> String? {
            SlideFooter.entryName(
                slideName: payload.slides.first { $0.id == entry.slideId }?.name, pageLabel: entry.pageLabel)
        }
        let next = pages[(index + 1) % pages.count]
        let progress = rotation.progress(at: Date())
        return SlideFooterInfo(
            text: SlideFooter.text(
                position: index + 1, count: pages.count, name: name(page), next: name(next),
                language: payload.language),
            progress: progress, remaining: (1 - progress) * rotation.currentDuration, paused: rotation.isPaused)
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
                    state: state, images: images, paused: rotation?.isPaused ?? false,
                    footer: footer(pages: pages, page: page)
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
