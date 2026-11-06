import Foundation
import Testing

@testable import NetricsKit

// Touch in screen view on iPad and iPhone (#414): the slideshow's commands,
// which drag is a swipe, the chrome's auto-hide, and the widget detail sheet.

private let start = Date(timeIntervalSince1970: 1_800_000_000)

private func rotation(_ ids: [String] = ["a", "b", "c"], durations: Int = 10, autoAdvance: Bool = true)
    -> SlideRotation
{
    SlideRotation(
        slides: ids.map { SlideRotation.Slide(id: $0, durationSec: durations) }, autoAdvance: autoAdvance, now: start)
}

@Suite("Slideshow commands")
struct SlideCommandTests {
    @Test func nextAndPreviousWrapAndRestartTheDuration() {
        var r = rotation()
        let later = start.addingTimeInterval(7)
        let changed1 = r.perform(.next, now: later)
        #expect(changed1)
        #expect(r.currentID == "b")
        #expect(r.shownSince == later)
        #expect(r.nextChange() == later.addingTimeInterval(10))
        let changed2 = r.perform(.previous, now: later)
        #expect(changed2)
        let changed3 = r.perform(.previous, now: later)
        #expect(changed3)
        #expect(r.currentID == "c")
        let changed4 = r.perform(.next, now: later)
        #expect(changed4)
        #expect(r.currentID == "a")
    }

    @Test func pauseHoldsThePageAndResumeKeepsItsTimeLeft() {
        var r = rotation()
        let changed5 = r.perform(.togglePause, now: start.addingTimeInterval(4))
        #expect(!changed5)
        #expect(r.isPaused)
        #expect(r.nextChange() == nil)
        let advanced = r.advance(to: start.addingTimeInterval(100))
        #expect(!advanced)
        let changed6 = r.perform(.togglePause, now: start.addingTimeInterval(20))
        #expect(!changed6)
        #expect(!r.isPaused)
        // 4 s were shown before the pause: 6 s are left after it.
        #expect(r.nextChange() == start.addingTimeInterval(26))
    }

    @Test func swipingWhilePausedStaysPausedOnTheNewPage() {
        var r = rotation()
        r.perform(.togglePause, now: start.addingTimeInterval(2))
        let changed7 = r.perform(.next, now: start.addingTimeInterval(5))
        #expect(changed7)
        #expect(r.currentID == "b")
        #expect(r.isPaused)
        r.perform(.togglePause, now: start.addingTimeInterval(9))
        #expect(r.nextChange() == start.addingTimeInterval(19))
    }

    @Test(arguments: SlideCommand.allCases)
    func nothingHappensWhenNothingRotates(_ command: SlideCommand) {
        for var r in [rotation(["only"]), rotation(autoAdvance: false)] {
            let before = r
            let changed8 = r.perform(command, now: start.addingTimeInterval(3))
            #expect(!changed8)
            #expect(r == before)
        }
    }
}

@Suite("Swipe")
struct TouchSwipeTests {
    let phone = TouchPoint(x: 852, y: 393)

    private func command(from: (Double, Double), by: (Double, Double), rtl: Bool = false) -> SlideCommand? {
        TouchSwipe.command(
            start: TouchPoint(x: from.0, y: from.1), translation: TouchPoint(x: by.0, y: by.1), size: phone,
            rightToLeft: rtl)
    }

    @Test func leftIsNextAndRightIsPrevious() {
        #expect(command(from: (500, 200), by: (-120, 10)) == .next)
        #expect(command(from: (300, 200), by: (120, -10)) == .previous)
    }

    @Test func rightToLeftMirrors() {
        #expect(command(from: (500, 200), by: (-120, 0), rtl: true) == .previous)
        #expect(command(from: (300, 200), by: (120, 0), rtl: true) == .next)
    }

    @Test func shortOrMostlyVerticalDragsAreNoSwipe() {
        #expect(command(from: (400, 200), by: (-59, 0)) == nil)
        #expect(command(from: (400, 200), by: (-60, 0)) == .next)
        #expect(command(from: (400, 200), by: (-90, 61)) == nil)
        #expect(command(from: (400, 200), by: (-90, 60)) == .next)
    }

    @Test func dragsFromTheSystemEdgesAreLeftToTheSystem() {
        // Back swipe and Slide Over at the sides, Control Centre at the top, the home indicator at the bottom.
        #expect(command(from: (10, 200), by: (200, 0)) == nil)
        #expect(command(from: (840, 200), by: (-200, 0)) == nil)
        #expect(command(from: (400, 10), by: (-200, 0)) == nil)
        #expect(command(from: (400, 370), by: (-200, 0)) == nil)
        #expect(command(from: (24, 24), by: (200, 0)) == .previous)
        #expect(command(from: (828, 353), by: (-200, 0)) == .next)
    }

    @Test func anEmptyWindowHasNoSwipe() {
        #expect(
            TouchSwipe.command(
                start: TouchPoint(x: 0, y: 0), translation: TouchPoint(x: -200, y: 0), size: TouchPoint(x: 0, y: 0))
                == nil)
    }
}

@Suite("Chrome auto-hide")
struct TouchChromeTests {
    @Test func startsHiddenAndATapShowsItForFourSeconds() {
        var chrome = TouchChrome()
        #expect(!chrome.isVisible(at: start))
        #expect(chrome.hidesAt() == nil)
        chrome.toggle(now: start)
        #expect(chrome.isVisible(at: start.addingTimeInterval(3.9)))
        #expect(!chrome.isVisible(at: start.addingTimeInterval(4)))
        #expect(chrome.hidesAt() == start.addingTimeInterval(TouchChrome.visibleFor))
    }

