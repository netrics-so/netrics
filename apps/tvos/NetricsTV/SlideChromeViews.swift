import NetricsKit
import SwiftUI

// What a playing screen shows around its slides (ADR 0018 section 5): the
// header's refresh countdown and the slide footer. Their rules (cadence,
// fit, wording) are NetricsKit's `RefreshCountdown` and `SlideFooter`.

/**
 * The header's "next refresh in 42 s" over a thin bar that fills towards
 * the refresh: updated once a second, the bar moving linearly between
 * ticks and jumping back without a transition when a new cycle starts.
 */
struct RefreshCountdownView: View {
    let since: Date
    let every: TimeInterval
    let env: WidgetEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: since, by: 1)) { context in
            let countdown = RefreshCountdown.at(context.date, since: since, every: every)
            // The first second of a cycle: the bar starts over at once.
            let reset = countdown.fraction * every < 1
            let width = env.pt(RefreshCountdown.barWidth)
            HStack(spacing: env.pt(RefreshCountdown.gap)) {
                Text(KitStrings.text(.nextRefresh, env.language, countdown.seconds))
                    .font(env.font(RefreshCountdown.textSize).monospacedDigit())
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(1)
                    .fixedSize()
                Capsule()
                    .fill(Color(env.colors.derived.refreshTrack))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(env.colors.accent)
                            .frame(width: width * countdown.fraction)
                            .animation(reset || reduceMotion ? nil : .linear(duration: 1), value: countdown.fraction)
                    }
                    .clipShape(Capsule())
                    .frame(width: width, height: env.pt(RefreshCountdown.barHeight))
            }
        }
    }
}

/** What the slide footer shows: its text and where the slide's time is. */
struct SlideFooterInfo: Equatable {
    var text: String
    /** How much of the slide's time has passed, 0 … 1. */
    var progress: Double
    /** Seconds left of the slide's time. */
    var remaining: TimeInterval
    var paused: Bool
}

/**
 * The slide footer: "2 / 3 · Sales · next: Team" in the muted colour over
 * a thin bar that fills linearly over the slide's time, held while paused;
 * with Reduce Motion the bar does not move (as on the web).
 */
struct SlideFooterView: View {
    let info: SlideFooterInfo
    let env: WidgetEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var filled = 0.0

    var body: some View {
        let derived = env.colors.derived
        VStack(alignment: .leading, spacing: env.pt(SlideFooter.gap)) {
            Spacer(minLength: 0)
            Text(info.text)
                .font(env.font(SlideFooter.textSize).monospacedDigit())
                .foregroundStyle(env.colors.muted)
                .lineLimit(1)
                .truncationMode(.tail)
                // Line height 1, as the web: text and bar fit the 32 unit padding.
                .frame(height: env.pt(SlideFooter.textSize), alignment: .bottom)
            GeometryReader { box in
                Capsule()
                    .fill(Color(derived.track))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(Color(derived.slideProgress))
                            .frame(width: box.size.width * filled)
                    }
                    .clipShape(Capsule())
            }
            .frame(height: env.pt(SlideFooter.barHeight))
        }
        .padding(.horizontal, env.pt(StudioLayout.padding))
        .allowsHitTesting(false)
        .onAppear(perform: sync)
        .onChange(of: info.paused) { sync() }
    }

    /** Holds the bar where the slide's time is, then fills it over the time left. */
    private func sync() {
        var hold = Transaction()
        hold.disablesAnimations = true
        withTransaction(hold) { filled = info.progress }
        guard !reduceMotion, !info.paused, info.remaining > 0 else { return }
        let remaining = info.remaining
        Task { @MainActor in
            withAnimation(.linear(duration: remaining)) { filled = 1 }
        }
    }
}
