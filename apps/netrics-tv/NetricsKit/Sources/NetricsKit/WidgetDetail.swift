import Foundation

/**
 * What the detail sheet of a widget says when it is tapped on iPad or
 * iPhone (ADR 0021, "Touch instead of focus"; #414): its label, value,
 * period, comparison, source and freshness, worded from the payload alone,
 * so the sheet works offline and needs no endpoint. "Source" is what the
 * payload knows of the widget's connection: its state (connected, last
 * sync, credentials needed, unreachable) and, for converted amounts, the
 * exchange rates used; the payload names no connector. Widgets without
 * numbers (text, image, clock, countdown, a type this build does not know)
 * have no sheet: a tap on them shows the chrome.
 */
public struct WidgetDetail: Sendable, Equatable, Identifiable {
    /** One line of the sheet, which the app gives a localized title. */
    public enum Field: String, Sendable, Equatable, CaseIterable {
        case value, period, comparison, previous, goal, progress, source, conversion, updated
    }

    public struct Row: Sendable, Equatable {
        public var field: Field
        public var text: String

        public init(_ field: Field, _ text: String) {
            self.field = field
            self.text = text
        }
    }

    /** A labelled value of a list widget: a bar, a table row, a source on a status board, an operand. */
    public struct Item: Sendable, Equatable {
        public var label: String
        public var value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    /** The widget's id. */
    public var id: String
    /** The metric ("Downloads"); the widget type's name when it has no label. */
    public var title: String
    /** The resource it is about ("Wurfel"), from a "Downloads · Wurfel" label. */
    public var subtitle: String?
    public var rows: [Row]
    public var items: [Item]
    /** A review's title and text. */
    public var text: String?

    public init(id: String, title: String, subtitle: String?, rows: [Row], items: [Item] = [], text: String? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.rows = rows
        self.items = items
        self.text = text
    }

    public func text(_ field: Field) -> String? {
        rows.first { $0.field == field }?.text
    }

    /** Whether a widget has a detail sheet: the widgets with numbers. */
    public static func available(_ widget: DeviceWidget) -> Bool {
        switch widget.content {
        case .metric, .line, .bar, .table, .status, .compare, .gauge, .review: return true
        case .image, .text, .clock, .countdown, .unsupported: return false
        }
    }

