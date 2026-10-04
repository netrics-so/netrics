import Foundation
import Testing

@testable import NetricsKit

private func slides(_ pairs: (String, Int)...) -> [SlideRotation.Slide] {
    pairs.map { SlideRotation.Slide(id: $0.0, durationSec: $0.1) }
}

private func at(_ seconds: TimeInterval) -> Date { T0.addingTimeInterval(seconds) }

@Suite struct SlideRotationTests {
    @Test func advancesByEachSlidesDuration() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10), ("c", 5)), autoAdvance: true, now: T0)
        #expect(rotation.currentID == "a")
        #expect(rotation.nextChange() == at(20))
        let changed1 = rotation.advance(to: at(19.9))
        #expect(!changed1)
        let changed2 = rotation.advance(to: at(20))
        #expect(changed2)
        #expect(rotation.currentID == "b")
        #expect(rotation.nextChange() == at(30))
        rotation.advance(to: at(30))
        #expect(rotation.currentID == "c")
        // After the last, the first.
        rotation.advance(to: at(35))
        #expect(rotation.currentID == "a")
        #expect(rotation.nextChange() == at(55))
    }

    @Test func aScreenThatSleptSkipsAheadAsIfItHadRotated() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10)), autoAdvance: true, now: T0)
        // 1000 s = 33 laps of 30 s (990 s), then 10 s into "a".
        let changed3 = rotation.advance(to: at(1000))
        #expect(!changed3)
        #expect(rotation.currentID == "a")
        #expect(rotation.nextChange() == at(1010))
        rotation.advance(to: at(1015))
        #expect(rotation.currentID == "b")
        #expect(rotation.nextChange() == at(1020))
    }

    @Test func aShorterDurationOfTheSlideOnScreenAppliesAtOnce() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10)), autoAdvance: true, now: T0)
        // 2 s in, "a" becomes 5 s long: due at 5 s, not 20 s.
        rotation.update(slides: slides(("a", 5), ("b", 10)), autoAdvance: true, now: at(2))
        #expect(rotation.currentID == "a")
        #expect(rotation.nextChange() == at(5))
        rotation.advance(to: at(5))
        #expect(rotation.currentID == "b")
        #expect(rotation.nextChange() == at(15))
    }

    @Test func aShorterDurationAlreadyOverMovesOnNowWithoutSkipping() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10)), autoAdvance: true, now: T0)
        // 15 s in, "a" becomes 5 s long: due now; "b" then gets its 10 s.
        rotation.update(slides: slides(("a", 5), ("b", 10)), autoAdvance: true, now: at(15))
        #expect(rotation.nextChange() == at(15))
        let changed = rotation.advance(to: at(15))
        #expect(changed)
        #expect(rotation.currentID == "b")
        #expect(rotation.nextChange() == at(25))
    }

    @Test func aShorterDurationWhilePausedAppliesOnResume() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10)), autoAdvance: true, now: T0)
        rotation.togglePause(now: at(15))
        rotation.update(slides: slides(("a", 5), ("b", 10)), autoAdvance: true, now: at(30))
        #expect(rotation.nextChange() == nil)
        rotation.togglePause(now: at(40))
        #expect(rotation.nextChange() == at(40))
        rotation.advance(to: at(40))
        #expect(rotation.currentID == "b")
    }

    @Test func aLongerDurationKeepsTheSlideLonger() {
        var rotation = SlideRotation(slides: slides(("a", 10), ("b", 10)), autoAdvance: true, now: T0)
        rotation.update(slides: slides(("a", 30), ("b", 10)), autoAdvance: true, now: at(6))
        #expect(rotation.nextChange() == at(30))
    }

    @Test func oneSlideOrNoAutoAdvanceNeverChanges() {
        var one = SlideRotation(slides: slides(("a", 5)), autoAdvance: true, now: T0)
        #expect(one.nextChange() == nil)
        let changed4 = one.advance(to: at(60))
        #expect(!changed4)
        one.next(now: at(1))
        #expect(one.currentID == "a")

        var off = SlideRotation(slides: slides(("a", 5), ("b", 5)), autoAdvance: false, now: T0)
        #expect(!off.rotates)
        let changed5 = off.advance(to: at(60))
        #expect(!changed5)
        off.next(now: at(1))
        off.togglePause(now: at(1))
        #expect(off.currentID == "a")
        #expect(!off.isPaused)

        let none = SlideRotation(slides: [], autoAdvance: true, now: T0)
        #expect(none.currentID == nil)
        #expect(none.nextChange() == nil)
    }

    @Test func theRemoteMovesAndRestartsTheTime() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10), ("c", 5)), autoAdvance: true, now: T0)
        rotation.previous(now: at(3))
        #expect(rotation.currentID == "c")
        #expect(rotation.nextChange() == at(8))
        rotation.next(now: at(4))
        #expect(rotation.currentID == "a")
        rotation.next(now: at(5))
        #expect(rotation.currentID == "b")
        #expect(rotation.nextChange() == at(15))
    }

    @Test func pauseHoldsTheSlideAndResumesWithTheTimeLeft() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10)), autoAdvance: true, now: T0)
        rotation.togglePause(now: at(15))
        #expect(rotation.isPaused)
        #expect(rotation.nextChange() == nil)
        let changed6 = rotation.advance(to: at(100))
        #expect(!changed6)
        #expect(rotation.currentID == "a")
        rotation.togglePause(now: at(100))
        #expect(!rotation.isPaused)
        // 5 s were left when it paused.
        #expect(rotation.nextChange() == at(105))
        // Moving while paused stays paused.
        rotation.togglePause(now: at(101))
        rotation.next(now: at(102))
        #expect(rotation.currentID == "b")
        #expect(rotation.isPaused)
    }

    @Test func aNewPayloadKeepsTheCurrentSlideWhenItIsStillThere() {
        var rotation = SlideRotation(slides: slides(("a", 20), ("b", 10), ("c", 5)), autoAdvance: true, now: T0)
        rotation.advance(to: at(25))
        #expect(rotation.currentID == "b")
        // "b" moved to the front and got longer: same slide, same start.
        rotation.update(slides: slides(("b", 30), ("c", 5)), autoAdvance: true, now: at(26))
        #expect(rotation.currentID == "b")
        #expect(rotation.index == 0)
        #expect(rotation.nextChange() == at(50))
        // "b" is gone: the first slide, from now.
        rotation.update(slides: slides(("x", 10), ("c", 5)), autoAdvance: true, now: at(27))
        #expect(rotation.currentID == "x")
        #expect(rotation.nextChange() == at(37))
        // Auto-advance switched off: only the first slide.
        rotation.next(now: at(28))
        rotation.update(slides: slides(("x", 10), ("c", 5)), autoAdvance: false, now: at(29))
        #expect(rotation.currentID == "x")
        #expect(rotation.nextChange() == nil)
    }

    @Test func readsThePayload() {
        let rotation = SlideRotation(v2Payload(), now: T0)
        #expect(rotation.slides == slides((slideA, 20), (slideB, 10)))
        #expect(rotation.rotates)
    }
}

