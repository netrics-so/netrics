#if canImport(AppKit)
    import AppKit
    import Foundation
    import NetricsKit
    import SwiftUI
    import Testing

    @testable import NetricsUI

    /// A fitted measure table as netrics TV draws it (#768): the rows the fit
    /// chooses fit the tile with the footer lines, and one more row would
    /// not (within the fit's pixel of rounding room per row), in English and
    /// German, on 1080p and 4K screens, at every theme font scale.
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
            let host = NSHostingController(rootView: view.frame(width: width))
            return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        }

        @Test(arguments: [ScreenLanguage.en, .de])
        func fittedRowsFitAndOneMoreWouldNot(language: ScreenLanguage) throws {
            let data = try Self.data(language)
            for (screen, displayScale) in [("1080p", 1.0), ("4K", 2.0)] {
                for fontScale in [1.0, 1.15, 1.3] {
                    var tokens = ThemeTokens.netricsDark
                    tokens.fontScale = fontScale
                    var env = WidgetEnv(
                        u: 1, colors: StudioColors(tokens), showHeader: true, timeZone: "UTC",
                        displayScale: CGFloat(displayScale))
                    env.language = language
                    for (cells, labels) in [
                        (StudioPlacement(x: 0, y: 0, w: 4, h: 4), nil as [String: String]?),
                        (StudioPlacement(x: 0, y: 0, w: 4, h: 4), ["downloads": "Downloads"]),
                        (StudioPlacement(x: 0, y: 0, w: 6, h: 8), ["downloads": "Downloads"]),
                    ] {
                        let placement = ScreenPlacement(cells: cells)
                        let box = StudioRender.contentBox(cells, showHeader: true)
                        let fit = data.tableFit(
                            label: "Downloads", measureIds: ["downloads"], groupBy: ["app", "store"],
                            rows: data.result!.rows, box: box, fontScale: fontScale, labels: labels,
                            pixel: 1 / displayScale, now: Date(timeIntervalSince1970: 1_795_000_000),
                            language: language)
                        let context = "\(language) \(screen) ×\(fontScale) \(cells) \(fit.shown) rows"
                        let height = { (rows: Int?) in
                            Self.drawnHeight(
                                data: data, env: env, placement: placement, width: CGFloat(box.width), rows: rows,
                                labels: labels)
                        }
                        // Drawn as fitted, the tile holds its rows and footer.
                        #expect(Double(height(nil)) <= box.height + 0.5, "\(context): \(height(nil)) > \(box.height)")
                        // One more row would not fit, but for the rounding room (a pixel per line);
                        // or the fit counted that row a line taller than drawn
                        // because a label's width is within 1 % of its column
                        // (the system font tracks a little wider at the
                        // smallest drawn size, which the widths cover).
                        let more = Double(height(fit.shown + 1))
                        // A pixel per drawn line at most (the fit's rounding room).
                        let room = more / (28 * fontScale * 1.15) / displayScale
                        if more <= box.height - room {
                            let cell = 28 * fontScale
                            let column = box.width / 3 - 20
                            let next = Self.cells(data.result!.rows[fit.shown], language: language, data: data)
                            let counted = next.map {
                                StudioLayout.wrappedLineCount(
                                    $0, maxWidth: column, fontSize: cell, weight: .regular,
                                    widthOf: { StudioLayout.measureTextWidth($0, fontSize: $1, weight: $2, font: .tv) })
                            }.max() ?? 1
                            let drawnLines = Int(
                                ((more - Double(height(fit.shown)) - 20) / (cell * 1.15)).rounded())
                            let borderline = next.contains {
                                let width = StudioLayout.measureTextWidth($0, fontSize: cell, weight: .regular, font: .tv)
                                return width > column && width <= column * 1.01
                            }
                            #expect(
                                drawnLines < counted && borderline,
                                "\(context): one more row takes \(more) of \(box.height) (\(next))")
                        }
                    }
                }
            }
        }
    }
#endif
