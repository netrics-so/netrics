import Foundation
import NetricsKit
import SwiftUI

// The app's own text (ADR 0016 section 6) comes from Localizable.xcstrings,
// keyed by the English text. The language is not the system's once paired:
// the payload's `locale` (the workspace's screen language) decides, so the
// strings are looked up in that language's .lproj explicitly rather than
// through SwiftUI's automatic lookup, which follows the system language.

extension EnvironmentValues {
    /** The TV's language: the system's before pairing, the payload's after. */
    @Entry var screenLanguage: ScreenLanguage = .system()
}

enum L10n {
    @MainActor private static var bundles: [ScreenLanguage: Bundle] = [:]

    @MainActor private static func bundle(_ language: ScreenLanguage) -> Bundle {
        if let bundle = bundles[language] { return bundle }
        let bundle = Bundle.main.path(forResource: language.rawValue, ofType: "lproj").flatMap(Bundle.init(path:))
            ?? Bundle.main
        bundles[language] = bundle
        return bundle
    }

    /** The app text in a language; `%@` and `%d` filled in order. English (the key) when missing. */
    @MainActor static func tr(_ key: String, _ language: ScreenLanguage, _ arguments: CVarArg...) -> String {
        let format = bundle(language).localizedString(forKey: key, value: key, table: "Localizable")
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: language.locale, arguments: arguments)
    }
}
