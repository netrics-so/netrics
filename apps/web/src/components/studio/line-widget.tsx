"use client";

import type { MetricPeriod } from "@netrics/contracts";
import type { StudioPlacement } from "@netrics/domain";

import {
  COMPARISON_LABELS,
  displayUnit,
  formatCompactValue,
  formatValue,
  sparkBucketLabel,
} from "@/lib/format-metric";
import { lineChartGeometry, type ChartPoint } from "@/lib/studio-chart";
import { chartWidgetLayout, u } from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";
import { connectionNotice } from "@/lib/tile-status";

import { dataNotice, dataWidgetLabel } from "./metric-widget";
import { useMetricData } from "./use-widget-data";
import { WidgetLabel, WidgetNotice } from "./widget-parts";

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
  const approx = reading?.approximate && reading.value !== null ? "≈ " : "";
  const full = reading
    ? `${approx}${formatValue(reading.value, reading.unit)}`
    : props.loading
      ? "…"
      : "—";
  const layout = chartWidgetLayout({
    type: "line",
    label: props.label,
    value: {
      full,
      compact: reading
        ? `${approx}${formatCompactValue(reading.value, reading.unit)}`
        : full,
    },
    noticeText: props.notice,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
  });
  const { width, height } = layout.chart;
  const geometry = reading
    ? lineChartGeometry({
        series: reading.series,
        previous: props.options.showPrevious ? reading.previous : null,
        width,
        height,
        showAxis: props.options.showAxis,
        axisSize: layout.sizes.axis,
        formatValue: (value) => formatCompactValue(value, reading.unit),
        bucketLabel: (bucket) =>
          sparkBucketLabel(bucket, props.period, reading.timeZone),
      })
    : null;
  const summary = reading
    ? `${props.label}: ${full}${
        props.options.showPrevious && reading.previous
          ? `, dashed line ${COMPARISON_LABELS[props.period]}`
          : ""
      }.`
    : props.label;

  return (
    <article className="sw sw-line" aria-busy={props.loading ?? false}>
      <WidgetLabel layout={layout.label} />
      {layout.value ? (
        <p
          className={reading ? "sw-value" : "sw-value sw-placeholder"}
          style={{ fontSize: u(layout.value.size), marginBottom: u(8) }}
          title={layout.value.text !== full ? full : undefined}
        >
          {layout.value.text}
        </p>
      ) : null}
      <div className="sw-chart" style={{ height: u(height) }}>
        {geometry ? (
          <svg
            viewBox={`0 0 ${width.toFixed(1)} ${height.toFixed(1)}`}
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
                y={height - 4}
                textAnchor={label.anchor}
                fontSize={geometry.axisSize}
              >
                {label.text}
              </text>
            ))}
          </svg>
        ) : reading ? (
          <p className="sw-muted" style={{ fontSize: u(layout.sizes.small) }}>
            Not enough data for a chart yet
          </p>
        ) : null}
      </div>
      {props.notice ? (
        <WidgetNotice size={layout.sizes.small}>{props.notice}</WidgetNotice>
      ) : null}
    </article>
  );
}

/** A line widget that queries its own numbers (signed-in pages). */
export function LiveLineWidget({
  widget,
  env,
}: {
  widget: Extract<DataWidget, { type: "line" }>;
  env: StudioEnv;
}) {
  const { data, error, loading } = useMetricData(env.workspaceId, widget);
  const metric = env.metrics.get(metricKeyOf(widget));
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  return (
    <LineWidgetView
      label={dataWidgetLabel(widget, metric)}
      period={widget.period}
      reading={
        data
          ? {
              value: data.value,
              unit,
              series: data.series,
              previous: data.previousSeries,
              timeZone: data.timeZone,
              approximate: data.conversion !== null,
            }
          : null
      }
      notice={dataNotice(
        error,
        data !== null,
        connectionNotice(env.connections[widget.connectionId]),
      )}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
      options={widget.options}
      loading={loading}
    />
  );
}
