import NetricsKit
import SwiftUI

/**
 * Touch on the shared dashboards (#414), given by the iPhone and iPad app;
 * Apple TV gives none and renders as before. A tap on a widget with numbers
 * (`WidgetDetail.available`) opens its detail sheet; every widget carries
 * the slideshow's VoiceOver actions (next, previous, pause), so they are at
 * hand wherever VoiceOver is.
 */
public struct WidgetInteraction {
    /** A named VoiceOver action ("Next slide"). */
    public struct Action {
        public var name: String
        public var perform: @MainActor () -> Void

        public init(name: String, perform: @escaping @MainActor () -> Void) {
            self.name = name
            self.perform = perform
        }
    }

    public var openWidget: @MainActor (DeviceWidget) -> Void
    public var actions: [Action]

    public init(openWidget: @escaping @MainActor (DeviceWidget) -> Void, actions: [Action] = []) {
        self.openWidget = openWidget
        self.actions = actions
    }
}

extension View {
    /** The widget's tap and VoiceOver actions; unchanged without an interaction (Apple TV). */
    @ViewBuilder
    func touch(_ widget: DeviceWidget, _ interaction: WidgetInteraction?, language: ScreenLanguage) -> some View {
        if let interaction {
            modifier(WidgetTouch(widget: widget, interaction: interaction, language: language))
        } else {
            self
        }
    }

    /** The slideshow's VoiceOver actions on an element that is not a widget (the header). */
    @ViewBuilder
    func slideActions(_ interaction: WidgetInteraction?) -> some View {
        if let interaction, !interaction.actions.isEmpty {
            accessibilityActions {
                ForEach(Array(interaction.actions.enumerated()), id: \.offset) { _, action in
                    Button(action.name) { action.perform() }
                }
            }
        } else {
            self
        }
    }
}

private struct WidgetTouch: ViewModifier {
    let widget: DeviceWidget
    let interaction: WidgetInteraction
    let language: ScreenLanguage

    func body(content: Content) -> some View {
        if WidgetDetail.available(widget) {
            content
                .contentShape(Rectangle())
                .onTapGesture { interaction.openWidget(widget) }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(L10n.tr("Shows the details.", language))
                .slideActions(interaction)
        } else {
            content
                .accessibilityElement(children: .combine)
                .slideActions(interaction)
        }
    }
}