@Suite struct StudioRenderTests {
    @Test func labelsShrinkBeforeTheyTruncate() {
        // Fits at its size.
        let short = StudioRender.fitLabel("Downloads", maxWidth: 400, size: 40, floor: 30)
        #expect(short == StudioRender.FittedLabel(text: "Downloads", size: 40, lines: 1, truncated: false))
        // Shrinks to stay within two lines.
        let text = "Average session duration per user"
        let shrunk = StudioRender.fitLabel(text, maxWidth: 360, size: 40, floor: 30)
        #expect(shrunk.size < 40)
        #expect(shrunk.size >= 30)
        #expect(shrunk.lines <= 2)
        #expect(!shrunk.truncated)
        // Only at the minimum and still too long: the flagged last resort.
        let long = String(repeating: "Wurfel Puzzle Adventures ", count: 6)
        let cut = StudioRender.fitLabel(long, maxWidth: 300, size: 40, floor: 30)
        #expect(cut.size == 30)
        #expect(cut.lines == 2)
        #expect(cut.truncated)
    }

    @Test func longTitleFixturesFitTheirWidgetsWithoutTruncation() {
        // The long-title fixtures of the studio (app names as the stores
        // write them) on the widget sizes the templates use, at 1080p; 4K
        // is the same layout in units.
        let labels = [
            "Downloads · Wurfel – The Daily Dice Puzzle",
            "Proceeds · Paperstand: Magazines & Newspapers",
            "Average rating · Voila – Visual Shopping List",
            "Search clicks · netrics.so (all pages, all countries)",
        ]
        for label in labels {
            for (w, h) in [(4, 3), (6, 4), (8, 4)] {
                let placement = StudioPlacement(x: 0, y: 0, w: w, h: h)
                let box = StudioRender.contentBox(placement, showHeader: true)
                let sizes = StudioLayout.typeScale(.metric, placement: placement, fontScale: 1)
                let layout = StudioRender.labelLayout(label, width: box.width, sizes: sizes)
                #expect(!layout.title.truncated, "\(label) \(w)×\(h)")
                #expect(layout.resource?.truncated != true, "\(label) \(w)×\(h)")
                #expect(StudioLayout.fits(label, type: .metric, w: w, h: h))
            }
        }
    }

