import NetricsKit
import SwiftUI

/**
 * The state widget (#875, ADR 0019 section 15), the counterpart of the
 * web's `StateWidgetView`. A list draws the status board's rows
 * (`statusLayout`): a shape per state, the name (shrunk, then cut), and
 * right-aligned the state word (with "· rolled back" on up) and the age of
 * the last change; everything not healthy first, as the server sorted it,
 * and "+N more" in the last row when items do not fit. The single form
 * draws one item: its name, the state word with its shape as large as
 * fits, and "rolled back · changed 3 hours ago". A state is always its
 * word and its shape, never colour alone.
 */
struct StateWidgetView: View {
    let label: String
    let placement: ScreenPlacement
    let options: StateWidgetOptions
    let data: StateWidgetData
    let env: WidgetEnv
    var now = Date()

    @Environment(\.enterProgress) private var progressValue

    static func color(_ tone: StatusTone, _ env: WidgetEnv) -> Color {
        switch tone {
        case .up: return env.colors.up
        case .warning: return env.colors.warning
        case .down: return env.colors.down
        case .muted: return env.colors.muted
        }
    }

    /** What a list shows: its row capacity, the items listed and "+N more". */
    struct ListPlan: Equatable {
        let capacity: Int
        let rows: Int
        let more: Int
    }

    /** The list at this placement (the status board's rows, `statusLayout`). */
    static func listPlan(
        label: String, placement: ScreenPlacement, options: StateWidgetOptions, data: StateWidgetData,
        fontScale: Double, showHeader: Bool
    ) -> ListPlan {
        let box = StudioRender.contentBox(placement.cells, showHeader: showHeader, unitBox: placement.unitBox)
        let layout = StudioLayout.statusLayout(
            label: label, width: box.width, height: box.height, fontScale: fontScale, showAge: options.showChanged)
        let fit = StateBoard.rowsShown(items: data.items.count, total: data.total, capacity: layout.rowCapacity)
        return ListPlan(capacity: layout.rowCapacity, rows: fit.rows, more: fit.more)
    }

    /** What the single form shows, in units: the word's size and which lines fit. */
    struct SinglePlan: Equatable {
        let word: Double
        let showName: Bool
        let showQualifier: Bool
        /** The qualifier line did not fit: "rolled back" joins the word ("Up · rolled back"). */
        var rollbackInWord = false
    }

    /**
     * The single form in `height` units: the state word as large as fits
     * (at least a cell, at most 160 u), with the name above and the
     * qualifier line below while they leave the word a cell; the qualifier
     * line goes first, then the name. A rollback is never dropped (#900):
     * without room for its line, it joins the word ("Up · rolled back", at
     * most as large as fits `width`) and only the time of the change is
     * lost; when even that would not fit, its line stays and the name goes.
     */
    static func singlePlan(
        height: Double, sizes: [StudioTextRole: Double], hasName: Bool, hasQualifier: Bool,
        rolledBack: Bool = false, width: Double = .infinity, folded: String = ""
    ) -> SinglePlan {
        let cell = sizes[.cell] ?? StudioLayout.Minimum.cell
        let change = sizes[.change] ?? StudioLayout.Minimum.change
        let resource = sizes[.resource] ?? StudioLayout.Minimum.resource
        // Drawn lines are a little taller than the layout's 1.15 (the system font's leading).
        let line = 1.25
        let gap = StudioRender.stackGap
        let wordLine = 1.4
        func word(_ name: Bool, _ qualifier: Bool) -> Double {
            let used = gap + (name ? resource * line + gap : 0) + (qualifier ? change * line + gap : 0)
            // The word's line with its symbol: a little taller than text alone.
            return (height - used) / wordLine
        }
        // The folded word's line ("Online · zurückgesetzt"): its icon and gap
        // (0.85 and 0.25 of the word's size) and the text beside them, so
        // the largest word size at which it fits `width`.
        let foldMax = width / (1.1 + StudioLayout.estimateTextWidth(folded, fontSize: 1, weight: .semibold))
        var name = hasName
        var qualifier = hasQualifier
        if qualifier && word(name, qualifier) < cell {
            // A rollback whose folded word would not fit keeps its own line
            // and drops the optional name instead (#900).
            if rolledBack && foldMax < cell && name && word(false, true) >= cell {
                name = false
            } else {
                qualifier = false
            }
        }
        if name && word(name, qualifier) < cell { name = false }
        let fold = rolledBack && !qualifier
        let size = max(cell, min(160, word(name, qualifier), fold ? foldMax : .infinity))
        return SinglePlan(word: size, showName: name, showQualifier: qualifier, rollbackInWord: fold)
    }

