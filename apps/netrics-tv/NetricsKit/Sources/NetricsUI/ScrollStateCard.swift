import NetricsKit
import SwiftUI

private typealias Size = ScrollGeometry.TypeSize

/**
 * The state card in the scroll view (#875): the single form's item, or
 * every item the server sent, not healthy first, names wrapped in full;
 * "+N more" for those beyond the list's limit. The card is one column and
 * as tall as its content. Each state is its shape and word, never colour
 * alone.
 */
struct ScrollStateCard: View {
    let label: String
    let options: StateWidgetOptions
    let data: StateWidgetData
    let env: WidgetEnv
    let now: Date

    var body: some View {
        let language = env.language
        let items = options.single ? Array(data.items.prefix(1)) : data.items
        let more = options.single ? 0 : max(0, data.total - items.count)
        let footer = StateBoard.footer(
            data, now: now, language: language, width: .infinity, size: Size.small,
            timeZone: TimeZone(identifier: env.timeZone) ?? .current)
        VStack(alignment: .leading, spacing: CGFloat(ScrollGeometry.cardGap)) {
            ScrollLabel(label: label, env: env)
            if items.isEmpty {
                ScrollMutedLine(text: KitStrings.text(.stateEmpty, language), env: env)
            } else {
                VStack(alignment: .leading, spacing: env.pt(12)) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        row(item)
                    }
                    if more > 0 {
                        Text(KitStrings.text(.statusMore, language, more))
                            .font(env.font(Size.small))
                            .foregroundStyle(env.colors.muted)
                    }
                }
                .padding(.top, env.pt(12))
            }
            if let footer {
                ScrollBottomLine(
                    notice: footer.warning ? footer.text : nil, stale: false,
                    footer: footer.warning ? nil : footer.text, env: env)
            }
        }
    }

    private func row(_ item: StateWidgetItem) -> some View {
        let color = StateWidgetView.color(item.state.tone(rolledBack: item.rolledBack), env)
        let age = options.showChanged ? StateBoard.age(item.changedAt, now: now, language: env.language) : nil
        return HStack(alignment: .firstTextBaseline, spacing: env.pt(16)) {
            Image(systemName: item.state.symbol)
                .font(.system(size: env.pt(Size.resource * 0.85), weight: .semibold))
                .foregroundStyle(color)
                .accessibilityHidden(true)
            Text(item.name ?? "—")
                .font(env.font(Size.resource))
                .foregroundStyle(env.colors.label)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Text(StateBoard.stateText(item, language: env.language))
                .font(env.font(Size.small, .semibold))
                .foregroundStyle(color)
                .fixedSize()
            if let age {
                Text(age)
                    .font(env.font(Size.small).monospacedDigit())
                    .foregroundStyle(env.colors.muted)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [StateBoard.accessibilityText(item, language: env.language), age].compactMap { $0 }.joined(separator: ", "))
    }
}