    @Test func valuesGoCompactInsteadOfBeingCut() {
        let wide = StudioRender.fitValue("1,234,567,890", compact: "1.2B", maxWidth: 200, min: 64, max: 120)
        #expect(wide.text == "1.2B")
        #expect(wide.size >= 64)
        let fits = StudioRender.fitValue("42", compact: "42", maxWidth: 800, min: 64, max: 120)
        #expect(fits == StudioRender.FittedValue(text: "42", size: 120))
    }

    @Test func metricLayoutDropsExtrasByImportance() {
        let small = StudioRender.metricLayout(
            label: "Downloads · Wurfel", value: ("1,284", "1.3K"), periodText: "Last 7 days · Total",
            change: ("▲ +28% vs previous 7 days", "▲ +28%", "vs previous 7 days"), notice: nil, note: nil,
            placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), showHeader: true, fontScale: 1, showSparkline: true)
        let large = StudioRender.metricLayout(
            label: "Downloads · Wurfel", value: ("1,284", "1.3K"), periodText: "Last 7 days · Total",
            change: ("▲ +28% vs previous 7 days", "▲ +28%", "vs previous 7 days"), notice: nil, note: nil,
            placement: StudioPlacement(x: 0, y: 0, w: 6, h: 5), showHeader: true, fontScale: 1, showSparkline: true)
        #expect(small.value.size >= StudioLayout.Minimum.value)
        #expect(large.value.size > small.value.size)
        #expect(large.sparkline >= StudioRender.minSparklineHeight)
        #expect(large.changeText == "▲ +28% vs previous 7 days")
        #expect(large.showPeriod)
        #expect(small.sparkline == 0)
    }

    @Test func metricLayoutKeepsTheComparisonOnItsOwnLineWhenTheChangeWouldWrap() {
        // The Apple TV case (#245): a 3 × 4 metric widget.
        func layout(w: Int, h: Int, fontScale: Double) -> StudioRender.MetricLayout {
            StudioRender.metricLayout(
                label: "Downloads · All apps", value: ("718", "718"), periodText: "Last 30 days · Total",
                change: ("▼ −28% vs previous 30 days", "▼ −28%", "vs previous 30 days"), notice: nil, note: nil,
                placement: StudioPlacement(x: 0, y: 0, w: w, h: h), showHeader: true, fontScale: fontScale,
                showSparkline: true)
        }
        for fontScale in [1, 1.15, 1.3] {
            let narrow = layout(w: 3, h: 4, fontScale: fontScale)
            #expect(narrow.changeText == "▼ −28%")
            #expect(narrow.comparisonText == "vs previous 30 days")
            #expect(narrow.comparison >= StudioLayout.Minimum.any)
            #expect(narrow.showPeriod)
        }
        let wide = layout(w: 4, h: 4, fontScale: 1)
        #expect(wide.changeText == "▼ −28% vs previous 30 days")
        #expect(wide.comparisonText == nil)
        let short = layout(w: 3, h: 2, fontScale: 1)
        #expect(short.changeText == "▼ −28%")
        #expect(short.comparisonText == nil)
        let none = StudioRender.metricLayout(
            label: "Downloads · All apps", value: ("718", "718"), periodText: "Last 30 days · Total",
            change: ("No data to compare vs the same period of the previous year", "No comparison", nil), notice: nil,
            note: nil, placement: StudioPlacement(x: 0, y: 0, w: 3, h: 4), showHeader: true, fontScale: 1,
            showSparkline: true)
        #expect(none.changeText == "No comparison")
        #expect(none.comparisonText == nil)
    }

    @Test func barsFoldIntoOthersRatherThanShrinkingBelowTheMinimum() {
        let bars = (1...10).map { BarEntry(label: "Country \($0)", value: Double(100 - $0)) }
        let tall = StudioRender.barLayout(
            bars: Array(bars.prefix(3)), others: BarOthers(label: "Others", value: 5), width: 600, height: 600, size: 30,
            format: { StudioLayout.compactNumber($0) })
        #expect(tall.size == 30)
        #expect(tall.rows.map(\.label.text) == ["Country 1", "Country 2", "Country 3", "Others"])
        #expect(tall.rows[0].ratio == 1)
        #expect(tall.folded == 0)

        let short = StudioRender.barLayout(
            bars: bars, others: nil, width: 600, height: 200, size: 30, format: { StudioLayout.compactNumber($0) })
        #expect(short.size == StudioLayout.Minimum.any)
        #expect(short.folded > 0)
        #expect(short.rows.last?.others == true)
        #expect(short.rows.last?.label.text == "Others")
        // Nothing is lost: the folded groups add up in "Others".
        let total = bars.map(\.value).reduce(0, +)
        #expect(short.rows.map(\.value).reduce(0, +) == total)
    }

    @Test func textStepsDownToFit() {
        let placement = StudioPlacement(x: 0, y: 0, w: 4, h: 2)
        let layout = StudioRender.textLayout(
            "# A long heading that will wrap\nAnd a paragraph with **bold** words and more words",
            size: .display, placement: placement, fontScale: 1, showHeader: true)
        #expect(layout.size != .display)
        #expect(layout.paragraph >= StudioLayout.Minimum.body)
        let fits = StudioRender.textLayout("Hi", size: .display, placement: placement, fontScale: 1, showHeader: true)
        #expect(fits.size == .display)
        #expect(!fits.overflow)
        // HTML stays literal text.
        let html = StudioRender.textLayout("<b>x</b>", size: .body, placement: placement, fontScale: 1, showHeader: true)
        #expect(html.blocks == [.paragraph(lines: [[StudioTextSpan(text: "<b>x</b>", bold: false, italic: false)]])])
    }

    @Test func clockIsAtLeastItsMinimum() {
        let small = StudioRender.clockLayout(
            time: "14:05", options: ClockWidgetOptions(), timeZone: "UTC",
            placement: StudioPlacement(x: 0, y: 0, w: 2, h: 1), fontScale: 1, showHeader: true)
        #expect(small.time == StudioLayout.Minimum.clock)
        #expect(small.date == nil)
        #expect(small.hidden)
        let large = StudioRender.clockLayout(
            time: "14:05", options: ClockWidgetOptions(), timeZone: "UTC",
            placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), fontScale: 1, showHeader: true)
        #expect(large.time > small.time)
        #expect(large.date == StudioLayout.Minimum.title)
        #expect(large.zone == nil)
        #expect(!large.hidden)
    }

    @Test func clockWithLongDateAndZone() {
        let options = ClockWidgetOptions(dateStyle: .long, showZone: true)
        let threeByThree = StudioRender.clockLayout(
            time: "14:05", options: options, timeZone: "Europe/Berlin",
            placement: StudioPlacement(x: 0, y: 0, w: 3, h: 3), fontScale: 1, showHeader: true)
        #expect(threeByThree.zone == StudioLayout.Minimum.zone)
        #expect(threeByThree.date != nil)
        #expect(!threeByThree.hidden)
        let twoByOne = StudioRender.clockLayout(
            time: "14:05", options: options, timeZone: "Europe/Berlin",
            placement: StudioPlacement(x: 0, y: 0, w: 2, h: 1), fontScale: 1, showHeader: true)
        #expect(twoByOne.date == nil && twoByOne.zone == nil && twoByOne.hidden)
    }

    @Test func lineDomainStartsAtZero() {
        #expect(StudioRender.lineDomain(values: [5, 10], previous: [20]) == 0...20)
        #expect(StudioRender.lineDomain(values: [-5, 10], previous: []) == -5...10)
        #expect(StudioRender.lineDomain(values: [0, 0], previous: []) == 0...1)
        #expect(StudioRender.lineDomain(values: [5], previous: []) == nil)
        #expect(StudioRender.lineDomain(values: [nil, nil], previous: [1, 2]) == nil)
    }
}

