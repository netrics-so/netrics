import Foundation
import NetricsKit
import SwiftUI

/**
 * "Try a demo" (#416, ADR 0021 section 5): the sample dashboard bundled with
 * the app, a schema 3 payload in English and German with invented numbers,
 * no images and a theme. It is shown as if paired, fully offline: nothing
 * is sent, nothing is stored. The dates are moved to today first
 * (`DemoPayload.retime`).
 */
public enum DemoDashboard {
    /** The bundled payload file for a language. */
    public static func url(_ language: ScreenLanguage) -> URL? {
        Bundle.module.url(forResource: "demo-dashboard.\(language.rawValue)", withExtension: "json")
    }

    /** The demo payload in a language, moved to `now` in `timeZone`. */
    public static func payload(
        language: ScreenLanguage = .system(), now: Date = Date(), timeZone: TimeZone = .current
    ) throws -> DashboardPayload {
        guard let url = url(language) ?? url(.en) else { throw CocoaError(.fileNoSuchFile) }
        let data = try DemoPayload.retime(Data(contentsOf: url), now: now, timeZone: timeZone)
        return try JSONDecoder().decode(DashboardPayload.self, from: data)
    }

    /**
     * What the screens render: the payload as a paired device's state. No
     * `updatedAt`, so the header shows no refresh countdown (nothing refreshes).
     */
    public static func state(
        language: ScreenLanguage = .system(), now: Date = Date(), timeZone: TimeZone = .current
    ) throws -> DeviceState {
        var state = DeviceState()
        state.payload = try payload(language: language, now: now, timeZone: timeZone)
        state.phase = .paired
        return state
    }
}

extension EnvironmentValues {
    /** True while the screen shows the demo dashboard: its header says "Demo". */
    @Entry public var demoMode = false
}

/** "Demo" in the header of the demo dashboard, in the theme's accent. */
struct DemoBadge: View {
    let text: String
    let size: CGFloat
    let colors: StudioColors

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(colors.background)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, size * 0.55)
            .padding(.vertical, size * 0.18)
            .background(colors.accent, in: Capsule())
            .accessibilityLabel(text)
    }
}
