"use client";

import { useRef } from "react";

import type { DeviceTileStatus, MetricPeriod } from "@netrics/contracts";
import {
  amountCurrency,
  compareRatioUnit,
  ratioOf,
  type CompareFormat,
  type Locale,
  type StudioPlacement,
} from "@netrics/domain";

import {
  displayUnit,
  formatCompactValue,
  formatValue,
} from "@/lib/format-metric";
import { useLocale } from "@/lib/i18n/client";
import {
  compareFooterCandidates,
  compareRatioText,
  compareWidgetLayout,
  type CompareReading,
} from "@/lib/studio-compare";
import { footerLine, u } from "@/lib/studio-render";
import {
  metricKeyOf,
  type DataWidget,
  type StudioEnv,
} from "@/lib/studio-widgets";

import { useCountUp } from "./enter-motion";
import { dataWidgetLabel, liveDataState } from "./metric-widget";
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

export type CompareWidget = Extract<DataWidget, { type: "compare" }>;

export interface CompareWidgetViewProps {
  label: string;
  period: MetricPeriod;
  options: {
    format: CompareFormat;
    ratioLabel: string | null;
    showChange: boolean;
  };
  /** Null while loading, or when the first load failed. */
  reading: CompareReading | null;
  notice: string | null;
  /** How far the numbers can be trusted (the worse side's); default ok. */
  status?: DeviceTileStatus;
  /** The sources' names, for the footer; null: none to show. */
  source?: string | null;
  /** The older side's last successful sync, for the footer. */
  updatedAt?: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  loading?: boolean;
}

/** How a counting operand is worded on every frame, as its shown form. */
function operandCount(
  shown: string,
  operand: { value: number | null; unit: string } | undefined,
  locale: Locale,
): ((value: number) => string) | null {
  if (!operand || operand.value === null) return null;
  const { unit } = operand;
  if (shown === formatValue(operand.value, unit, locale)) {
    return (value) => formatValue(value, unit, locale);
  }
  if (shown === formatCompactValue(operand.value, unit, locale)) {
    return (value) => formatCompactValue(value, unit, locale);
  }
  return null;
}

/**
 * The compare widget (ADR 0019 section 10, design 4b): two metrics side by
 * side with "/" between them and their captions, then the ratio in the
 * chart colour with its label and change, and "derived · updated …".
 * Operands and the ratio count up on slide enter.
 */
