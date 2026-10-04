import NetricsKit
import SwiftUI

// The polished TV design on tvOS (ADR 0018 sections 5 and 6, #313): widget
// surfaces derived from the theme, the enter motion and the continuous
// cues. The rules (which surface, which colours, the easing, the count-up)
// are NetricsKit's (`SignalDesign.swift`); this file only draws them.
//
// Motion is cheap by construction: one state change per slide starts the
// enter, and SwiftUI interpolates it (trim, scale, opacity and the
// count-up's animatable value) for 1.2 s, then nothing is redrawn. The only
// continuous animations are the pulse on a chart's last point, the stale
// dot's blink and the skeleton's sweep; with Reduce Motion none of it runs
// and the final state shows at once.

extension Color {
    init(_ color: ThemeColor) {
        self.init(red: color.red, green: color.green, blue: color.blue)
    }

    init(_ tinted: TintedColor) {
        self.init(red: tinted.color.red, green: tinted.color.green, blue: tinted.color.blue, opacity: tinted.opacity)
    }
}

extension EnvironmentValues {
    /** The slide's enter progress, eased, 0 → 1 (animated); 1 when nothing enters. */
    @Entry var enterProgress: Double = 1
    /** Whether the continuous cues run: on a playing slide, not with Reduce Motion. */
    @Entry var motionCues: Bool = false
}

extension Animation {
    /** The slide enter: 1200 ms, ease-out cubic (`cubic-bezier(0.33, 1, 0.68, 1)`). */
    static var slideEnter: Animation {
        let c = EnterMotion.bezier
        return .timingCurve(c.x1, c.y1, c.x2, c.y2, duration: EnterMotion.duration)
    }
}

// MARK: Surfaces

/** How a widget's box looks for its data status (web: `.sw--stale`, `.sw--auth`, `.sw--empty`). */
enum SurfaceState {
    case normal, stale, auth, empty

    init(_ status: DeviceTileStatus) {
        switch status {
        case .stale: self = .stale
        case .authFailed: self = .auth
        case .noData, .backfilling: self = .empty
        case .ok, .outage: self = .normal
        }
    }
}

/** The 1.5 unit inner highlight along a rounded box's top edge (`inset 0 1.5u 0`). */
struct TopHighlight: Shape {
    let radius: CGFloat
    let height: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
        path.addRoundedRect(in: rect.offsetBy(dx: 0, dy: height), cornerSize: CGSize(width: radius, height: radius))
        return path
    }
}

extension View {
    /**
     * The widget box (web: `.sw`): padding, the surface derived from the
     * theme (layered: a gradient from the surface lifted towards the accent
     * to the surface sunk towards the background, a 1.5 unit inner
     * highlight and a soft shadow; flat: the plain surface), a 24 unit
     * radius and the border, in the data status's colours.
     */
    func surface(_ env: WidgetEnv, state: SurfaceState = .normal, padded: Bool = true) -> some View {
        let derived = env.colors.derived
        let layered = derived.kind == .layered
        let radius = env.pt(SurfaceMetrics.radius)
        let shape = RoundedRectangle(cornerRadius: radius)
        let line = max(1, env.pt(SurfaceMetrics.border))
        let fill = state == .auth
            ? LinearGradient(colors: [Color(derived.authTop), Color(derived.authBottom)], startPoint: .top, endPoint: .bottom)
            : LinearGradient(
                colors: [Color(derived.widgetTop), Color(derived.widgetBottom)], startPoint: .top, endPoint: .bottom)
        let border: Color =
            switch state {
            case .normal: env.colors.border
            case .stale: Color(derived.staleBorder)
            case .auth: Color(derived.authBorder)
            case .empty: Color(derived.emptyBorder)
            }
        let depth = layered && state != .empty
        return self
            .padding(padded ? env.pt(StudioLayout.widgetPadding) : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .clipShape(shape)
            .background {
                shape.fill(fill)
                    .overlay {
                        if depth {
                            TopHighlight(radius: radius, height: env.pt(SurfaceMetrics.highlight))
                                .fill(Color(derived.highlight), style: FillStyle(eoFill: true))
                                .clipShape(shape)
                        }
                    }
                    .shadow(
                        color: depth ? .black.opacity(SurfaceMetrics.shadowOpacity) : .clear,
                        radius: depth ? env.pt(SurfaceMetrics.shadowBlur / 2) : 0, x: 0,
                        y: depth ? env.pt(SurfaceMetrics.shadowY) : 0)
            }
            .overlay {
                shape.strokeBorder(
                    border,
                    style: StrokeStyle(lineWidth: line, dash: state == .empty ? [line * 3, line * 3] : []))
            }
    }
}

// MARK: Enter motion

/**
 * A value that counts up from zero while its slide enters, in the form
 * it shows at rest (full or compact, currency, "≈"), ending on exactly
 * that text. The resting text sets the size, so counting never moves the
 * layout.
 */
struct CountingValue: View {
    /** The text at rest. */
    let final: String
    /** The number counted; nil: nothing counts (the text shows at once). */
    let target: Double?
    /** Words a counted number as the resting text is worded; nil: no count. */
    let format: ((Double) -> String)?

    @Environment(\.enterProgress) private var progress

    var body: some View {
        Text(final)
            .opacity(0)
            .modifier(CountUpOverlay(progress: progress, final: final, target: target, format: format))
            .accessibilityLabel(final)
    }
}

/** The counting text over the resting one, one frame at a time (animatable). */
struct CountUpOverlay: ViewModifier, Animatable {
    var progress: Double
    let final: String
    let target: Double?
    let format: ((Double) -> String)?

    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let text: String =
            if let target, let format {
                EnterMotion.countUpText(target, eased: progress, format: format, final: final)
            } else {
                final
            }
        content.overlay(alignment: .leading) {
            Text(text).lineLimit(1)
        }
    }
}

