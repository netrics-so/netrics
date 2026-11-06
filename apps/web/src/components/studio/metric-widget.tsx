"use client";

import { useRef } from "react";

import type {
  DeviceTileStatus,
  MetricAggregation,
  MetricPeriod,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  aggregationName,
  tileLabel,
  type Locale,
  type StudioPlacement,
} from "@netrics/domain";

import { Sparkline } from "@/components/sparkline";
import type { TileMetric, TileReading } from "@/components/tile-view";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  aggregationLabel,
  comparisonLabel,
  displayUnit,
  periodLabel,
  formatChange,
  formatCompactValue,
  formatValue,
} from "@/lib/format-metric";
import { footerLine, metricWidgetLayout, u } from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";
import { webTranslator, type WebTranslator } from "@/lib/i18n/catalogs";
import { connectionNotice, connectionStatus } from "@/lib/tile-status";

import { useCountUp } from "./enter-motion";
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
  /** How far the numbers can be trusted; default ok. */
  status?: DeviceTileStatus;
  /** The connection's name, under the numbers when there is room. */
  source: string | null;
  /** The data's last successful sync, for the footer; null: unknown. */
  updatedAt?: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  options: { showSparkline: boolean; showChange: boolean };
  loading?: boolean;
}

/** What a metric widget's numbers read, apart from the label. */
export interface MetricTexts {
  change: ReturnType<typeof formatChange>;
  /** The change with and without its comparison; null when not shown. */
  changeLine: {
    full: string;
    short: string;
    comparison: string | null;
  } | null;
  comparison: string;
  /** "Last 7 days · Total". */
  periodText: string;
  /** The value in full ("1,248"), "…" while loading, "—" without data. */
  full: string;
  /** The compact value ("1.2K"). */
  compact: string;
}

/**
 * The texts of a metric widget, shared by the slide renderer and the
 * scroll view card (ADR 0017, section 5).
 */
export function metricTexts(
  props: Pick<
    MetricWidgetViewProps,
    "reading" | "metric" | "period" | "aggregation" | "options" | "loading"
  >,
  locale: Locale,
  t: WebTranslator<"screen.widget">,
): MetricTexts {
  const { reading, metric, period } = props;
  const change = reading
    ? formatChange(
        reading.delta,
        reading.ratio,
        reading.unit,
        metric?.better ?? "higher",
        locale,
      )
    : null;
  const comparison = comparisonLabel(period, locale);
  const changeLine = !props.options.showChange
    ? null
    : !reading
      ? null
      : change
        ? {
            full: `${ARROWS[change.direction]} ${change.text} ${comparison}`,
            short: `${ARROWS[change.direction]} ${change.text}`,
            comparison,
          }
        : reading.value === null
          ? {
              full: t("noDataYet"),
              short: t("noDataShort"),
              comparison: null,
            }
          : {
              full: t("noComparison", { comparison }),
              short: t("noComparisonShort"),
              comparison: null,
            };
  const periodText = `${periodLabel(period, locale)} · ${
    metric
      ? aggregationLabel(props.aggregation, metric, locale)
      : aggregationName(props.aggregation, null, locale)
  }`;
  const approx = reading?.approximate && reading.value !== null ? "≈ " : "";
  const full = reading
    ? `${approx}${formatValue(reading.value, reading.unit, locale)}`
    : props.loading
      ? "…"
      : "—";
  const compact = reading
    ? `${approx}${formatCompactValue(reading.value, reading.unit, locale)}`
    : full;
  return { change, changeLine, comparison, periodText, full, compact };
}

/**
 * How a counting value is worded on every frame of the enter (ADR 0018
 * section 6): as the shown text is, in full or compact, with its "≈";
 * null when the shown text is neither (nothing counts then).
 */
export function countFormat(
  shown: string,
  texts: { full: string; compact: string },
  reading: { value: number | null; unit: string; approximate?: boolean } | null,
  locale: Locale,
): ((value: number) => string) | null {
  if (!reading || reading.value === null) return null;
  const approx = reading.approximate ? "≈ " : "";
  const { unit } = reading;
  if (shown === texts.full) {
    return (value) => `${approx}${formatValue(value, unit, locale)}`;
  }
  if (shown === texts.compact) {
    return (value) => `${approx}${formatCompactValue(value, unit, locale)}`;
  }
  return null;
}

/**
 * The metric widget: today's tile (label, value, change, sparkline) on the
 * studio grid, sized by studioLayout and coloured by the theme tokens.
 */
