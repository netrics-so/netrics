import NetricsKit
import SwiftUI

/** The dark TV palette, as on the web TV layout (globals.css, .tv). */
public enum Theme {
    public static let background = Color(hex: 0x07090C)
    public static let tile = Color(hex: 0x11141A)
    public static let tileBorder = Color(hex: 0x23272E)
    public static let text = Color(hex: 0xE6E9ED)
    public static let label = Color(hex: 0xC5CAD3)
    public static let muted = Color(hex: 0x8A919C)
    public static let faint = Color(hex: 0x3A404A)
    public static let up = Color(hex: 0x9FD6A8)
    public static let down = Color(hex: 0xF0A3A3)
    public static let warning = Color(hex: 0xE3B341)
    public static let sparkLine = Color(hex: 0x5C6470)
    public static let accent = Color(hex: 0x7AA2F7)
}

extension Color {
    /** A theme token (`#rrggbb`); netrics Dark's text colour if it is not one. */
    public init(token: String) {
        let color = ThemeColor.parse(token) ?? ThemeColor.parse(ThemeTokens.netricsDark.text)!
        self.init(red: color.red, green: color.green, blue: color.blue)
    }

    public init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/** One calm message in the middle of the screen. */
public struct MessageView: View {
    let title: String
    let text: String
    var marker: String?

    public init(title: String, text: String, marker: String? = nil) {
        self.title = title
        self.text = text
        self.marker = marker
    }

    public var body: some View {
        VStack(spacing: 32) {
            Text(title)
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(text)
                .font(.system(size: 32))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1300)
            if let marker {
                Text(marker)
                    .font(.system(size: 24))
                    .foregroundStyle(Theme.warning)
            }
        }
        .padding(80)
    }
}