    @Test func aTapWhileShownHidesIt() {
        var chrome = TouchChrome()
        chrome.toggle(now: start)
        chrome.toggle(now: start.addingTimeInterval(1))
        #expect(!chrome.isVisible(at: start.addingTimeInterval(1)))
        #expect(chrome.hidesAt() == nil)
    }

    @Test func aTapAfterItHidItselfShowsItAgain() {
        var chrome = TouchChrome()
        chrome.toggle(now: start)
        chrome.toggle(now: start.addingTimeInterval(5))
        #expect(chrome.isVisible(at: start.addingTimeInterval(8)))
    }

    @Test func usingItRestartsItsTime() {
        var chrome = TouchChrome()
        chrome.show(now: start)
        chrome.show(now: start.addingTimeInterval(3))
        #expect(chrome.isVisible(at: start.addingTimeInterval(6.5)))
        #expect(chrome.hidesAt() == start.addingTimeInterval(7))
    }

    @Test func voiceOverPinsIt() {
        var chrome = TouchChrome()
        #expect(chrome.isVisible(at: start, pinned: true))
        chrome.show(now: start)
        #expect(chrome.hidesAt(pinned: true) == nil)
        #expect(chrome.isVisible(at: start.addingTimeInterval(60), pinned: true))
    }
}

@Suite("Widget details")
struct WidgetDetailTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var fiveMinutesAgo: String { ISODate.format(now.addingTimeInterval(-300)) }

    private func widget(_ content: WidgetContent, label: String? = "Revenue · Wurfel", type: String = "metric")
        -> DeviceWidget
    {
        DeviceWidget(
            id: "w1", type: type, placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3), label: label, content: content)
    }

    private func metric(status: DeviceTileStatus = .ok, updatedAt: String?, conversion: TileConversion? = nil)
        -> DeviceWidget
    {
        widget(
            .metric(
                MetricWidgetOptions(),
                MetricWidgetData(
                    period: .last7Days, aggregation: .sum, value: 12_345_678, unit: "EUR_minor",
                    change: TileChange(previousValue: 10_000_000, delta: 2_345_678, ratio: 0.2345678), spark: [],
                    status: status, updatedAt: updatedAt, conversion: conversion)))
    }

    @Test func aMetricInEnglish() throws {
        let detail = try #require(WidgetDetail.make(metric(updatedAt: fiveMinutesAgo), now: now))
        #expect(detail.title == "Revenue")
        #expect(detail.subtitle == "Wurfel")
        #expect(detail.text(.value) == "€123,456.78")
        #expect(detail.text(.period) == "Last 7 days · Total")
        #expect(detail.text(.comparison) == "▲ +23% vs previous 7 days")
        #expect(detail.text(.previous) == "€100,000")
        #expect(detail.text(.source) == "Connected")
        #expect(detail.text(.updated) == "5 minutes ago")
        #expect(detail.text(.conversion) == nil)
    }

    @Test func aMetricInGerman() throws {
        let detail = try #require(WidgetDetail.make(metric(updatedAt: fiveMinutesAgo), now: now, language: .de))
        #expect(detail.text(.period) == "Letzte 7 Tage · Summe")
        #expect(detail.text(.value) == "123.456,78\u{00A0}€")
        #expect(detail.text(.source) == "Verbunden")
        #expect(detail.text(.updated) == "vor 5 Minuten")
    }

    @Test func theSourceSaysWhatTheConnectionNeeds() throws {
        let failed = try #require(WidgetDetail.make(metric(status: .authFailed, updatedAt: nil), now: now))
        #expect(failed.text(.source) == "Connection needs new credentials")
        #expect(failed.text(.updated) == "never")
        let stale = try #require(WidgetDetail.make(metric(status: .stale, updatedAt: fiveMinutesAgo), now: now))
        #expect(stale.text(.source) == "Last sync 5 minutes ago")
        let converted = try #require(
            WidgetDetail.make(
                metric(
                    updatedAt: fiveMinutesAgo,
                    conversion: TileConversion(
                        displayCurrency: "EUR", source: "ECB euro foreign exchange reference rates", unconverted: [])),
                now: now))
        #expect(converted.text(.value) == "≈ €123,456.78")
        #expect(converted.text(.conversion) == "ECB reference rates")
    }

    @Test func aBarListsItsBars() throws {
        let bar = widget(
            .bar(
                BarWidgetOptions(),
                BarWidgetData(
                    period: .today, aggregation: .sum, unit: "count", groupBy: "country",
                    bars: [BarEntry(label: "DE", value: 12), BarEntry(label: "US", value: 7)],
                    others: BarOthers(label: "Others", value: 3), status: .ok, updatedAt: fiveMinutesAgo)),
            label: "Downloads", type: "bar")
        let detail = try #require(WidgetDetail.make(bar, now: now))
        #expect(detail.title == "Downloads")
        #expect(detail.subtitle == nil)
        #expect(detail.text(.value) == nil)
        #expect(detail.items.map(\.label) == ["DE", "US", "Others"])
        #expect(detail.items.map(\.value) == ["12", "7", "3"])
    }

    @Test func widgetsWithoutNumbersHaveNoSheet() {
        let clock = widget(.clock(ClockWidgetOptions()), label: nil, type: "clock")
        let text = widget(.text("Hello", TextWidgetOptions()), label: nil, type: "text")
        for item in [clock, text, widget(.unsupported, type: "future")] {
            #expect(!WidgetDetail.available(item))
            #expect(WidgetDetail.make(item, now: now) == nil)
        }
        #expect(WidgetDetail.available(metric(updatedAt: nil)))
    }
}
