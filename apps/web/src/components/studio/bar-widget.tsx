"use client";

import type { StudioPlacement } from "@netrics/domain";

import { displayUnit, formatValue } from "@/lib/format-metric";
import { barLayout, type BarEntry } from "@/lib/studio-chart";
import { LINE_HEIGHT, chartWidgetLayout, u } from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";
import { connectionNotice } from "@/lib/tile-status";

import { dataNotice, dataWidgetLabel } from "./metric-widget";
import { useBreakdownData } from "./use-widget-data";
import { WidgetLabel, WidgetNotice } from "./widget-parts";

export interface BarReading {
  unit: string;
  groups: BarEntry[];
  others: BarEntry | null;
  approximate?: boolean;
}

export interface BarWidgetViewProps {
  label: string;
  reading: BarReading | null;
  notice: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  loading?: boolean;
}

/**
 * The bar widget: one metric by a dimension, largest first, then "Others".
 * Each bar's label (an app or country name) wraps to two lines and shrinks
 * to the minimum before anything is cut; when the bars do not fit, the
 * smallest groups join "Others".
 */
export function BarWidgetView(props: BarWidgetViewProps) {
  const { reading } = props;
  const layout = chartWidgetLayout({
    type: "bar",
    label: props.label,
    value: null,
    noticeText: props.notice,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
  });
  const approx = reading?.approximate ? "≈ " : "";
  const bars = reading
    ? barLayout({
        groups: reading.groups,
        others: reading.others,
        width: layout.chart.width,
        height: layout.chart.height,
        size: layout.sizes.resource,
        formatValue: (value) => `${approx}${formatValue(value, reading.unit)}`,
      })
    : null;

  return (
    <article className="sw sw-bar" aria-busy={props.loading ?? false}>
      <WidgetLabel layout={layout.label} />
      <div className="sw-chart" style={{ height: u(layout.chart.height) }}>
        {bars && bars.rows.length > 0 ? (
          <ol
            className="sw-bars"
            style={{ fontSize: u(bars.size), gap: u(bars.rowGap) }}
          >
            {bars.rows.map((row, index) => (
              <li
                key={`${index}:${row.label.text}`}
                className={row.others ? "sw-bar-row others" : "sw-bar-row"}
              >
                <span className="sw-bar-text">
                  <span
                    className="sw-bar-label"
                    style={{ maxHeight: u(2 * bars.size * LINE_HEIGHT) }}
                    title={row.label.truncated ? row.label.text : undefined}
                    data-truncated={row.label.truncated ? "true" : undefined}
                  >
                    {row.label.text}
                  </span>
                  <span
                    className="sw-bar-value"
                    style={{ minWidth: u(bars.valueWidth) }}
                  >
                    {row.valueText}
                  </span>
                </span>
                <span
                  className="sw-bar-track"
                  style={{ height: u(bars.barHeight), marginTop: u(4) }}
                >
                  <span
                    className="sw-bar-fill"
                    style={{ width: `${(row.ratio * 100).toFixed(2)}%` }}
                  />
                </span>
              </li>
            ))}
          </ol>
        ) : reading ? (
          <p className="sw-muted" style={{ fontSize: u(layout.sizes.small) }}>
            No data for this period yet
          </p>
        ) : (
          <p
            className="sw-value sw-placeholder"
            style={{ fontSize: u(layout.sizes.resource) }}
          >
            {props.loading ? "…" : "—"}
          </p>
        )}
      </div>
      {props.notice ? (
        <WidgetNotice size={layout.sizes.small}>{props.notice}</WidgetNotice>
      ) : null}
    </article>
  );
}

/** A bar widget that queries its own groups (signed-in pages). */
export function LiveBarWidget({
  widget,
  env,
}: {
  widget: Extract<DataWidget, { type: "bar" }>;
  env: StudioEnv;
}) {
  const { data, error, loading } = useBreakdownData(env.workspaceId, widget);
  const metric = env.metrics.get(metricKeyOf(widget));
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  return (
    <BarWidgetView
      label={dataWidgetLabel(widget, metric)}
      reading={
        data
          ? {
              unit,
              groups: data.groups.map((group) => ({
                label: group.label,
                value: group.value,
              })),
              others: data.others
                ? { label: data.others.label, value: data.others.value }
                : null,
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
      loading={loading}
    />
  );
}
