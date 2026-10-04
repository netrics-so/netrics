"use client";

import { useRef } from "react";

import type { DeviceTileStatus, MetricPeriod } from "@netrics/contracts";
import { othersLabel, type StudioPlacement } from "@netrics/domain";

import { displayUnit } from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";
import { footerLine, u } from "@/lib/studio-render";
import { tableWidgetLayout, type TableReading } from "@/lib/studio-table";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";

import { useRowRise } from "./enter-motion";
import { dataWidgetLabel, liveDataState } from "./metric-widget";
import { useBreakdownData } from "./use-widget-data";
import {
  DataStateWidget,
  WidgetFooter,
  WidgetLabel,
  WidgetNotice,
  dataSurfaceOf,
  statusClass,
  useFooterCandidates,
} from "./widget-parts";

export type TableWidget = Extract<DataWidget, { type: "table" }>;

export interface TableWidgetViewProps {
  label: string;
  period: MetricPeriod;
  options: { limit: number; showChange: boolean; showOthers: boolean };
  reading: TableReading | null;
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
  loading?: boolean;
}

/**
 * The table widget (ADR 0019 section 6): one metric by a dimension,
 * largest first, with the change per row. The column heads, then as many
 * rows as fit (the subtitle says how many); row labels shrink to 24 units
 * and only then end with an ellipsis; values are never cut (the compact
 * form first). Rows rise into place on slide enter.
 */
export function TableWidgetView(props: TableWidgetViewProps) {
  const locale = useLocale();
  const t = useT("screen.widget");
  const rowsRef = useRef<HTMLOListElement>(null);
  useRowRise(rowsRef);
  const candidates = useFooterCandidates(props.updatedAt, props.source);
  const layout = tableWidgetLayout({
    label: props.label,
    period: props.period,
    limit: props.options.limit,
    showChange: props.options.showChange,
    reading: props.reading,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
    locale,
  });
  const { table } = layout;
  const small = table.sizes.subtitle;
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="table"
        surface={surface}
        label={layout.label}
        small={small}
        source={props.source}
        updatedAt={props.updatedAt}
        placement={props.placement}
        showHeader={props.showHeader}
        fontScale={props.fontScale}
      />
    );
  }
  const footer = props.notice
    ? null
    : footerLine(candidates, {
        type: "table",
        placement: props.placement,
        showHeader: props.showHeader,
        fontScale: props.fontScale,
      });
  const columns = {
    gridTemplateColumns: [
      "minmax(0, 1fr)",
      u(table.columns.value),
      ...(props.options.showChange ? [u(table.columns.change)] : []),
    ].join(" "),
    columnGap: u(table.columns.gap),
  };
  const reading = props.reading;

  return (
    <article
      className={`sw sw-table${statusClass(props.status)}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={layout.label} />
      <p className="sw-muted sw-table-subtitle" style={{ fontSize: u(small) }}>
        {layout.subtitle}
      </p>
      {reading && layout.rows.length > 0 ? (
        <>
          <div
            className="sw-table-head"
            style={{ ...columns, fontSize: u(table.sizes.columnHead) }}
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
            ref={rowsRef}
            className="sw-table-rows"
            style={{ fontSize: u(table.sizes.cell) }}
          >
            {layout.rows.map((row, index) => (
              <li
                key={`${index}:${row.label}`}
                className={row.others ? "sw-table-row others" : "sw-table-row"}
                data-rise={index}
                style={{
                  ...columns,
                  height: u(table.rowPitch),
                  lineHeight: u(table.sizes.cell * 1.15),
                  paddingTop: u(table.rowPitch - table.sizes.cell * 1.15),
                }}
              >
                <span
                  className="sw-table-label"
                  style={{ fontSize: u(row.labelSize) }}
                  title={row.truncated ? row.label : undefined}
                  data-truncated={row.truncated ? "true" : undefined}
                >
                  {row.label}
                </span>
                <span className="sw-table-value">{row.value}</span>
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
        </>
      ) : reading ? (
        <p className="sw-muted" style={{ fontSize: u(small) }}>
          {t("noDataYet")}
        </p>
      ) : (
        <p
          className="sw-value sw-placeholder"
          style={{ fontSize: u(table.sizes.cell) }}
        >
          {props.loading ? "…" : "—"}
        </p>
      )}
      {props.notice ? (
        <WidgetNotice size={small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** A table widget's props apart from its placement on a slide. */
export type TableReadingProps = Omit<
  TableWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/** A table widget's live rows, for the slide and the scroll view. */
export function useLiveTable(
  widget: TableWidget,
  env: StudioEnv,
): TableReadingProps {
  const { data, error, loading } = useBreakdownData(env.workspaceId, widget);
  const locale = useLocale();
  const metric = env.metrics.get(metricKeyOf(widget));
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  const others =
    widget.options.showOthers && data?.others
      ? { label: othersLabel(locale), value: data.others.value }
      : null;
  return {
    label: dataWidgetLabel(widget, metric),
    period: widget.period,
    options: widget.options,
    reading: data
      ? {
          unit,
          better: data.metric.better,
          columns: { label: data.groupByName, value: data.metric.name },
          rows: data.groups.map((group) => ({
            label: group.label,
            value: group.value,
            previousValue: group.previousValue ?? null,
            ratio: group.ratio ?? null,
          })),
          others,
          approximate: data.conversion !== null,
        }
      : null,
    ...liveDataState(
      {
        error,
        loading,
        loaded: data !== null,
        hasData: data !== null && (data.groups.length > 0 || others !== null),
      },
      env.connections[widget.connectionId],
      locale,
    ),
    source: env.connections[widget.connectionId]?.name ?? null,
    updatedAt:
      env.connections[widget.connectionId]?.state.lastSuccessAt ?? null,
    loading,
  };
}

/** A table widget that queries its own rows (signed-in pages). */
export function LiveTableWidget({
  widget,
  env,
}: {
  widget: TableWidget;
  env: StudioEnv;
}) {
  return (
    <TableWidgetView
      {...useLiveTable(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
