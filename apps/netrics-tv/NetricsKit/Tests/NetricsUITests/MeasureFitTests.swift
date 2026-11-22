#if canImport(AppKit)
    import AppKit
    import Foundation
    @testable import NetricsKit
    import SwiftUI
    import Testing

    @testable import NetricsUI

    /// A fitted measure table as netrics TV draws it (#768): the rows the fit
    /// chooses fit the tile with the footer lines, and one more row would
    /// not (within the fit's pixel of rounding room per row), in English and
    /// German, on 1080p and 4K screens and at the sizes of iPad and iPhone
    /// (#780), at every theme font scale.
    @MainActor @Suite struct MeasureFitDrawnHeightTests {
        private static func data(_ language: ScreenLanguage) throws -> MeasureWidgetData {
            let apps = ["Focus", "Notes", "Habit Tracker", "Budget", "Weather Now", "Sleep Sounds", "Recipes", "Flashcards"]
            let rows = (0..<20).map { n in
                #"{"dimensions":{"app":"\#(apps[n % apps.count]) \#(n / apps.count + 1)","store":"\#(n % 2 == 0 ? "App Store" : "Google Play")"},"measures":{"downloads":{"value":\#(1000 - n * 10),"type":"integer","status":"ok"}}}"#
            }
            let names =
                language == .de
                ? (app: "App", store: "Store", downloads: "Downloads und Nutzerinstallationen")
                : (app: "App", store: "Store", downloads: "Downloads and user installs")
            let json =
                #"{"metadata":{"modelId":"m","modelName":"Downloads","measures":[{"id":"downloads","name":"\#(names.downloads)"}],"dimensions":[{"id":"app","name":"\#(names.app)"},{"id":"store","name":"\#(names.store)"}]},"result":{"rows":["#
                + rows.joined(separator: ",")
                + #"],"totalRows":40,"receivedAt":"2026-11-18T08:00:00Z","warnings":[],"provenance":[],"stale":false},"exclusions":[]}"#
            return try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        }

        /// A row's cells as the tile shows them.
        private static func cells(_ row: MeasureResultRow, language: ScreenLanguage, data: MeasureWidgetData)
            -> [String]
        {
            ["app", "store"].map { data.dimensionText(row, dimension: $0, language: language) }
                + [data.text(row.measures["downloads"], measure: "downloads", language: language)]
        }

        /// The tile's content height when it draws `rows` rows (nil: fitted).
        private static func drawnHeight(
            data: MeasureWidgetData, env: WidgetEnv, placement: ScreenPlacement, width: CGFloat, rows: Int?,
            labels: [String: String]?
        ) -> CGFloat {
            var view = MeasureWidgetView(
                label: "Downloads", measureIds: ["downloads"], groupBy: ["app", "store"],
                options: MeasureWidgetOptions(view: "table", limit: 20, labels: labels), data: data, env: env,
                placement: placement, now: Date(timeIntervalSince1970: 1_795_000_000))
            view.rowsDrawn = rows
            // Laid out to the screen's pixels, as on the device.
            let host = NSHostingController(
                rootView: view.frame(width: width).environment(\.displayScale, env.displayScale))
            return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        }

        /// The screens it is drawn on: points per unit and pixels per point.
        /// A TV's unit is a point; an iPad's or iPhone's is less (#780), so
        /// its text is below 24 pt, where the system font is wider.
        private static let screens: [(name: String, u: Double, displayScale: Double)] = [
            ("1080p", 1, 1), ("4K", 1, 2),
            ("iPad 13", 0.7115, 2), ("iPad 11", 0.622, 2), ("iPad split", 0.36, 2),
            ("iPhone", 0.455, 3), ("iPhone small", 0.3474, 2),
        ]
        private static let now = Date(timeIntervalSince1970: 1_795_000_000)

        @Test(arguments: [ScreenLanguage.en, .de])
        func fittedRowsFitAndOneMoreWouldNot(language: ScreenLanguage) throws {
            let data = try Self.data(language)
            for (screen, u, displayScale) in Self.screens {
                for fontScale in [1.0, 1.15, 1.3] {
                    var tokens = ThemeTokens.netricsDark
                    tokens.fontScale = fontScale
                    var env = WidgetEnv(
                        u: CGFloat(u), colors: StudioColors(tokens), showHeader: true, timeZone: "UTC",
                        displayScale: CGFloat(displayScale))
                    env.language = language
                    for (cells, labels) in [
                        (StudioPlacement(x: 0, y: 0, w: 4, h: 4), nil as [String: String]?),
                        (StudioPlacement(x: 0, y: 0, w: 4, h: 4), ["downloads": "Downloads"]),
                        (StudioPlacement(x: 0, y: 0, w: 6, h: 8), ["downloads": "Downloads"]),
                    ] {
                        let placement = ScreenPlacement(cells: cells)
                        let box = StudioRender.contentBox(cells, showHeader: true)
                        let pixel = 1 / (u * displayScale)
                        let fit = data.tableFit(
                            label: "Downloads", measureIds: ["downloads"], groupBy: ["app", "store"],
                            rows: data.result!.rows, box: box, fontScale: fontScale, labels: labels,
                            pixel: pixel, points: u, now: Self.now, language: language)
                        let context = "\(language) \(screen) ×\(fontScale) \(cells) \(fit.shown) rows"
                        // The tile's drawn height in units.
                        let height = { (rows: Int?) in
                            Double(
                                Self.drawnHeight(
                                    data: data, env: env, placement: placement, width: CGFloat(box.width * u),
                                    rows: rows, labels: labels)) / u
                        }
                        // Drawn as fitted, the tile holds its rows and footer.
                        #expect(height(nil) <= box.height + 0.5 / u, "\(context): \(height(nil)) > \(box.height)")
                        // One more row would not fit, but for the rounding room (a pixel per line);
                        // or the fit counted a row or a footer line a line taller
                        // than drawn because its text is within 3 % of the
                        // width it has (the widths are the widest of the sizes
                        // a table covers, plus 0.5 %, and kerning narrows a text).
                        let more = height(fit.shown + 1)
                        // A pixel per drawn line at most (the fit's rounding room).
                        let room = more / (28 * fontScale * 1.15) * pixel
                        if more <= box.height - room {
                            let cell = 28 * fontScale
                            // The columns' widths as the fit set them (#780), less the padding.
                            let columns = (fit.columnWidths ?? Array(repeating: box.width / 3, count: 3)).map { $0 - 20 }
                            let next = Self.cells(data.result!.rows[fit.shown], language: language, data: data)
                            let width = { (text: String) in
                                StudioLayout.measureTextWidth(text, fontSize: cell, weight: .regular, font: .tv, points: u)
                            }
                            // Any row up to that one: a line counted and not
                            // drawn is room the next row then takes.
                            let borderline = data.result!.rows.prefix(fit.shown + 1).contains { row in
                                zip(Self.cells(row, language: language, data: data), columns).contains {
                                    text, column in width(text) > column - pixel && width(text) <= column * 1.03
                                }
                            }
                            // Or a footer line counted on two lines and drawn on one.
                            let footer = data.footer(
                                rows: data.result!.rows, width: box.width, fontScale: fontScale, points: u,
                                now: Self.now, language: language)
                            let footerBorderline = footer.compactMap { $0 }.contains {
                                let width = StudioLayout.measureTextWidth(
                                    $0, fontSize: 24 * fontScale, weight: .regular, font: .tv, points: u)
                                return width > box.width && width <= box.width * 1.03
                            }
                            #expect(
                                borderline || footerBorderline,
                                "\(context): one more row takes \(more) of \(box.height) (\(next))")
                        }
                    }
                }
            }
        }

        /// What #780 reported: counted with a TV's widths, a table on an
        /// iPad or iPhone can be drawn taller than its tile (a cell wraps
        /// that the fit counted on one line), so the footer is cut.
        @Test func countedAsOnATVTheTileOverflowsOnTouchScreens() throws {
            let data = try Self.data(.en)
            var overflows: [String] = []
            for (screen, u, displayScale) in Self.screens where u < 1 {
                for fontScale in [1.0, 1.15, 1.3] {
                    var tokens = ThemeTokens.netricsDark
                    tokens.fontScale = fontScale
                    let env = WidgetEnv(
                        u: CGFloat(u), colors: StudioColors(tokens), showHeader: true, timeZone: "UTC",
                        displayScale: CGFloat(displayScale))
                    for w in [3, 4, 5, 6] {
                        let cells = StudioPlacement(x: 0, y: 0, w: w, h: 8)
                        let box = StudioRender.contentBox(cells, showHeader: true)
                        let labels = ["downloads": "Downloads"]
                        // As before #780: the TV's widths at every size.
                        let fit = data.tableFit(
                            label: "Downloads", measureIds: ["downloads"], groupBy: ["app", "store"],
                            rows: data.result!.rows, box: box, fontScale: fontScale, labels: labels,
                            pixel: 1 / (u * displayScale), points: nil, now: Self.now, language: .en)
                        let drawn =
                            Double(
                                Self.drawnHeight(
                                    data: data, env: env, placement: ScreenPlacement(cells: cells),
                                    width: CGFloat(box.width * u), rows: fit.shown, labels: labels)) / u
                        if drawn > box.height + 0.5 / u { overflows.append("\(screen) ×\(fontScale) w\(w)") }
                    }
                }
            }
            #expect(!overflows.isEmpty)
        }
    }
#endif