export function CompareWidgetView(props: CompareWidgetViewProps) {
  const locale = useLocale();
  const candidates = useFooterCandidates(props.updatedAt, props.source);
  const layout = compareWidgetLayout({
    label: props.label,
    period: props.period,
    options: props.options,
    reading: props.reading,
    loading: props.loading ?? false,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
    locale,
  });
  const { compare } = layout;
  const { reading } = props;
  const { sizes } = compare;
  const numeratorRef = useRef<HTMLSpanElement>(null);
  const denominatorRef = useRef<HTMLSpanElement>(null);
  const ratioRef = useRef<HTMLSpanElement>(null);
  useCountUp(
    numeratorRef,
    reading?.numerator.value ?? null,
    operandCount(layout.numerator.text, reading?.numerator, locale),
    layout.numerator.text,
  );
  useCountUp(
    denominatorRef,
    reading?.denominator.value ?? null,
    operandCount(layout.denominator.text, reading?.denominator, locale),
    layout.denominator.text,
  );
  useCountUp(
    ratioRef,
    reading?.ratio.value ?? null,
    reading
      ? (value) =>
          compareRatioText(value, props.options.format, reading.unit, locale)
      : null,
    layout.ratio,
  );
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="compare"
        surface={surface}
        label={layout.label}
        small={sizes.small}
        source={props.source}
        updatedAt={props.updatedAt}
        placement={props.placement}
        showHeader={props.showHeader}
        fontScale={props.fontScale}
      />
    );
  }
  const footer =
    props.notice || !compare.showFooter
      ? null
      : footerLine(compareFooterCandidates(candidates, locale), {
          type: "compare",
          placement: props.placement,
          showHeader: props.showHeader,
          fontScale: props.fontScale,
        });
  const placeholder = reading ? "" : " sw-placeholder";
  const rest = (
    <>
      <span className="sw-compare-ratio-label">{layout.ratioLabel}</span>
      {layout.change ? (
        <span
          className={`sw-compare-change sw-change${layout.change.tone === "neutral" ? "" : ` ${layout.change.tone}`}`}
        >
          {layout.change.text}
        </span>
      ) : null}
    </>
  );

  return (
    <article
      className={`sw sw-compare${statusClass(props.status)}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={layout.label} />
      {compare.showPeriod ? (
        <p
          className="sw-muted sw-compare-period"
          style={{ fontSize: u(sizes.small) }}
        >
          {layout.period}
        </p>
      ) : null}
      <div className="sw-compare-body">
        <div
          className="sw-compare-operands"
          style={{ columnGap: u(24), fontSize: u(sizes.operand) }}
        >
          <span className="sw-compare-operand">
            <span
              ref={numeratorRef}
              className={`sw-value sw-compare-number${placeholder}`}
            >
              {layout.numerator.text}
            </span>
            <span
              className="sw-muted sw-compare-caption"
              style={{
                fontSize: u(sizes.caption),
                maxWidth: u(compare.captionWidth),
              }}
            >
              {layout.numerator.caption}
            </span>
          </span>
          <span className="sw-compare-separator" aria-hidden="true">
            /
          </span>
          <span className="sw-compare-operand">
            <span
              ref={denominatorRef}
              className={`sw-value sw-compare-number${placeholder}`}
            >
              {layout.denominator.text}
            </span>
            <span
              className="sw-muted sw-compare-caption"
              style={{
                fontSize: u(sizes.caption),
                maxWidth: u(compare.captionWidth),
              }}
            >
              {layout.denominator.caption}
            </span>
          </span>
        </div>
        <div
          className={`sw-compare-ratio-row sw-compare-ratio-row--${compare.ratioLine}`}
          style={{ fontSize: u(sizes.change), columnGap: u(16) }}
        >
          <span
            ref={ratioRef}
            className={`sw-value sw-compare-ratio${placeholder}`}
            style={{ fontSize: u(sizes.ratio) }}
          >
            {layout.ratio}
          </span>
          {compare.ratioLine === "beside" ? (
            rest
          ) : (
            <span className="sw-compare-ratio-below">{rest}</span>
          )}
        </div>
      </div>
      {props.notice ? (
        <WidgetNotice size={sizes.small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : footer ? (
        <WidgetFooter size={sizes.small}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** A compare widget's props apart from its placement on a slide. */
export type CompareReadingProps = Omit<
  CompareWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/** The worse of two statuses, as the server ranks them for screens. */
const SEVERITY: readonly DeviceTileStatus[] = [
  "ok",
  "stale",
  "backfilling",
  "no_data",
  "outage",
  "auth_failed",
];

export function worseStatus(
  a: DeviceTileStatus,
  b: DeviceTileStatus,
): DeviceTileStatus {
  return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;
}

/** The older of two sync times; null when either side never synced. */
export function olderSync(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/**
 * A compare widget's live numbers (signed-in pages): the numerator's and
 * the denominator's metric queries, and their ratio by `ratioOf`, now and
 * over the previous period, as the device payload computes it.
 */
export function useLiveCompare(
  widget: CompareWidget,
  env: StudioEnv,
): CompareReadingProps {
  const locale = useLocale();
  const denominatorWidget = {
    ...widget,
    connectionId: widget.denominator.connectionId,
    metricKey: widget.denominator.metricKey,
    aggregation: widget.denominator.aggregation,
    dimensions: widget.denominator.dimensions,
  };
  const a = useMetricData(env.workspaceId, widget);
  const b = useMetricData(env.workspaceId, denominatorWidget);
  const metricA = env.metrics.get(metricKeyOf(widget));
  const metricB = env.metrics.get(metricKeyOf(denominatorWidget));
  const unitA = displayUnit(
    a.data?.metric.unit ?? metricA?.unit ?? "",
    a.data?.currency ?? widget.dimensions.currency,
  );
  const unitB = displayUnit(
    b.data?.metric.unit ?? metricB?.unit ?? "",
    b.data?.currency ?? widget.denominator.dimensions.currency,
  );
  const connectionA = env.connections[widget.connectionId];
  const connectionB = env.connections[widget.denominator.connectionId];
  const sideA = liveDataState(
    {
      error: a.error,
      loading: a.loading,
      loaded: a.data !== null,
      hasData: a.data !== null && a.data.value !== null,
    },
    connectionA,
    locale,
  );
  const sideB = liveDataState(
    {
      error: b.error,
      loading: b.loading,
      loaded: b.data !== null,
      hasData: b.data !== null && b.data.value !== null,
    },
    connectionB,
    locale,
  );
  // Amounts over amounts have a ratio only in one currency.
  const currencyA = amountCurrency(unitA);
  const currencyB = amountCurrency(unitB);
  const comparable =
    currencyB === null || (currencyA !== null && currencyA === currencyB);
  const loaded = a.data !== null && b.data !== null;
  const sources = [connectionA?.name, connectionB?.name].filter(
    (name, index, all): name is string =>
      typeof name === "string" && all.indexOf(name) === index,
  );
  return {
    label: dataWidgetLabel(widget, metricA),
    period: widget.period,
    options: widget.options,
    reading: loaded
      ? {
          numerator: {
            label: a.data!.metric.name,
            value: a.data!.value,
            unit: unitA,
          },
          denominator: {
            label: b.data!.metric.name,
            value: b.data!.value,
            unit: unitB,
          },
          ratio: {
            value: comparable ? ratioOf(a.data!.value, b.data!.value) : null,
            previousValue: comparable
              ? ratioOf(a.data!.previousValue, b.data!.previousValue)
              : null,
          },
          unit: compareRatioUnit(unitA, unitB),
          better: a.data!.metric.better,
        }
      : null,
    notice: sideA.notice ?? sideB.notice,
    status: worseStatus(sideA.status, sideB.status),
    source: sources.join(" · ") || null,
    updatedAt: olderSync(
      connectionA?.state.lastSuccessAt ?? null,
      connectionB?.state.lastSuccessAt ?? null,
    ),
    loading: a.loading || b.loading,
  };
}

/** A compare widget that queries its own numbers (signed-in pages). */
export function LiveCompareWidget({
  widget,
  env,
}: {
  widget: CompareWidget;
  env: StudioEnv;
}) {
  return (
    <CompareWidgetView
      {...useLiveCompare(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
