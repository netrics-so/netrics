"use client";

import { useId, useRef, type CSSProperties } from "react";

import type { DeviceTileStatus, MetricPeriod } from "@netrics/contracts";
import type { StudioPlacement } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import {
  comparisonLabel,
  displayUnit,
  formatCompactValue,
  formatValue,
  sparkBucketLabel,
} from "@/lib/format-metric";
import {
  lineChartGeometry,
  type ChartPoint,
  type LineChartGeometry,
} from "@/lib/studio-chart";
import {
  chartWidgetLayoutWithFooter,
  footerLine,
  u,
} from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";

import { useCountUp } from "./enter-motion";
import { countFormat, dataWidgetLabel, liveDataState } from "./metric-widget";
import { useMetricData } from "./use-widget-data";
import {
  DataStateWidget,
  WidgetFooter,
  WidgetLabel,
  WidgetNotice,
  dataSurfaceOf,
  statusClass,
  useFooterCandidates,
} from "./widget-parts";

export interface LineReading {
  value: number | null;
  unit: string;
  series: ChartPoint[];
  /** The previous period aligned to `series`; null when not shown. */
  previous: ChartPoint[] | null;
  timeZone: string;
  approximate?: boolean;
}

export interface LineWidgetViewProps {
  label: string;
  period: MetricPeriod;
  reading: LineReading | null;
  notice: string | null;
  /** How far the numbers can be trusted; default ok. */
  status?: DeviceTileStatus;
  /** The connection's name, for the footer; null: none to show. */
  source?: string | null;
  /** The data's last successful sync, for the footer; null: unknown. */
  updatedAt?: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  options: { showPrevious: boolean; showAxis: boolean };
  loading?: boolean;
}

/**
 * The line widget: the metric's value over the period, the previous period
 * dashed behind it, value and period labels on the axes (at least 24
 * units). Drawn as SVG in canvas units, so text sizes are exact.
 */