@Suite struct WidgetFormattingTests {
    @Test func compactValues() {
        #expect(MetricFormat.compactValue(1284, unit: "count") == "1.3K")
        #expect(MetricFormat.compactValue(950, unit: "count") == "950")
        #expect(MetricFormat.compactValue(nil, unit: "count") == "—")
        #expect(MetricFormat.compactValue(123_456_789, unit: "EUR_minor") == "€1.2M")
        #expect(MetricFormat.compactValue(42.3, unit: "percent") == "42.3%")
    }

    @Test func changeTone() {
        #expect(MetricFormat.tone(.up, better: .higher) == .up)
        #expect(MetricFormat.tone(.up, better: .lower) == .down)
        #expect(MetricFormat.tone(.down, better: .lower) == .up)
        #expect(MetricFormat.tone(.flat, better: .lower) == .flat)
    }

    @Test func bucketLabels() {
        #expect(MetricFormat.bucketLabel("2026-09-28T00:00:00.000Z", period: .last7Days, timeZone: "Europe/Berlin") == "Sep 28")
        #expect(
            MetricFormat.bucketLabel("2026-09-28T00:00:00.000Z", period: .last90Days, timeZone: "Europe/Berlin")
                == "Week of Sep 28")
        #expect(MetricFormat.bucketLabel("2026-09-01T00:00:00.000Z", period: .last12Months, timeZone: "UTC") == "Sep 2026")
        #expect(MetricFormat.bucketLabel("2026-09-28T12:00:00.000Z", period: .today, timeZone: "Europe/Berlin") == "14:00")
        #expect(MetricFormat.bucketLabel("garbage", period: .today, timeZone: "UTC") == nil)
        // Periods to date step by days, weeks and months (SERIES_UNITS).
        #expect(MetricFormat.seriesStep(.thisWeek) == .day)
        #expect(MetricFormat.seriesStep(.thisQuarter) == .week)
        #expect(MetricFormat.seriesStep(.thisYear) == .month)
        #expect(MetricFormat.bucketLabel("2026-09-29T00:00:00.000Z", period: .thisWeek, timeZone: "Europe/Berlin") == "Sep 29")
        #expect(
            MetricFormat.bucketLabel("2026-10-01T00:00:00.000Z", period: .thisQuarter, timeZone: "Europe/Berlin")
                == "Week of Oct 1")
        #expect(
            MetricFormat.bucketLabel("2026-10-04T22:00:00.000Z", period: .thisQuarter, timeZone: "Europe/Berlin")
                == "Week of Oct 5")
        #expect(MetricFormat.bucketLabel("2026-03-01T00:00:00.000Z", period: .thisYear, timeZone: "UTC") == "Mar 2026")
    }

    @Test func clockWidgetText() {
        let date = ISODate.parse("2026-10-04T12:05:00.000Z")!
        let berlin = TVTime.clockWidget(date, timeZone: "Europe/Berlin", hour12: false, showDate: true)
        #expect(berlin.time == "14:05")
        #expect(berlin.date == "Sun 4 Oct")
        let ny = TVTime.clockWidget(date, timeZone: "America/New_York", hour12: true, showDate: false)
        #expect(ny.time == "8:05 AM")
        #expect(ny.date == nil)
        #expect(ny.zone == nil)
        let summer = ISODate.parse("2026-10-03T12:00:00.000Z")!
        let long = TVTime.clockWidget(
            summer, timeZone: "Europe/Berlin", hour12: false, showDate: true, dateStyle: .long, showZone: true)
        #expect(long.date == "Saturday, 3 October")
        #expect(long.zone == "Berlin \u{00B7} UTC+2")
        let german = TVTime.clockWidget(
            summer, timeZone: "Europe/Berlin", hour12: false, showDate: true, dateStyle: .long, language: .de)
        #expect(german.date == "Samstag, 3. Oktober")
        let winter = TVTime.clockWidget(
            ISODate.parse("2026-12-04T12:00:00.000Z")!, timeZone: "Europe/Berlin", hour12: false, showDate: false,
            showZone: true)
        #expect(winter.zone == "Berlin \u{00B7} UTC+1")
    }

    @Test func datesStayWithinTheLayoutSample() {
        let start = ISODate.parse("2026-01-01T12:00:00.000Z")!
        for style in [ClockDateStyle.short, .long] {
            let sample = StudioLayout.estimateTextWidth(StudioLayout.clockDateSample(style), fontSize: 1)
            for language in [ScreenLanguage.en, .de] {
                for day in 0..<366 {
                    let date = start.addingTimeInterval(Double(day) * 86_400)
                    let text = TVTime.clockWidget(
                        date, timeZone: "UTC", hour12: false, showDate: true, dateStyle: style, language: language
                    ).date!
                    #expect(StudioLayout.estimateTextWidth(text, fontSize: 1) <= sample, "\(text)")
                }
            }
        }
    }

    @Test func themeColours() {
        #expect(ThemeColor.parse("#ff0080") == ThemeColor(red: 1, green: 0, blue: 128.0 / 255))
        #expect(ThemeColor.parse("ff0080") != nil)
        #expect(ThemeColor.parse("#ff008") == nil)
        #expect(ThemeColor.parse("#gg0080") == nil)
    }
}
