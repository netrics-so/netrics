"use client";

import {
  labelParts,
  othersLabel,
  parseTextWidget,
  periodLabel,
} from "@netrics/domain";

import { Sparkline } from "@/components/sparkline";
import { useNow } from "@/components/studio/clock-widget";
import {
  metricTexts,
  useLiveMetric,
  type MetricReadingProps,
} from "@/components/studio/metric-widget";
import {
  useLiveBar,
  type BarReadingProps,
} from "@/components/studio/bar-widget";
import {
  LineChartSvg,
  useLiveLine,
  type LineReadingProps,
} from "@/components/studio/line-widget";
import {
  useLiveStatus,
  type StatusReadingProps,
} from "@/components/studio/status-widget";
import {
  useLiveTable,
  type TableReadingProps,
} from "@/components/studio/table-widget";
import {
  useLiveCompare,
  type CompareReadingProps,
} from "@/components/studio/compare-widget";
import { WidgetFailed } from "@/components/studio/slide-canvas";
import { Spans } from "@/components/studio/text-widget";
import {
  WidgetFooter,
  WidgetNotice,
  useFooterCandidates,
} from "@/components/studio/widget-parts";
import {
  comparisonLabel,
  formatCompactValue,
  formatValue,
  sparkBucketLabel,
} from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  SCROLL_TYPE,
  SCROLL_UNITS_PER_REM,
  cardUnits,
  scrollChartHeight,
  scrollClockSize,
  scrollValue,
} from "@/lib/scroll-view";
import { lineChartGeometry } from "@/lib/studio-chart";
import { clockText } from "@/lib/studio-clock";
import {
  statusAgeText,
  statusFooterText,
  statusTone,
} from "@/lib/studio-status";
import { tableRowTexts, tableSubtitle } from "@/lib/studio-table";
import {
  compareChangeText,
  compareFooterCandidates,
  compareOperandTexts,
  compareRatioText,
} from "@/lib/studio-compare";
import { LINE_HEIGHT, u } from "@/lib/studio-render";
import {
  type ImageWidget,
  type StudioEnv,
  type StudioImage,
  type StudioWidget,
} from "@/lib/studio-widgets";

// Widget cards of the scroll view (ADR 0017, section 5). They read the same
// numbers as the slide renderers (useLive*, metricTexts) and size text in
// the scroll view's rem-based unit: labels wrap in full and are never cut,
// values shrink and then go compact, charts are 16:9 of their width.

/** How wide a card is, to fit values and draw charts. */
export interface ScrollCardSize {
  /** The card's width in CSS px. */
  width: number;
  /** The root font size in CSS px (16 unless the viewer changed it). */
  rootPx: number;
}

/** A data widget's label, wrapped in full: metric, then resource. */
function ScrollLabel({ label }: { label: string }) {
  const parts = labelParts(label);
  return (
    <div className="scroll-label">
      <h3 className="scroll-title" style={{ fontSize: u(SCROLL_TYPE.title) }}>
        {parts.title}
      </h3>
      {parts.resource ? (
        <p
          className="scroll-resource"
          style={{ fontSize: u(SCROLL_TYPE.resource) }}
        >
          {parts.resource}
        </p>
      ) : null}
    </div>
  );
}

function ScrollValue({
  full,
  compact,
  units,
  placeholder,
}: {
  full: string;
  compact: string;
  units: number;
  placeholder: boolean;
}) {
  const value = scrollValue({ full, compact }, units);
  return (
    <p
      className={placeholder ? "scroll-value sw-placeholder" : "scroll-value"}
      style={{ fontSize: u(value.size) }}
      title={value.text !== full ? full : undefined}
    >
      {value.text}
    </p>
  );
}

