import AppKit
import Foundation
import NetricsKit
import SwiftUI
import Testing

@testable import NetricsUI

// The state widget as netrics TV, iPad and iPhone draw it (#875): a list
// with problems first that never hides a problem behind "+N more", and one
// item at a readable size, in every screen format; each drawn inside its
// box.

@MainActor @Suite struct StateWidgetViewTests {
    private static let now = Date(timeIntervalSince1970: 1_795_000_000)

    private static func data(_ count: Int, total: Int? = nil) -> StateWidgetData {
        let states: [ServiceState] = [.down, .failed, .building]
        return StateWidgetData(
            items: (0..<count).map { index in
                StateWidgetItem(
                    name: "service-\(index)", state: index < states.count ? states[index] : .up,
                    rolledBack: index == 3, changedAt: "2026-11-21T0\(index % 10):00:00.000Z")
            }, total: total)
    }

    private static func env(u: Double = 1, fontScale: Double = 1, language: ScreenLanguage = .en) -> WidgetEnv {
        var tokens = ThemeTokens.netricsDark
        tokens.fontScale = fontScale
        var env = WidgetEnv(
            u: CGFloat(u), colors: StudioColors(tokens), showHeader: true, timeZone: "UTC", displayScale: 2)
        env.language = language
        return env
    }

    /** The minimum size and a larger one in every format's grid. */
    private static let cases: [(ScreenFormat, StudioPlacement)] = ScreenFormat.allCases.flatMap { format in
        [StudioPlacement(x: 0, y: 0, w: 3, h: 2), StudioPlacement(x: 0, y: 0, w: 4, h: 4)].map { (format, $0) }
    }

    @Test func listNeverHidesAProblemAndCountsTheRest() {
        for (format, cells) in Self.cases {
            for fontScale in [1.0, 1.3] {
                let placement = ScreenPlacement(cells: cells, format: format)
                let data = Self.data(8, total: 12)
                let plan = StateWidgetView.listPlan(
                    label: "Services", placement: placement, options: StateWidgetOptions(), data: data,
                    fontScale: fontScale, showHeader: true)
                let context = "\(format) \(cells) ×\(fontScale)"
                #expect(plan.capacity >= 1, "\(context)")
                #expect(plan.rows + (plan.more > 0 ? 1 : 0) <= plan.capacity, "\(context)")
                #expect(plan.rows + plan.more == 12, "\(context)")
                // The shown rows are the first, the most urgent.
                if plan.rows > 0 { #expect(data.items[0].state == .down) }
            }
        }
    }

    @Test func singleFormKeepsTheWordReadableAndDropsLinesFirst() {
        let sizes = StudioLayout.typeScale(
            .state, placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), fontScale: 1, showHeader: true)
        let cell = StudioLayout.Minimum.cell
        let tight = StateWidgetView.singlePlan(height: 60, sizes: sizes, hasName: true, hasQualifier: true)
        #expect(tight.word >= cell)
        #expect(!tight.showQualifier)
        let roomy = StateWidgetView.singlePlan(height: 400, sizes: sizes, hasName: true, hasQualifier: true)
        #expect(roomy.showName && roomy.showQualifier)
        #expect(roomy.word > tight.word && roomy.word <= 160)
    }

    @Test func compactSingleTileKeepsTheRollback() {
        let sizes = StudioLayout.typeScale(
            .state, placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), fontScale: 1, showHeader: true)
        let item = StateWidgetItem(name: "site", state: .up, rolledBack: true, changedAt: "2026-11-21T08:00:00.000Z")
        let tight = StateWidgetView.singlePlan(
            height: 60, sizes: sizes, hasName: true, hasQualifier: true, rolledBack: true)
        // No room for the line: the time goes, the rollback joins the word.
        #expect(!tight.showQualifier && tight.rollbackInWord)
        #expect(StateWidgetView.singleWord(item, plan: tight, language: .en) == "Up · rolled back")
        #expect(StateWidgetView.singleWord(item, plan: tight, language: .de) == "Online · zurückgesetzt")
        let roomy = StateWidgetView.singlePlan(
            height: 400, sizes: sizes, hasName: true, hasQualifier: true, rolledBack: true)
        #expect(roomy.showQualifier && !roomy.rollbackInWord)
        #expect(StateWidgetView.singleWord(item, plan: roomy, language: .en) == "Up")
        // Without a rollback, the word stays alone.
        let plain = StateWidgetView.singlePlan(height: 60, sizes: sizes, hasName: true, hasQualifier: true)
        #expect(!plain.rollbackInWord)
    }

    @Test(arguments: [ScreenLanguage.en, .de])
    func bothFormsDrawInsideTheirBox(language: ScreenLanguage) {
        let forms = [StateWidgetOptions(), StateWidgetOptions(layout: .single)]
        for (format, cells) in Self.cases {
            for (options, fontScale) in forms.flatMap({ form in [1.0, 1.3].map { (form, $0) } }) {
                let placement = ScreenPlacement(cells: cells, format: format)
                let box = StudioRender.contentBox(cells, showHeader: true, unitBox: placement.unitBox)
                let env = Self.env(fontScale: fontScale, language: language)
                let view = StateWidgetView(
                    label: "Services", placement: placement, options: options, data: Self.data(8, total: 12), env: env,
                    now: Self.now)
                let width = CGFloat(box.width)
                // Its natural height: the spacer above the footer at zero.
                let host = NSHostingController(
                    rootView: view.fixedSize(horizontal: false, vertical: true).frame(width: width)
                        .environment(\.displayScale, 2))
                let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
                #expect(
                    size.height <= CGFloat(box.height) + 1,
                    "\(language) \(format) \(cells) \(options.layout) ×\(fontScale): \(size.height) > \(box.height)")
            }
        }
    }

    @Test func emptyDataShowsTheEmptyText() {
        let placement = ScreenPlacement(cells: StudioPlacement(x: 0, y: 0, w: 3, h: 2))
        let plan = StateWidgetView.listPlan(
            label: "Services", placement: placement, options: StateWidgetOptions(),
            data: StateWidgetData(status: .noData, items: []), fontScale: 1, showHeader: true)
        #expect(plan.rows == 0 && plan.more == 0)
        #expect(KitStrings.text(.stateEmpty, .de) == "Noch keine Einträge")
        #expect(stateLabel(nil, .en) == "Status")
        #expect(stateLabel(" Ops ", .de) == "Ops")
    }
}
