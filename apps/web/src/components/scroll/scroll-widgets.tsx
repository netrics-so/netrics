"use client";

import { labelParts, othersLabel, parseTextWidget } from "@netrics/domain";

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
  useLiveLine,
  type LineReadingProps,
} from "@/components/studio/line-widget";
import { WidgetFailed } from "@/components/studio/slide-canvas";
import { Spans } from "@/components/studio/text-widget";
import { WidgetNotice } from "@/components/studio/widget-parts";
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
        <WidgetNotice size={SCROLL_TYPE.small}>{props.notice}</WidgetNotice>
      ) : props.source ? (
        <p
          className="sw-muted sw-source"
          style={{ fontSize: u(SCROLL_TYPE.small) }}
        >
          {props.source}
        </p>
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
          <svg
            viewBox={`0 0 ${chartWidth.toFixed(1)} ${chartHeight.toFixed(1)}`}
            role="img"
            aria-label={summary}
          >
            {geometry.area.map((d) => (
              <path key={`a${d}`} className="sw-line-area" d={d} />
            ))}
            {geometry.previous.map((d) => (
              <path key={`p${d}`} className="sw-line-previous" d={d} />
            ))}
            {geometry.current.map((d) => (
              <path key={`c${d}`} className="sw-line-current" d={d} />
            ))}
            {props.options.showAxis ? (
              <line
                className="sw-axis"
                x1={geometry.plot.x}
                x2={geometry.plot.x + geometry.plot.width}
                y1={geometry.plot.y + geometry.plot.height}
                y2={geometry.plot.y + geometry.plot.height}
              />
            ) : null}
            {geometry.last ? (
              <circle
                className="sw-line-last"
                cx={geometry.last.x}
                cy={geometry.last.y}
                r={Math.max(6, geometry.axisSize * 0.3)}
              />
            ) : null}
            {geometry.yLabels.map((label) => (
              <text
                key={`y${label.y}`}
                className="sw-axis-label"
                x={geometry.plot.x - 12}
                y={label.y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={geometry.axisSize}
              >
                {label.text}
              </text>
            ))}
            {geometry.xLabels.map((label) => (
              <text
                key={`x${label.anchor}`}
                className="sw-axis-label"
                x={label.x}
                y={chartHeight - 4}
                textAnchor={label.anchor}
                fontSize={geometry.axisSize}
              >
                {label.text}
              </text>
            ))}
          </svg>
        ) : reading ? (
          <p className="sw-muted" style={{ fontSize: u(SCROLL_TYPE.small) }}>
            {t("notEnoughData")}
          </p>
        ) : null}
      </div>
      {props.notice ? (
        <WidgetNotice size={SCROLL_TYPE.small}>{props.notice}</WidgetNotice>
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
        <WidgetNotice size={SCROLL_TYPE.small}>{props.notice}</WidgetNotice>
      ) : null}
    </article>
  );
}

/** The clock card: the time in the accent colour, and the date. */
export function ScrollClockCard(
  props: {
    now: Date;
    timeZone: string;
    options: { showDate: boolean; hour12: boolean };
  } & ScrollCardSize,
) {
  const locale = useLocale();
  const text = clockText(props.now, {
    locale,
    timeZone: props.timeZone,
    hour12: props.options.hour12,
    showDate: props.options.showDate,
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