/** The metric card: label, period, value, change, sparkline, source. */
export function ScrollMetricCard(props: MetricReadingProps & ScrollCardSize) {
  const { reading } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const texts = metricTexts(props, locale, t);
  const units = cardUnits(props.width, props.rootPx);
  const [footer] = useFooterCandidates(props.updatedAt, props.source);
  return (
    <article
      className="sw scroll-card scroll-card--metric"
      aria-busy={props.loading ?? false}
    >
      <ScrollLabel label={props.label} />
      <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
        {texts.periodText}
      </p>
      <ScrollValue
        full={texts.full}
        compact={texts.compact}
        units={units}
        placeholder={reading === null}
      />
      {texts.changeLine ? (
        <p
          className={`sw-change ${texts.change?.tone ?? "neutral"}`}
          style={{ fontSize: u(SCROLL_TYPE.change) }}
        >
          {texts.change ? (
            <>
              {texts.changeLine.short}{" "}
              <span className="sw-comparison">{texts.comparison}</span>
            </>
          ) : (
            texts.changeLine.full
          )}
        </p>
      ) : null}
      {props.options.showSparkline && reading ? (
        <div className="sw-spark scroll-spark">
          <Sparkline
            series={reading.series}
            unit={reading.unit}
            period={props.period}
            timeZone={reading.timeZone}
          />
        </div>
      ) : null}
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={SCROLL_TYPE.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** The line card: label, value and the chart, 16:9 of the card's width. */
export function ScrollLineCard(props: LineReadingProps & ScrollCardSize) {
  const { reading } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const units = cardUnits(props.width, props.rootPx);
  const [footer] = useFooterCandidates(props.updatedAt, props.source);
  const approx = reading?.approximate && reading.value !== null ? "≈ " : "";
  const full = reading
    ? `${approx}${formatValue(reading.value, reading.unit, locale)}`
    : props.loading
      ? "…"
      : "—";
  const compact = reading
    ? `${approx}${formatCompactValue(reading.value, reading.unit, locale)}`
    : full;
  // The chart in units, so axis labels use the scroll view's text size.
  const pxPerUnit =
    (props.rootPx > 0 ? props.rootPx : 16) / SCROLL_UNITS_PER_REM;
  const chartWidth = units;
  const chartHeight = scrollChartHeight(units * pxPerUnit) / pxPerUnit;
  const geometry = reading
    ? lineChartGeometry({
        series: reading.series,
        previous: props.options.showPrevious ? reading.previous : null,
        width: chartWidth,
        height: chartHeight,
        showAxis: props.options.showAxis,
        axisSize: SCROLL_TYPE.small,
        formatValue: (value) => formatCompactValue(value, reading.unit, locale),
        bucketLabel: (bucket) =>
          sparkBucketLabel(bucket, props.period, reading.timeZone, locale),
      })
    : null;
  const summary = reading
    ? props.options.showPrevious && reading.previous
      ? t("lineSummaryPrevious", {
          label: props.label,
          value: full,
          comparison: comparisonLabel(props.period, locale),
        })
      : t("lineSummary", { label: props.label, value: full })
    : props.label;
  return (
    <article
      className="sw scroll-card scroll-card--line"
      aria-busy={props.loading ?? false}
    >
      <ScrollLabel label={props.label} />
      <ScrollValue
        full={full}
        compact={compact}
        units={units}
        placeholder={reading === null}
      />
      <div className="sw-chart scroll-chart" style={{ height: u(chartHeight) }}>
        {geometry ? (
          <LineChartSvg
            geometry={geometry}
            width={chartWidth}
            height={chartHeight}
            summary={summary}
            showAxis={props.options.showAxis}
          />
        ) : reading ? (
          <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
            {t("notEnoughData")}
          </p>
        ) : null}
      </div>
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={SCROLL_TYPE.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/**
 * The bar card: every group the widget asks for, largest first, then
 * "Others". Labels wrap in full; nothing is folded away for lack of room
 * (the card grows instead).
 */
export function ScrollBarCard(props: BarReadingProps & ScrollCardSize) {
  const { reading } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const [footer] = useFooterCandidates(props.updatedAt, props.source);
  const approx = reading?.approximate ? "≈ " : "";
  const rows = reading
    ? [
        ...reading.groups.map((group) => ({ ...group, others: false })),
        ...(reading.others
          ? [
              {
                label: reading.others.label || othersLabel(locale),
                value: reading.others.value,
                others: true,
              },
            ]
          : []),
      ]
    : [];
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <article
      className="sw scroll-card scroll-card--bar"
      aria-busy={props.loading ?? false}
    >
      <ScrollLabel label={props.label} />
      {rows.length > 0 && reading ? (
        <ol
          className="sw-bars scroll-bars"
          style={{ fontSize: u(SCROLL_TYPE.resource) }}
        >
          {rows.map((row, index) => (
            <li
              key={`${index}:${row.label}`}
              className={row.others ? "sw-bar-row others" : "sw-bar-row"}
            >
              <span className="sw-bar-text">
                <span className="scroll-bar-label">{row.label}</span>
                <span className="sw-bar-value">
                  {`${approx}${formatValue(row.value, reading.unit, locale)}`}
                </span>
              </span>
              <span className="sw-bar-track scroll-bar-track">
                <span
                  className="sw-bar-fill"
                  style={{
                    width: `${(max > 0 ? (Math.max(0, row.value) / max) * 100 : 0).toFixed(2)}%`,
                  }}
                />
              </span>
            </li>
          ))}
        </ol>
      ) : reading ? (
        <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
          {t("noDataYet")}
        </p>
      ) : (
        <p
          className="scroll-value sw-placeholder"
          style={{ fontSize: u(SCROLL_TYPE.resource) }}
        >
          {props.loading ? "…" : "—"}
        </p>
      )}
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={SCROLL_TYPE.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/**
 * The clock card: the time in the accent colour, the date and the zone
 * line; the card grows to fit them, so nothing is left out.
 */
export function ScrollClockCard(
  props: {
    now: Date;
    timeZone: string;
    options: {
      showDate: boolean;
      hour12: boolean;
      /** Absent from older payloads: the short date. */
      dateStyle?: "short" | "long";
      showZone?: boolean;
    };
  } & ScrollCardSize,
) {
  const locale = useLocale();
  const text = clockText(props.now, {
    locale,
    timeZone: props.timeZone,
    hour12: props.options.hour12,
    showDate: props.options.showDate,
    dateStyle: props.options.dateStyle ?? "short",
    showZone: props.options.showZone ?? false,
  });
  const size = scrollClockSize(text.time, cardUnits(props.width, props.rootPx));
  return (
    <div className="sw sw-clock scroll-card scroll-card--clock">
      <time
        className="sw-clock-time"
        style={{ fontSize: u(size) }}
        suppressHydrationWarning
      >
        {text.time}
      </time>
      {text.date ? (
        <span
          className="sw-clock-date"
          style={{ fontSize: u(SCROLL_TYPE.date) }}
          suppressHydrationWarning
        >
          {text.date}
        </span>
      ) : null}
      {text.zone ? (
        <span
          className="sw-clock-zone"
          style={{ fontSize: u(SCROLL_TYPE.small) }}
          suppressHydrationWarning
        >
          {text.zone}
        </span>
      ) : null}
    </div>
  );
}

/** The text card: the widget's markdown-lite, at the web's sizes. */
export function ScrollTextCard({
  text,
  options,
}: {
  text: string;
  options: {
    size: "body" | "heading" | "display";
    align: "start" | "center" | "end";
  };
}) {
  const size = SCROLL_TYPE.text[options.size] ?? SCROLL_TYPE.text.body;
  return (
    <div
      className={`sw sw-text sw-text--${options.align} scroll-card scroll-card--text`}
      style={{ lineHeight: LINE_HEIGHT }}
    >
      {parseTextWidget(text).map((block, index) =>
        block.kind === "heading" ? (
          block.level === 1 ? (
            <h3 key={index} style={{ fontSize: u(size * 1.25) }}>
              <Spans spans={block.spans} />
            </h3>
          ) : (
            <h4 key={index} style={{ fontSize: u(size * 1.1) }}>
              <Spans spans={block.spans} />
            </h4>
          )
        ) : (
          <p key={index} style={{ fontSize: u(size) }}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                <Spans spans={line} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

/** The image card: the whole image at its aspect, at most half the view. */
export function ScrollImageCard({
  widget,
  image,
}: {
  widget: Pick<ImageWidget, "title" | "options">;
  image: StudioImage | null;
}) {
  const t = useT("screen.widget");
  if (!image) {
    return (
      <div className="sw sw-image--missing scroll-card scroll-card--image">
        <WidgetNotice size={SCROLL_TYPE.small}>
          {t("imageMissing")}
        </WidgetNotice>
      </div>
    );
  }
  return (
    <div className="scroll-card scroll-card--image">
      <img
        src={image.url}
        alt={widget.title ?? ""}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

/**
 * The table card (ADR 0019 section 6): every row the widget asks for, then
 * Others when it shows them. Labels and values are shown in full; the card
 * grows instead of cutting anything.
 */
export function ScrollTableCard(props: TableReadingProps & ScrollCardSize) {
  const { reading } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const [footer] = useFooterCandidates(props.updatedAt, props.source);
  const rows = reading ? tableRowTexts(reading, props.options, locale) : [];
  const shown = rows.filter((row) => !row.others).length;
  const columns = {
    gridTemplateColumns: props.options.showChange
      ? "minmax(0, 1fr) auto auto"
      : "minmax(0, 1fr) auto",
    columnGap: u(16),
  };
  return (
    <article
      className="sw scroll-card scroll-card--table"
      aria-busy={props.loading ?? false}
    >
      <ScrollLabel label={props.label} />
      <p
        className="sw-muted sw-table-subtitle"
        style={{ fontSize: u(SCROLL_TYPE.small) }}
      >
        {tableSubtitle(shown, props.period, locale)}
      </p>
      {rows.length > 0 && reading ? (
        // One grid for the heads and every row, so the columns line up
        // whatever each value's width.
        <div className="scroll-table" style={columns}>
          <div
            className="sw-table-head"
            style={{ fontSize: u(SCROLL_TYPE.small) }}
            aria-hidden="true"
          >
            <span className="sw-table-head-label">{reading.columns.label}</span>
            <span className="sw-table-head-value">{reading.columns.value}</span>
            {props.options.showChange ? (
              <span className="sw-table-head-value">
                {t("tableChangeHead")}
              </span>
            ) : null}
          </div>
          <ol
            className="sw-table-rows scroll-table-rows"
            style={{ fontSize: u(SCROLL_TYPE.resource) }}
          >
            {rows.map((row, index) => (
              <li
                key={`${index}:${row.label}`}
                className={row.others ? "sw-table-row others" : "sw-table-row"}
              >
                <span className="scroll-table-label">{row.label}</span>
                <span className="sw-table-value">{row.value.full}</span>
                {row.change !== null ? (
                  <span
                    className={`sw-table-change sw-change${row.tone === "neutral" ? "" : ` ${row.tone}`}`}
                  >
                    {row.change}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : reading ? (
        <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
          {t("noDataYet")}
        </p>
      ) : (
        <p
          className="scroll-value sw-placeholder"
          style={{ fontSize: u(SCROLL_TYPE.resource) }}
        >
          {props.loading ? "…" : "—"}
        </p>
      )}
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={SCROLL_TYPE.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/**
 * The status board card (ADR 0019 section 7): every source, attention
 * first, names wrapped in full; the card grows instead of "+N more".
 */
export function ScrollStatusCard(props: StatusReadingProps & ScrollCardSize) {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow().getTime();
  return (
    <article className="sw scroll-card scroll-card--status">
      <ScrollLabel label={props.label} />
      {props.items.length === 0 ? (
        <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
          {t("statusEmpty")}
        </p>
      ) : (
        <ol
          className="sw-status-rows scroll-status-rows"
          style={{ fontSize: u(SCROLL_TYPE.resource) }}
        >
          {props.items.map((item) => (
            <li
              key={item.connectionId}
              className={`sw-status-row ${statusTone(item.status)}`}
              aria-label={t("statusItem", {
                name: item.name,
                status: item.status,
              })}
            >
              <span
                className="sw-status-dot"
                style={{ width: u(14), height: u(14) }}
                aria-hidden="true"
              />
              <span className="scroll-status-name" aria-hidden="true">
                {item.name}
              </span>
              {props.options.showAge ? (
                <span
                  className={
                    item.status === "stale"
                      ? "sw-status-age stale"
                      : "sw-status-age"
                  }
                  style={{ fontSize: u(SCROLL_TYPE.small) }}
                  aria-hidden="true"
                  suppressHydrationWarning
                >
                  {statusAgeText(item.lastSuccessAt, now, locale)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {props.items.length > 0 ? (
        <WidgetFooter size={SCROLL_TYPE.small}>
          {statusFooterText(props.items, locale)}
        </WidgetFooter>
      ) : null}
    </article>
  );
}

/**
 * The compare card (ADR 0019 section 10): the operands with their
 * captions, then the ratio with its label and change; one column wide.
 */
export function ScrollCompareCard(props: CompareReadingProps & ScrollCardSize) {
  const { reading, options } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const [footer] = compareFooterCandidates(
    useFooterCandidates(props.updatedAt, props.source),
    locale,
  );
  const units = cardUnits(props.width, props.rootPx);
  const placeholder = props.loading ? "…" : "—";
  const operand = (side: "numerator" | "denominator") => {
    const texts = reading
      ? compareOperandTexts(reading[side], locale)
      : { full: placeholder, compact: placeholder };
    const value = scrollValue(texts, (units - 48) / 2);
    return (
      <span className="sw-compare-operand">
        <span
          className={`sw-value sw-compare-number${reading ? "" : " sw-placeholder"}`}
          style={{ fontSize: u(Math.min(value.size, SCROLL_TYPE.valueMin)) }}
        >
          {value.text}
        </span>
        <span
          className="sw-muted sw-compare-caption"
          style={{ fontSize: u(SCROLL_TYPE.small) }}
        >
          {reading?.[side].label ?? ""}
        </span>
      </span>
    );
  };
  const ratio = reading
    ? compareRatioText(
        reading.ratio.value,
        options.format,
        reading.unit,
        locale,
      )
    : placeholder;
  const change =
    reading && options.showChange
      ? compareChangeText(reading.ratio, options.format, reading.better, locale)
      : null;
  return (
    <article
      className="sw scroll-card scroll-card--compare"
      aria-busy={props.loading ?? false}
    >
      <ScrollLabel label={props.label} />
      <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
        {periodLabel(props.period, locale)}
      </p>
      <div className="sw-compare-operands" style={{ columnGap: u(16) }}>
        {operand("numerator")}
        <span
          className="sw-compare-separator"
          aria-hidden="true"
          style={{ fontSize: u(SCROLL_TYPE.valueMin) }}
        >
          /
        </span>
        {operand("denominator")}
      </div>
      <p
        className="sw-compare-ratio-row sw-compare-ratio-row--below"
        style={{ fontSize: u(SCROLL_TYPE.change), columnGap: u(12) }}
      >
        <span
          className={`sw-value sw-compare-ratio${reading ? "" : " sw-placeholder"}`}
          style={{ fontSize: u(SCROLL_TYPE.valueMax) }}
        >
          {ratio}
        </span>
        <span className="sw-compare-ratio-below">
          <span className="sw-compare-ratio-label">
            {options.ratioLabel ?? t("compareRatio")}
          </span>
          {change ? (
            <span
              className={`sw-compare-change sw-change${change.tone === "neutral" ? "" : ` ${change.tone}`}`}
            >
              {change.text}
            </span>
          ) : null}
        </span>
      </p>
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={SCROLL_TYPE.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

function LiveScrollCompare({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "compare" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollCompareCard {...useLiveCompare(widget, env)} {...size} />;
}

function LiveScrollStatus({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "status" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollStatusCard {...useLiveStatus(widget, env)} {...size} />;
}

function LiveScrollTable({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "table" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollTableCard {...useLiveTable(widget, env)} {...size} />;
}

function LiveScrollMetric({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "metric" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollMetricCard {...useLiveMetric(widget, env)} {...size} />;
}

function LiveScrollLine({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "line" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollLineCard {...useLiveLine(widget, env)} {...size} />;
}

function LiveScrollBar({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "bar" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  return <ScrollBarCard {...useLiveBar(widget, env)} {...size} />;
}

function LiveScrollClock({
  widget,
  env,
  size,
}: {
  widget: Extract<StudioWidget, { type: "clock" }>;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  const now = useNow();
  return (
    <ScrollClockCard
      now={now}
      timeZone={widget.options.timeZone ?? env.timeZone}
      options={widget.options}
      {...size}
    />
  );
}

/** A widget's scroll view card with its own data (signed-in pages). */
export function LiveScrollWidget({
  widget,
  env,
  size,
}: {
  widget: StudioWidget;
  env: StudioEnv;
  size: ScrollCardSize;
}) {
  switch (widget.type) {
    case "metric":
      return <LiveScrollMetric widget={widget} env={env} size={size} />;
    case "line":
      return <LiveScrollLine widget={widget} env={env} size={size} />;
    case "bar":
      return <LiveScrollBar widget={widget} env={env} size={size} />;
    case "table":
      return <LiveScrollTable widget={widget} env={env} size={size} />;
    case "status":
      return <LiveScrollStatus widget={widget} env={env} size={size} />;
    case "compare":
      return <LiveScrollCompare widget={widget} env={env} size={size} />;
    case "clock":
      return <LiveScrollClock widget={widget} env={env} size={size} />;
    case "text":
      return <ScrollTextCard text={widget.text} options={widget.options} />;
    case "image":
      return (
        <ScrollImageCard
          widget={widget}
          image={env.images.get(widget.imageId) ?? null}
        />
      );
    default:
      return <WidgetFailed />;
  }
}
