"use client";

import { useRef, type CSSProperties, type RefObject } from "react";

import type { DeviceTileStatus } from "@netrics/contracts";
import { wrappedLineCount, type StudioPlacement } from "@netrics/domain";

import { displayUnit } from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  gaugeCountFormat,
  gaugeLabel,
  gaugeTexts,
  gaugeWidgetLayout,
  type GaugeReading,
  type GaugeWidget,
} from "@/lib/studio-gauge";
import { u } from "@/lib/studio-render";
import type { StudioEnv } from "@/lib/studio-widgets";

import { useNow } from "./clock-widget";
import { useCountUp } from "./enter-motion";
import { liveDataState } from "./metric-widget";
import { useGoalData } from "./use-widget-data";
import {
  DataStateWidget,
  WidgetFooter,
  WidgetLabel,
  WidgetNotice,
  dataSurfaceOf,
  statusClass,
  useFooterCandidates,
} from "./widget-parts";

export interface GaugeWidgetViewProps {
  label: string;
  /** The goal was deleted: "Goal deleted" instead of the ring. */
  deleted: boolean;
  /** Null while loading, without data, or when the first load failed. */
  reading: GaugeReading | null;
  options: { showTimeLeft: boolean };
  notice: string | null;
  /** How far the numbers can be trusted; default ok. */
  status?: DeviceTileStatus;
  /** The connection's name, for the footer; null: none to show. */
  source?: string | null;
  /** The data's last successful sync, for the footer; null: unknown. */
  updatedAt?: string | null;
  /** The zone the goal's period is in: the workspace's. */
  timeZone: string;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  loading?: boolean;
}

/**
 * A full ring from 12 o'clock, track in the theme's border colour and the
 * fill in its chart line colour with round caps (ADR 0019 section 5); the
 * value centred inside. The fill draws on slide enter (`--enter-p`), its
 * end cap once the draw completes.
 */