export function MetricWidgetView(props: MetricWidgetViewProps) {
  const { reading, period } = props;
  const locale = useLocale();
  const t = useT("screen.widget");
  const { change, changeLine, comparison, periodText, full, compact } =
    metricTexts(props, locale, t);
  const candidates = useFooterCandidates(props.updatedAt, props.source);
  // The footer takes the source line's slot; a notice replaces it.
  const footer = props.notice
    ? null
    : footerLine(candidates, {
        type: "metric",
        placement: props.placement,
        showHeader: props.showHeader,
        fontScale: props.fontScale,
      });
  const layout = metricWidgetLayout({
    label: props.label,
    value: { full, compact },
    periodText,
    change: changeLine,
    noticeText: props.notice,
    sourceText: footer,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
    showSparkline: props.options.showSparkline && reading !== null,
  });
  const valueRef = useRef<HTMLParagraphElement>(null);
  useCountUp(
    valueRef,
    reading?.value ?? null,
    countFormat(layout.value.text, { full, compact }, reading, locale),
    layout.value.text,
  );
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="metric"
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

  return (
    <article
      className={`sw sw-metric${statusClass(props.status)}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={layout.label} />
      {layout.showPeriod ? (
        <p className="sw-muted" style={{ fontSize: u(layout.sizes.small) }}>
          {periodText}
        </p>
      ) : null}
      {/* Between the label and the value (design 4a): only the order
          changes, the heights are the layout's. */}
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
      <p
        ref={valueRef}
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
      {layout.comparisonText ? (
        <p
          className="sw-muted sw-comparison-line"
          style={{ fontSize: u(layout.sizes.comparison) }}
        >
          {layout.comparisonText}
        </p>
      ) : null}
      {props.notice ? (
        <WidgetNotice
          size={layout.sizes.small}
          stale={props.status === "stale"}
        >
          {props.notice}
        </WidgetNotice>
      ) : null}
      {layout.showSource && footer ? (
        <WidgetFooter size={layout.sizes.small}>{footer}</WidgetFooter>
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
  locale: Locale = "en",
): string | null {
  if (error) {
    const t = webTranslator(locale, "screen.widget");
    return hasData ? t("refreshFailed") : t("couldNotLoad");
  }
  return stale;
}

/**
 * A live widget's notice and data status (signed-in views): the status by
 * the server's rule for screens from the connection's state; a failed
 * query keeps its notice in the warning style (as an outage), and a first
 * load in flight is not "no data" yet.
 */
export function liveDataState(
  query: {
    error: string | null;
    loading: boolean;
    /** A response arrived (it may have no value). */
    loaded: boolean;
    /** It has something to show (a value, a group). */
    hasData: boolean;
  },
  connection: Parameters<typeof connectionStatus>[0],
  locale: Locale,
  now: number = Date.now(),
): { notice: string | null; status: DeviceTileStatus } {
  const notice = dataNotice(
    query.error,
    query.loaded,
    connectionNotice(connection, now, locale),
    locale,
  );
  // A failed query or a removed connection keeps its notice, as an
  // outage does (no data surface in its place).
  const status: DeviceTileStatus =
    query.error || !connection
      ? "outage"
      : query.loading && !query.loaded
        ? "ok"
        : connectionStatus(connection, query.hasData, now);
  return { notice, status };
}

/** A metric widget's props apart from its placement on a slide. */
export type MetricReadingProps = Omit<
  MetricWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/**
 * A metric widget's live numbers (signed-in pages): queried and refreshed
 * every minute, for the slide renderer and the scroll view card alike.
 */
export function useLiveMetric(
  widget: Extract<DataWidget, { type: "metric" }>,
  env: StudioEnv,
): MetricReadingProps {
  const { data, error, loading } = useMetricData(env.workspaceId, widget);
  const locale = useLocale();
  const metric = env.metrics.get(metricKeyOf(widget));
  const connection = env.connections[widget.connectionId];
  const unit = displayUnit(
    data?.metric.unit ?? metric?.unit ?? "",
    data?.currency ?? widget.dimensions.currency,
  );
  return {
    label: dataWidgetLabel(widget, metric),
    period: widget.period,
    aggregation: widget.aggregation,
    metric: data?.metric ?? metric ?? null,
    reading: data
      ? {
          value: data.value,
          unit,
          delta: data.delta,
          ratio: data.ratio,
          series: data.series,
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
      connection,
      locale,
    ),
    source: connection?.name ?? null,
    updatedAt: connection?.state.lastSuccessAt ?? null,
    options: widget.options,
    loading,
  };
}

/** A metric widget that queries its own numbers (signed-in pages). */
export function LiveMetricWidget({
  widget,
  env,
}: {
  widget: Extract<DataWidget, { type: "metric" }>;
  env: StudioEnv;
}) {
  return (
    <MetricWidgetView
      {...useLiveMetric(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
