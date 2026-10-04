"use client";

import type {
  MetricAggregation,
  MetricPeriod,
  WorkspaceMetric,
} from "@netrics/contracts";
import { tileLabel, type StudioPlacement } from "@netrics/domain";

import { Sparkline } from "@/components/sparkline";
import type { TileMetric, TileReading } from "@/components/tile-view";
import {
  AGGREGATION_LABELS,
  COMPARISON_LABELS,
  PERIOD_LABELS,
  aggregationLabel,
  displayUnit,
  formatChange,
  formatCompactValue,
  formatValue,
} from "@/lib/format-metric";
import { metricWidgetLayout, u } from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";
import { connectionNotice } from "@/lib/tile-status";

import { useMetricData } from "./use-widget-data";
import { WidgetLabel, WidgetNotice } from "./widget-parts";

const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;

export interface MetricWidgetViewProps {
  label: string;
  period: MetricPeriod;
  aggregation: MetricAggregation;
  metric: TileMetric | null;
  /** Null while loading, or when the first load failed. */
  reading: TileReading | null;
  /** A stale or failure notice, in the warning colour. */
  notice: string | null;
  /** The connection's name, under the numbers when there is room. */
  source: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  options: { showSparkline: boolean; showChange: boolean };
  loading?: boolean;
}

/**
 * The metric widget: today's tile (label, value, change, sparkline) on the
 * studio grid, sized by studioLayout and coloured by the theme tokens.
 */
export function MetricWidgetView(props: MetricWidgetViewProps) {
  const { reading, metric, period } = props;
  const change = reading
    ? formatChange(
        reading.delta,
        reading.ratio,
        reading.unit,
        metric?.better ?? "higher",
      )
    : null;
  const comparison = COMPARISON_LABELS[period];
  const changeLine = !props.options.showChange
    ? null
    : !reading
      ? null
      : change
        ? {
            full: `${ARROWS[change.direction]} ${change.text} ${comparison}`,
            short: `${ARROWS[change.direction]} ${change.text}`,
          }
        : reading.value === null
          ? { full: "No data for this period yet", short: "No data yet" }
          : {
              full: `No data to compare ${comparison}`,
              short: "No comparison",
            };
  const periodText = `${PERIOD_LABELS[period]} · ${
    metric
      ? aggregationLabel(props.aggregation, metric)
      : AGGREGATION_LABELS[props.aggregation]
  }`;
  const approx = reading?.approximate && reading.value !== null ? "≈ " : "";
  const full = reading
    ? `${approx}${formatValue(reading.value, reading.unit)}`
    : props.loading
      ? "…"
      : "—";
  const compact = reading
    ? `${approx}${formatCompactValue(reading.value, reading.unit)}`
    : full;
  const layout = metricWidgetLayout({
    label: props.label,
    value: { full, compact },
    periodText,
    change: changeLine,
    noticeText: props.notice,
    sourceText: props.source,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
    showSparkline: props.options.showSparkline && reading !== null,
  });

  return (
    <article className="sw sw-metric" aria-busy={props.loading ?? false}>
      <WidgetLabel layout={layout.label} />
      {layout.showPeriod ? (
        <p className="sw-muted" style={{ fontSize: u(layout.sizes.small) }}>
          {periodText}
        </p>
      ) : null}
      <p
        className={reading ? "sw-value" : "sw-value sw-placeholder"}
        style={{ fontSize: u(layout.value.size) }}
        title={layout.value.text !== full ? full : undefined}
      >
        {layout.value.text}
      </p>
      {layout.changeText ? (
        <p
          className={`sw-change ${change?.tone ?? "neutral"}`}
          style={{ fontSize: u(layout.sizes.change) }}
        >
          {changeLine && layout.changeText === changeLine.full && change ? (
            // As on tiles: the comparison in the muted colour.
            <>
              {changeLine.short}{" "}
              <span className="sw-comparison">{comparison}</span>
            </>
          ) : (
            layout.changeText
          )}
        </p>
      ) : null}
      {layout.sparkline > 0 && reading ? (
        <div className="sw-spark" style={{ height: u(layout.sparkline) }}>
          <Sparkline
            series={reading.series}
            unit={reading.unit}
            period={period}
            timeZone={reading.timeZone}
          />
        </div>
      ) : null}
      {props.notice ? (
        <WidgetNotice size={layout.sizes.small}>{props.notice}</WidgetNotice>
      ) : null}
      {layout.showSource && props.source ? (
        <p
          className="sw-muted sw-source"
          style={{ fontSize: u(layout.sizes.small) }}
        >
          {props.source}
        </p>
      ) : null}
    </article>
  );
}

/** The default label of a data widget, as on tiles (#194, #208). */
export function dataWidgetLabel(
  widget: DataWidget,
  metric: WorkspaceMetric | undefined,
): string {
  return tileLabel({
    title: widget.title,
    metricName: metric?.name ?? widget.metricKey,
    dimensions: widget.dimensions,
    resourceName: widget.resourceName,
    allResourcesName: widget.allResourcesName,
  });
}

/** The notice of a data widget: its data failed, or it may be stale. */
export function dataNotice(
  error: string | null,
  hasData: boolean,
  stale: string | null,
): string | null {
  if (error) {
    return hasData ? "Refresh failed" : "Could not load";
  }
  return stale;
}

/** A metric widget that queries its own numbers (signed-in pages). */
export function LiveMetricWidget({
  widget,
  env,
}: {
  widget: Extract<DataWidget, { type: "metric" }>;
  env: StudioEnv;
}) {
  const { data, error, loading } = useMetricData(env.workspaceId, widget);
  const metric = env.metrics.get(metricKeyOf(widget));
  const connection = env.connections[widget.connectionId];
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  return (
    <MetricWidgetView
      label={dataWidgetLabel(widget, metric)}
      period={widget.period}
      aggregation={widget.aggregation}
      metric={data?.metric ?? metric ?? null}
      reading={
        data
          ? {
              value: data.value,
              unit,
              delta: data.delta,
              ratio: data.ratio,
              series: data.series,
              timeZone: data.timeZone,
              approximate: data.conversion !== null,
            }
          : null
      }
      notice={dataNotice(error, data !== null, connectionNotice(connection))}
      source={connection?.name ?? null}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
      options={widget.options}
      loading={loading}
    />
  );
}