export function LineWidgetView(props: LineWidgetViewProps) {
  const { reading } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const approx = reading?.approximate && reading.value !== null ? "≈ " : "";
  const full = reading
    ? `${approx}${formatValue(reading.value, reading.unit, locale)}`
    : props.loading
      ? "…"
      : "—";
  const compact = reading
    ? `${approx}${formatCompactValue(reading.value, reading.unit, locale)}`
    : full;
  const candidates = useFooterCandidates(props.updatedAt, props.source);
  const fitted = chartWidgetLayoutWithFooter(
    {
      type: "line",
      label: props.label,
      value: { full, compact },
      noticeText: props.notice,
      placement: props.placement,
      showHeader: props.showHeader,
      fontScale: props.fontScale,
    },
    footerLine(candidates, {
      type: "line",
      placement: props.placement,
      showHeader: props.showHeader,
      fontScale: props.fontScale,
    }),
  );
  const { layout, footer } = fitted;
  const valueRef = useRef<HTMLParagraphElement>(null);
  const shown = layout.value?.text ?? full;
  useCountUp(
    valueRef,
    layout.value ? (reading?.value ?? null) : null,
    countFormat(shown, { full, compact }, reading, locale),
    shown,
  );
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="line"
        surface={surface}
        label={layout.label}
        small={layout.sizes.small}
        source={props.source}
        updatedAt={props.updatedAt}
        placement={props.placement}
        showHeader={props.showHeader}
        fontScale={props.fontScale}
      />
    );
  }
  const { width, height } = layout.chart;
  const geometry = reading
    ? lineChartGeometry({
        series: reading.series,
        previous: props.options.showPrevious ? reading.previous : null,
        width,
        height,
        showAxis: props.options.showAxis,
        axisSize: layout.sizes.axis,
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
      className={`sw sw-line${statusClass(props.status)}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={layout.label} />
      {layout.value ? (
        <p
          ref={valueRef}
          className={reading ? "sw-value" : "sw-value sw-placeholder"}
          style={{ fontSize: u(layout.value.size), marginBottom: u(8) }}
          title={layout.value.text !== full ? full : undefined}
        >
          {layout.value.text}
        </p>
      ) : null}
      <div className="sw-chart" style={{ height: u(height) }}>
        {geometry ? (
          <LineChartSvg
            geometry={geometry}
            width={width}
            height={height}
            summary={summary}
            showAxis={props.options.showAxis}
          />
        ) : reading ? (
          <p className="sw-muted" style={{ fontSize: u(layout.sizes.small) }}>
            {t("notEnoughData")}
          </p>
        ) : null}
      </div>
      {props.notice ? (
        <WidgetNotice
          size={layout.sizes.small}
          stale={props.status === "stale"}
        >
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={layout.sizes.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** How far the last point's pulse ring reaches, in units (design 14 px). */
const PULSE_RING = 21;

/**
 * A line chart in units (the slide's widget and the scroll view's card):
 * the area under the line fading from the chart fill to nothing, the
 * previous period dashed, the current line on top with a dot at its end,
 * and the axis labels.
 */
export function LineChartSvg({
  geometry,
  width,
  height,
  summary,
  showAxis,
}: {
  geometry: LineChartGeometry;
  width: number;
  height: number;
  summary: string;
  showAxis: boolean;
}) {
  const gradient = `sw-area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const radius = Math.max(9, geometry.axisSize * 0.3);
  return (
    <svg
      viewBox={`0 0 ${width.toFixed(1)} ${height.toFixed(1)}`}
      role="img"
      aria-label={summary}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="sw-line-area-from" />
          <stop offset="1" className="sw-line-area-to" />
        </linearGradient>
      </defs>
      {geometry.area.map((d) => (
        <path
          key={`a${d}`}
          className="sw-line-area"
          d={d}
          style={{ fill: `url(#${gradient})` }}
        />
      ))}
      {geometry.previous.map((d) => (
        <path key={`p${d}`} className="sw-line-previous" d={d} />
      ))}
      {geometry.current.map((d) => (
        <path
          key={`c${d}`}
          className="sw-line-current"
          d={d}
          // The enter draws it with a dash offset (ADR 0018 section 6).
          pathLength={100}
        />
      ))}
      {showAxis ? (
        <line
          className="sw-axis"
          x1={geometry.plot.x}
          x2={geometry.plot.x + geometry.plot.width}
          y1={geometry.plot.y + geometry.plot.height}
          y2={geometry.plot.y + geometry.plot.height}
        />
      ) : null}
      {geometry.last ? (
        <>
          {/* The last point's pulse: a ring growing 21 units out from the
              dot and fading (on player slides only, see globals.css). */}
          <circle
            className="sw-line-pulse"
            cx={geometry.last.x}
            cy={geometry.last.y}
            r={radius}
            style={
              {
                "--sw-pulse-scale": ((radius + PULSE_RING) / radius).toFixed(3),
              } as CSSProperties
            }
          />
          <circle
            className="sw-line-last"
            cx={geometry.last.x}
            cy={geometry.last.y}
            r={radius}
          />
        </>
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
          y={height - 4}
          textAnchor={label.anchor}
          fontSize={geometry.axisSize}
        >
          {label.text}
        </text>
      ))}
    </svg>
  );
}

/** A line widget's props apart from its placement on a slide. */
export type LineReadingProps = Omit<
  LineWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/** A line widget's live numbers, for the slide and the scroll view. */
export function useLiveLine(
  widget: Extract<DataWidget, { type: "line" }>,
  env: StudioEnv,
): LineReadingProps {
  const { data, error, loading } = useMetricData(env.workspaceId, widget);
  const locale = useLocale();
  const metric = env.metrics.get(metricKeyOf(widget));
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  return {
    label: dataWidgetLabel(widget, metric),
    period: widget.period,
    reading: data
      ? {
          value: data.value,
          unit,
          series: data.series,
          previous: data.previousSeries,
          timeZone: data.timeZone,
          approximate: data.conversion !== null,
        }
      : null,
    ...liveDataState(
      {
        error,
        loading,
        loaded: data !== null,
        hasData: data !== null && data.value !== null,
      },
      env.connections[widget.connectionId],
      locale,
    ),
    source: env.connections[widget.connectionId]?.name ?? null,
    updatedAt:
      env.connections[widget.connectionId]?.state.lastSuccessAt ?? null,
    options: widget.options,
    loading,
  };
}

/** A line widget that queries its own numbers (signed-in pages). */
export function LiveLineWidget({
  widget,
  env,
}: {
  widget: Extract<DataWidget, { type: "line" }>;
  env: StudioEnv;
}) {
  return (
    <LineWidgetView
      {...useLiveLine(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