export function GaugeRing({
  diameter,
  stroke,
  fill,
  value,
  valueRef,
  valueSize,
  suffix,
  suffixSize,
  placeholder,
}: {
  diameter: number;
  stroke: number;
  fill: number;
  value: string;
  valueRef: RefObject<HTMLSpanElement | null>;
  valueSize: number;
  suffix: string | null;
  suffixSize: number;
  placeholder: boolean;
}) {
  const center = diameter / 2;
  const radius = Math.max(0, (diameter - stroke) / 2);
  return (
    <div
      className="sw-gauge-ring"
      style={{ width: u(diameter), height: u(diameter) }}
    >
      <svg
        viewBox={`0 0 ${diameter} ${diameter}`}
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <circle
          className="sw-gauge-track"
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
        />
        {fill > 0 ? (
          <circle
            className="sw-gauge-fill"
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={stroke}
            pathLength={100}
            transform={`rotate(-90 ${center} ${center})`}
            style={{ "--gauge-p": (fill * 100).toFixed(3) } as CSSProperties}
          />
        ) : null}
      </svg>
      <p
        className={
          placeholder
            ? "sw-value sw-gauge-value sw-placeholder"
            : "sw-value sw-gauge-value"
        }
        style={{ fontSize: u(valueSize) }}
      >
        <span ref={valueRef}>{value}</span>
        {suffix ? (
          <span
            className="sw-gauge-suffix"
            style={{ fontSize: u(suffixSize), marginLeft: u(suffixSize * 0.1) }}
          >
            {suffix}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The goal widget (ADR 0019 section 5): the label, the target line, a full
 * ring with the percent (rounded down) inside, the progress line ("2,520
 * to go · 9 days left") and the footer; once the goal is reached the value
 * inside and "✓ Reached · 122% · 2 days early", in the theme's `up` on a
 * surface tinted towards it (never on stale data). A deleted goal shows
 * "Goal deleted". The ring draws and the number counts up on slide enter.
 */
export function GaugeWidgetView(props: GaugeWidgetViewProps) {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow();
  const candidates = useFooterCandidates(props.updatedAt, props.source);
  const texts = props.reading
    ? gaugeTexts(props.reading, props.options, now, props.timeZone, locale)
    : null;
  const layout = gaugeWidgetLayout({
    label: props.label,
    texts,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
  });
  const { gauge } = layout;
  const shown = texts
    ? gauge.compact
      ? texts.value.compact
      : texts.value.full
    : props.loading
      ? "…"
      : "—";
  const valueRef = useRef<HTMLSpanElement>(null);
  const reading = props.reading;
  const counting = gaugeCountFormat(texts, shown, reading, locale);
  useCountUp(valueRef, texts?.count ?? null, counting, shown);

  if (props.deleted) {
    return (
      <article className="sw sw-gauge sw--empty sw-gauge--deleted">
        <WidgetLabel layout={layout.label} />
        <div className="sw-state">
          <p
            className="sw-muted sw-gauge-deleted"
            style={{ fontSize: u(gauge.sizes.title) }}
          >
            {t("goalDeleted")}
          </p>
          <p
            className="sw-muted sw-state-hint"
            style={{ fontSize: u(gauge.sizes.footer) }}
          >
            {t("goalDeletedHint")}
          </p>
        </div>
      </article>
    );
  }
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="gauge"
        surface={surface}
        label={layout.label}
        small={gauge.sizes.footer}
        source={props.source}
        updatedAt={props.updatedAt}
        placement={props.placement}
        showHeader={props.showHeader}
        fontScale={props.fontScale}
      />
    );
  }
  // The footer only where the layout keeps room for it, on one line.
  const footer =
    !props.notice && gauge.showFooter
      ? (candidates.find(
          (text) =>
            wrappedLineCount(text, gauge.textWidth, gauge.sizes.footer) <= 1,
        ) ?? null)
      : null;
  const reached = texts?.reached === true && props.status !== "stale";
  const side = gauge.orientation === "side";
  const ring = (
    <GaugeRing
      diameter={gauge.ring.diameter}
      stroke={gauge.ring.stroke}
      fill={texts?.fill ?? 0}
      value={shown}
      valueRef={valueRef}
      valueSize={gauge.sizes.value}
      suffix={texts?.suffix ?? null}
      suffixSize={gauge.sizes.suffix}
      placeholder={texts === null}
    />
  );
  const progressText =
    texts?.progress ||
    (reading === null && !props.loading && !props.notice
      ? t("noDataShort")
      : "");
  const progress = (
    <p
      className={
        reached
          ? "sw-gauge-progress sw-gauge-progress--reached"
          : "sw-gauge-progress"
      }
      style={{ fontSize: u(gauge.sizes.progress) }}
    >
      {progressText}
    </p>
  );
  const bottom = props.notice ? (
    <WidgetNotice size={gauge.sizes.footer} stale={props.status === "stale"}>
      {props.notice}
    </WidgetNotice>
  ) : footer ? (
    <WidgetFooter size={gauge.sizes.footer}>{footer}</WidgetFooter>
  ) : null;
  const target =
    gauge.showTarget && texts ? (
      <p
        className="sw-muted sw-gauge-target"
        style={{ fontSize: u(gauge.sizes.target) }}
      >
        {texts.target}
      </p>
    ) : null;

  return (
    <article
      className={`sw sw-gauge sw-gauge--${gauge.orientation}${statusClass(props.status)}${reached ? " sw-gauge--reached" : ""}`}
      aria-busy={props.loading ?? false}
      style={
        side
          ? {
              gridTemplateColumns: `minmax(0, 1fr) ${u(gauge.ring.diameter)}`,
              columnGap: u(16),
            }
          : undefined
      }
    >
      {side ? (
        <>
          <div className="sw-gauge-text">
            <WidgetLabel layout={layout.label} />
            {target}
            {progress}
            {bottom}
          </div>
          {ring}
        </>
      ) : (
        <>
          <WidgetLabel layout={layout.label} />
          {target}
          {ring}
          {progress}
          {bottom}
        </>
      )}
    </article>
  );
}

/** A goal widget's props apart from its placement on a slide. */
export type GaugeReadingProps = Omit<
  GaugeWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/**
 * A goal widget's live numbers (signed-in pages): its goal with the
 * current progress from the Goals API (the same numbers screens get),
 * refreshed every minute.
 */
export function useLiveGauge(
  widget: GaugeWidget,
  env: StudioEnv,
): GaugeReadingProps {
  const locale = useLocale();
  const {
    data: goal,
    error,
    loading,
  } = useGoalData(env.workspaceId, widget.goalId);
  const deleted =
    widget.goalId === null || (goal === null && !loading && !error);
  const metric = goal
    ? env.metrics.get(`${goal.connectionId}|${goal.metricKey}`)
    : undefined;
  const connection = goal ? env.connections[goal.connectionId] : undefined;
  const current = goal?.current ?? null;
  const reading: GaugeReading | null =
    goal && current
      ? {
          period: goal.period,
          value: current.value,
          target: current.target,
          progress: current.progress,
          reachedAt: current.reachedAt,
          periodEnd: current.periodEnd,
          unit: displayUnit(
            metric?.unit ?? "",
            current.currency ?? goal.dimensions.currency,
          ),
          approximate: current.approximate,
        }
      : null;
  return {
    label: gaugeLabel(
      { title: widget.title, goalName: goal?.name ?? widget.goalName },
      locale,
    ),
    deleted,
    reading,
    options: widget.options,
    // Until the goal arrives there is no connection to judge by.
    ...(goal || error
      ? liveDataState(
          {
            error,
            loading,
            loaded: goal !== null,
            hasData: reading !== null && reading.value !== null,
          },
          connection,
          locale,
        )
      : { notice: null, status: "ok" as const }),
    source: connection?.name ?? null,
    updatedAt: connection?.state.lastSuccessAt ?? null,
    timeZone: env.timeZone,
    loading,
  };
}

/** A goal widget that loads its own goal (signed-in pages). */
export function LiveGaugeWidget({
  widget,
  env,
}: {
  widget: GaugeWidget;
  env: StudioEnv;
}) {
  return (
    <GaugeWidgetView
      {...useLiveGauge(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