/** Hidden until the enter's draw is complete (end dots, ADR 0018 section 6). */
struct AppearAtEnd: ViewModifier, Animatable {
    var progress: Double

    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        content.opacity(progress >= 0.999 ? 1 : 0)
    }
}

// MARK: Continuous cues

private struct PulseFrame {
    var scale = 1.0
    var opacity = 0.55
}

/**
 * The last point's pulse (2.4 s): a disc of the accent growing 21 units
 * out from the dot and fading over the first 70 %, starting once the
 * enter's draw is done.
 */
struct PulseRing: View {
    let color: Color
    /** The dot's radius in points. */
    let radius: CGFloat
    /** The ring's reach beyond the dot in points. */
    let reach: CGFloat

    @Environment(\.motionCues) private var motionCues
    @State private var started = false

    var body: some View {
        ZStack {
            if motionCues && started {
                let scale = (radius + reach) / max(radius, 1)
                Circle()
                    .fill(color)
                    .frame(width: radius * 2, height: radius * 2)
                    .keyframeAnimator(initialValue: PulseFrame(), repeating: true) { view, frame in
                        view.scaleEffect(frame.scale).opacity(frame.opacity)
                    } keyframes: { _ in
                        KeyframeTrack(\.scale) {
                            CubicKeyframe(scale, duration: EnterMotion.pulse * 0.7)
                            LinearKeyframe(scale, duration: EnterMotion.pulse * 0.3)
                        }
                        KeyframeTrack(\.opacity) {
                            CubicKeyframe(0, duration: EnterMotion.pulse * 0.7)
                            LinearKeyframe(0, duration: EnterMotion.pulse * 0.3)
                        }
                    }
            }
        }
        .allowsHitTesting(false)
        .task {
            guard motionCues else { return }
            try? await Task.sleep(for: .seconds(EnterMotion.duration))
            started = true
        }
    }
}

/** The dot before a stale notice, blinking (1.8 s) on a playing slide. */
struct StaleDot: View {
    let color: Color
    let size: CGFloat

    @Environment(\.motionCues) private var motionCues

    var body: some View {
        let dot = Circle().fill(color).frame(width: size, height: size)
        if motionCues {
            dot.keyframeAnimator(initialValue: 1.0, repeating: true) { view, opacity in
                view.opacity(opacity)
            } keyframes: { _ in
                CubicKeyframe(0.45, duration: EnterMotion.blink / 2)
                CubicKeyframe(1, duration: EnterMotion.blink / 2)
            }
        } else {
            dot
        }
    }
}

/** The skeleton block of no data and backfilling; it sweeps while the history loads. */
struct SkeletonBlock: View {
    let env: WidgetEnv
    let sweeping: Bool

    @Environment(\.motionCues) private var motionCues

    var body: some View {
        let derived = env.colors.derived
        let shape = RoundedRectangle(cornerRadius: env.pt(12))
        GeometryReader { box in
            let width = box.size.width * DataSurface.skeletonWidth
            shape.fill(Color(derived.skeleton))
                .overlay {
                    if sweeping && motionCues {
                        LinearGradient(
                            colors: [.clear, Color(derived.sweep), .clear], startPoint: .leading, endPoint: .trailing
                        )
                        .keyframeAnimator(initialValue: -width, repeating: true) { view, offset in
                            view.offset(x: offset)
                        } keyframes: { _ in
                            LinearKeyframe(width, duration: EnterMotion.sweep)
                        }
                    }
                }
                .clipShape(shape)
                .frame(width: width)
        }
        .frame(height: env.pt(DataSurface.skeletonHeight))
        .accessibilityHidden(true)
    }
}

// MARK: Chart shapes

/** A series as points in a unit square (x 0…1 left to right, y 0…1 top to bottom), gaps split it. */
struct PlotSeries {
    var segments: [[CGPoint]]

    init(_ values: [Double?], domain: ClosedRange<Double>, count: Int? = nil) {
        let slots = max((count ?? values.count) - 1, 1)
        let span = domain.upperBound - domain.lowerBound
        segments = Sparkline.segments(values).map { points in
            points.map { point in
                CGPoint(
                    x: CGFloat(Double(point.index) / Double(slots)),
                    y: CGFloat(1 - (span > 0 ? (point.value - domain.lowerBound) / span : 0.5)))
            }
        }
    }

    var last: CGPoint? { segments.last?.last }
}

/** The series' lines; a single point is a round dot (a zero-length segment). */
struct SeriesLine: Shape {
    let series: PlotSeries

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for segment in series.segments {
            guard let first = segment.first else { continue }
            path.move(to: place(first, rect))
            if segment.count == 1 {
                path.addLine(to: place(first, rect))
            }
            for point in segment.dropFirst() {
                path.addLine(to: place(point, rect))
            }
        }
        return path
    }
}

/** The area under the series down to `base` (0…1 from the top). */
struct SeriesArea: Shape {
    let series: PlotSeries
    let base: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let floor = rect.minY + base * rect.height
        for segment in series.segments where segment.count > 1 {
            let points = segment.map { place($0, rect) }
            path.move(to: CGPoint(x: points[0].x, y: floor))
            for point in points { path.addLine(to: point) }
            path.addLine(to: CGPoint(x: points[points.count - 1].x, y: floor))
            path.closeSubpath()
        }
        return path
    }
}

private func place(_ point: CGPoint, _ rect: CGRect) -> CGPoint {
    CGPoint(x: rect.minX + point.x * rect.width, y: rect.minY + point.y * rect.height)
}