    /** The single form's word: "Up", or "Up · rolled back" when the plan folds the rollback in. */
    static func singleWord(_ item: StateWidgetItem, plan: SinglePlan, language: ScreenLanguage) -> String {
        plan.rollbackInWord ? StateBoard.stateText(item, language: language) : item.state.word(language)
    }

    var body: some View {
        let box = StudioRender.contentBox(placement.cells, showHeader: env.showHeader, unitBox: placement.unitBox)
        let sizes = StudioLayout.typeScale(
            .state, placement: placement.cells, fontScale: env.fontScale, showHeader: env.showHeader)
        let labelLayout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
        let layout = StudioLayout.statusLayout(
            label: label, width: box.width, height: box.height, fontScale: env.fontScale,
            showAge: options.showChanged)
        let footer = StateBoard.footer(
            data, now: now, language: env.language, width: box.width, size: layout.sizes.footer,
            timeZone: TimeZone(identifier: env.timeZone) ?? .current)

        VStack(alignment: .leading, spacing: 0) {
            WidgetLabelView(layout: labelLayout, env: env)
            if data.items.isEmpty {
                Text(KitStrings.text(.stateEmpty, env.language))
                    .font(env.font(layout.sizes.cell))
                    .foregroundStyle(env.colors.muted)
                    .padding(.top, env.pt(StudioLayout.StatusSpacing.rowGap))
            } else if options.single, options.item == nil,
                let text = StateBoard.summaryText(data.counts, language: env.language),
                let (state, rolledBack) = StateBoard.summaryState(data.counts)
            {
                // No item chosen: a summary of every item (owner decision on #875).
                summary(
                    text, state: state, rolledBack: rolledBack, sizes: sizes,
                    height: box.height - labelLayout.height - (footer == nil ? 0 : layout.footerHeight))
            } else if options.single, let item = data.items.first {
                single(
                    item, sizes: sizes, width: box.width,
                    height: box.height - labelLayout.height - (footer == nil ? 0 : layout.footerHeight))
            } else {
                list(layout)
            }
            Spacer(minLength: 0)
            if data.status == .stale {
                // An old "Up" never reads as current (ADR 0025 §8).
                Text("● " + KitStrings.text(.stateStale, env.language))
                    .font(env.font(layout.sizes.age))
                    .foregroundStyle(env.colors.warning)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            if let footer {
                Text(footer.text)
                    .font(env.font(layout.sizes.footer).monospacedDigit())
                    .foregroundStyle(footer.warning ? env.colors.warning : env.colors.muted)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func list(_ layout: StudioLayout.StatusLayout) -> some View {
        let fit = StateBoard.rowsShown(items: data.items.count, total: data.total, capacity: layout.rowCapacity)
        let rise = env.pt(EnterMotion.rowRise)
        // The most urgent hidden item, also one the server left out.
        let hidden = StateBoard.hiddenTone(data.counts, shown: Array(data.items.prefix(fit.rows)))
        let moreTone: StatusTone = hidden == .down ? .down : hidden == .warning ? .warning : .muted
        ForEach(Array(data.items.prefix(fit.rows).enumerated()), id: \.offset) { index, item in
            StateRowView(item: item, showChanged: options.showChanged, layout: layout, env: env, now: now)
                .modifier(RowRise(progress: progressValue, index: index, rise: rise))
        }
        if fit.more > 0 {
            StatusRowView(
                name: KitStrings.text(.statusMore, env.language, fit.more), tone: moreTone, age: nil, stale: false,
                layout: layout, env: env, more: true
            )
            .modifier(RowRise(progress: progressValue, index: fit.rows, rise: rise))
        }
    }

    private func summary(
        _ text: String, state: ServiceState, rolledBack: Bool, sizes: [StudioTextRole: Double], height: Double
    ) -> some View {
        let color = Self.color(state.tone(rolledBack: rolledBack), env)
        let cell = sizes[.cell] ?? StudioLayout.Minimum.cell
        let word = Self.singlePlan(height: height, sizes: sizes, hasName: false, hasQualifier: false).word
        return HStack(alignment: .center, spacing: env.pt(word * 0.25)) {
            Image(systemName: state.symbol)
                .font(.system(size: env.pt(word * 0.85), weight: .semibold))
                .foregroundStyle(color)
                .accessibilityHidden(true)
            Text(text)
                .font(env.font(word, .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(max(0.1, cell / word))
        }
        .padding(.top, env.pt(StudioRender.stackGap))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }

    private func single(
        _ item: StateWidgetItem, sizes: [StudioTextRole: Double], width: Double, height: Double
    ) -> some View {
        let tone = item.state.tone(rolledBack: item.rolledBack)
        let color = Self.color(tone, env)
        let cell = sizes[.cell] ?? StudioLayout.Minimum.cell
        let change = sizes[.change] ?? StudioLayout.Minimum.change
        let resource = sizes[.resource] ?? StudioLayout.Minimum.resource
        let qualifier = [
            item.rolledBack ? KitStrings.text(.stateRolledBack, env.language) : nil,
            options.showChanged ? StateBoard.changed(item.changedAt, now: now, language: env.language) : nil,
        ].compactMap { $0 }.joined(separator: " · ")
        let plan = Self.singlePlan(
            height: height, sizes: sizes, hasName: item.name != nil, hasQualifier: !qualifier.isEmpty,
            rolledBack: item.rolledBack, width: width,
            folded: StateBoard.stateText(item, language: env.language))
        let word = plan.word
        return VStack(alignment: .leading, spacing: env.pt(StudioRender.stackGap)) {
            if plan.showName, let name = item.name {
                Text(name)
                    .font(env.font(resource, .semibold))
                    .foregroundStyle(env.colors.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            HStack(alignment: .center, spacing: env.pt(word * 0.25)) {
                Image(systemName: item.state.symbol)
                    .font(.system(size: env.pt(word * 0.85), weight: .semibold))
                    .foregroundStyle(color)
                    .accessibilityHidden(true)
                Text(Self.singleWord(item, plan: plan, language: env.language))
                    .font(env.font(word, .semibold))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(max(0.1, cell / word))
            }
            if plan.showQualifier {
                Text(qualifier)
                    .font(env.font(change))
                    .foregroundStyle(item.rolledBack ? env.colors.warning : env.colors.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.top, env.pt(StudioRender.stackGap))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [StateBoard.accessibilityText(item, language: env.language), qualifier.isEmpty ? nil : qualifier]
                .compactMap { $0 }.joined(separator: ", "))
    }
}

/** One item of a list: its shape, the name, the state word and the age of its last change. */
struct StateRowView: View {
    let item: StateWidgetItem
    let showChanged: Bool
    let layout: StudioLayout.StatusLayout
    let env: WidgetEnv
    var now = Date()

    var body: some View {
        let sizes = layout.sizes
        let color = StateWidgetView.color(item.state.tone(rolledBack: item.rolledBack), env)
        let name = item.name ?? "—"
        let state = StateBoard.stateText(item, language: env.language)
        let age = showChanged ? StateBoard.age(item.changedAt, now: now, language: env.language) : nil
        let stateWidth = StudioLayout.estimateTextWidth(state, fontSize: sizes.age, weight: .semibold)
        let fitted = StudioLayout.statusRowLabel(
            name, nameWidth: max(0, layout.columns.name - stateWidth - layout.columns.gap), cell: sizes.cell,
            cellMin: sizes.cellMin)
        HStack(alignment: .center, spacing: env.pt(layout.columns.gap)) {
            Image(systemName: item.state.symbol)
                .font(.system(size: env.pt(sizes.cell * 0.8), weight: .semibold))
                .foregroundStyle(color)
                .frame(width: env.pt(sizes.cell), height: env.pt(sizes.cell))
                .accessibilityHidden(true)
            Text(name)
                .font(env.font(fitted.size))
                .foregroundStyle(env.colors.label)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(state)
                .font(env.font(sizes.age, .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .fixedSize()
            if let age {
                Text(age)
                    .font(env.font(sizes.age).monospacedDigit())
                    .foregroundStyle(env.colors.muted)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .frame(height: env.pt(sizes.cell * 1.15))
        .padding(.top, env.pt(StudioLayout.StatusSpacing.rowGap))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [StateBoard.accessibilityText(item, language: env.language), age].compactMap { $0 }.joined(separator: ", "))
    }
}

/** A state widget's label: its own, else "Status". */
func stateLabel(_ label: String?, _ language: ScreenLanguage) -> String {
    let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? KitStrings.text(.stateLabel, language) : trimmed
}