    /** The sheet of a widget at `now`; nil for widgets without one. */
    public static func make(_ widget: DeviceWidget, now: Date = Date(), language: ScreenLanguage = .en)
        -> WidgetDetail?
    {
        let parts = MetricFormat.titleParts(widget.label ?? "")
        func detail(_ rows: [Row?], items: [Item] = [], text: String? = nil, fallbackTitle: String) -> WidgetDetail {
            let title = parts.title.isEmpty ? fallbackTitle : parts.title
            return WidgetDetail(
                id: widget.id, title: title, subtitle: parts.detail, rows: rows.compactMap { $0 }, items: items,
                text: text)
        }
        func period(_ period: MetricPeriod?, _ aggregation: MetricAggregation?) -> Row? {
            let text = [
                period.map { MetricFormat.periodLabel($0, language: language) },
                aggregation.map { MetricFormat.aggregationLabel($0, language: language) },
            ]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return text.isEmpty ? nil : Row(.period, text)
        }
        func value(_ value: Double?, unit: String?, conversion: TileConversion?) -> Row {
            let text = MetricFormat.exactValue(value, unit: unit ?? "count", language: language)
            return Row(.value, conversion != nil && value != nil ? "≈ \(text)" : text)
        }
        func change(_ change: TileChange, value: Double?, unit: String?, period: MetricPeriod) -> [Row?] {
            let unit = unit ?? "count"
            let comparison = MetricFormat.comparisonLabel(period, language: language)
            let line: String
            if let change = MetricFormat.change(
                delta: change.delta, ratio: change.ratio, unit: unit, language: language)
            {
                line = "\(change.direction.arrow) \(change.text) \(comparison)"
            } else if value == nil {
                line = KitStrings.text(.noDataForPeriod, language)
            } else {
                line = KitStrings.text(.noDataToCompare, language, comparison)
            }
            let previous = change.previousValue.map {
                Row(.previous, MetricFormat.exactValue($0, unit: unit, language: language))
            }
            return [Row(.comparison, line), previous]
        }
        func source(_ status: DeviceTileStatus, updatedAt: String?, conversion: TileConversion?) -> [Row?] {
            let state: String
            switch status {
            case .authFailed: state = KitStrings.text(.noticeAuthFailed, language)
            case .outage: state = KitStrings.text(.noticeOutage, language)
            case .backfilling: state = KitStrings.text(.loadingHistory, language)
            case .stale:
                state =
                    TileNotices.notice(status: status, updatedAt: updatedAt, now: now, language: language)
                    ?? KitStrings.text(.noticeFirstSync, language)
            case .ok, .noData: state = KitStrings.text(.sourceConnected, language)
            }
            return [
                Row(.source, state),
                ConversionFormat.note(conversion, language: language).map { Row(.conversion, $0) },
                Row(.updated, RelativeTime.describe(updatedAt, now: now, language: language)),
            ]
        }
        func amount(_ value: Double, unit: String?) -> String {
            MetricFormat.exactValue(value, unit: unit ?? "count", language: language)
        }

        switch widget.content {
        case .metric(_, let data):
            return detail(
                [
                    value(data.value, unit: data.unit, conversion: data.conversion),
                    period(data.period, data.aggregation),
                ] + change(data.change, value: data.value, unit: data.unit, period: data.period)
                    + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion),
                fallbackTitle: widget.type)
        case .line(_, let data):
            return detail(
                [
                    value(data.value, unit: data.unit, conversion: data.conversion),
                    period(data.period, data.aggregation),
                ] + change(data.change, value: data.value, unit: data.unit, period: data.period)
                    + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion),
                fallbackTitle: widget.type)
        case .bar(_, let data):
            var items = data.bars.map { Item(label: $0.label, value: amount($0.value, unit: data.unit)) }
            if let others = data.others {
                items.append(Item(label: others.label, value: amount(others.value, unit: data.unit)))
            }
            return detail(
                [period(data.period, data.aggregation)]
                    + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion),
                items: items, fallbackTitle: widget.type)
        case .table(_, let data):
            var items = data.rows.map { Item(label: $0.label, value: amount($0.value, unit: data.unit)) }
            if let others = data.others {
                items.append(Item(label: others.label, value: amount(others.value, unit: data.unit)))
            }
            return detail(
                [period(data.period, data.aggregation)]
                    + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion),
                items: items, fallbackTitle: widget.type)
        case .compare(let options, let data):
            let ratio = CompareText.ratio(
                data.ratio.value, format: data.ratio.format, unit: data.unit, language: language)
            let comparison = MetricFormat.comparisonLabel(data.period, language: language)
            let changeRow = StudioLayout.compareChange(
                value: data.ratio.value, previousValue: data.ratio.previousValue, format: data.ratio.format
            ).map { Row(.comparison, "\(CompareText.change($0, language: language)) \(comparison)") }
            let previous = data.ratio.previousValue.map {
                Row(
                    .previous,
                    CompareText.ratio($0, format: data.ratio.format, unit: data.unit, language: language))
            }
            let items = [
                Item(label: data.numerator.label, value: CompareText.operand(data.numerator, language: language).full),
                Item(
                    label: data.denominator.label,
                    value: CompareText.operand(data.denominator, language: language).full),
            ]
            return detail(
                [Row(.value, "\(ratio) \(CompareText.ratioLabel(options, language: language))"),
                 period(data.period, data.aggregation), changeRow, previous]
                    + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion),
                items: items, fallbackTitle: widget.type)
        case .gauge(_, let data):
            guard let goal = data.goal else {
                return detail(
                    [Row(.value, KitStrings.text(.goalDeleted, language))], fallbackTitle: widget.type)
            }
            let progress = Goals.percent(data.progress).map {
                Row(.progress, KitStrings.text(.goalPercent, language, $0))
            }
            let target = data.target.map {
                Row(.goal, amount($0, unit: data.unit))
            }
            let title = parts.title.isEmpty ? goal.name : parts.title
            return WidgetDetail(
                id: widget.id, title: title, subtitle: parts.detail,
                rows: ([
                    value(data.value, unit: data.unit, conversion: data.conversion), target, progress,
                    period(data.period, data.aggregation),
                ] + source(data.status, updatedAt: data.updatedAt, conversion: data.conversion)).compactMap { $0 })
        case .status(_, let data):
            let items = data.items.map { item in
                Item(
                    label: item.name,
                    value: item.status == .ok
                        ? RelativeTime.describe(item.lastSuccessAt, now: now, language: language)
                        : statusText(item.status, lastSuccessAt: item.lastSuccessAt, now: now, language: language))
            }
            let failing = data.items.filter { $0.status == .authFailed || $0.status == .outage }.count
            let delayed = data.items.filter { $0.status == .stale }.count
            let connected = data.items.count - failing - delayed
            let summary = [
                KitStrings.text(.statusConnected, language, connected),
                delayed > 0 ? KitStrings.text(.statusDelayed, language, delayed) : nil,
                failing > 0 ? KitStrings.text(.statusFailing, language, failing) : nil,
            ].compactMap { $0 }.joined(separator: " · ")
            return detail(
                [Row(.value, data.items.isEmpty ? KitStrings.text(.statusEmpty, language) : summary)],
                items: items, fallbackTitle: widget.type)
        case .review(_, _, let data):
            let review = data.review
            let text = review.map { review in
                [review.title, review.body, review.author.map { "— \($0)" }]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }.joined(separator: "\n\n")
            }
            let valueRow = Row(
                .value,
                review.map { KitStrings.text(.reviewStars, language, $0.rating) }
                    ?? KitStrings.text(.noReviews, language))
            return detail(
                [valueRow] + source(data.status, updatedAt: data.updatedAt, conversion: nil),
                text: text.flatMap { $0.isEmpty ? nil : $0 }, fallbackTitle: widget.type)
        case .image, .text, .clock, .countdown, .unsupported:
            return nil
        }
    }

    static func statusText(_ status: StatusItemStatus, lastSuccessAt: String?, now: Date, language: ScreenLanguage)
        -> String
    {
        switch status {
        case .ok: return RelativeTime.describe(lastSuccessAt, now: now, language: language)
        case .stale:
            return KitStrings.text(
                .noticeLastSync, language, RelativeTime.describe(lastSuccessAt, now: now, language: language))
        case .backfilling: return KitStrings.text(.loadingHistory, language)
        case .authFailed: return KitStrings.text(.noticeAuthFailed, language)
        case .outage: return KitStrings.text(.noticeOutage, language)
        }
    }
}
