"use client";

import type { ReactNode } from "react";

import type {
  MetricAggregation,
  MetricPeriod,
  WorkspaceMetric,
} from "@netrics/contracts";

import { aggregationName } from "@netrics/domain";

import {
  aggregationLabel,
  comparisonLabel,
  formatChange,
  formatValue,
  periodLabel,
} from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";

import { Sparkline, type SparkPoint } from "./sparkline";

const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;

/** A tile's computed numbers, from the metric query or the device API. */
export interface TileReading {
  value: number | null;
  unit: string;
  delta: number | null;
  ratio: number | null;
  series: SparkPoint[];
  timeZone: string;
  /** Converted into a display currency (#191): shown with "≈". */
  approximate?: boolean;
}

/** What the tile needs to know about its metric, when known. */
export type TileMetric = Pick<
  WorkspaceMetric,
  "kind" | "granularity" | "better"
>;

/**
 * How a tile looks, given numbers someone else computed: the web dashboard
 * and its TV layout query them per tile, the kiosk gets them from the
 * device API (#59).
 */
export function TileView({
  label,
  period,
  aggregation,
  metric = null,
  reading,
  fallback,
  footer,
  note = null,
  busy = false,
  variant = "default",
}: {
  label: string;
  period: MetricPeriod;
  aggregation: MetricAggregation;
  /** Names a daily gauge's aggregation by day and colours a change. */
  metric?: TileMetric | null;
  reading: TileReading | null;
  /** Shown instead of the numbers while there are none. */
  fallback: ReactNode;
  footer: ReactNode;
  /** Under the value, e.g. where converted amounts come from (#191). */
  note?: ReactNode;
  busy?: boolean;
  /** "tv": sized by its grid cell for reading at a distance (#52). */
  variant?: "default" | "tv";
}) {
  const locale = useLocale();
  const t = useT("screen.widget");
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

  return (
    <article
      className={variant === "tv" ? "tile tile--tv" : "tile"}
      aria-busy={busy}
    >
      <header className="tile-header">
        <h3 className="tile-label">{label}</h3>
        <span className="tile-period">
          {periodLabel(period, locale)} ·{" "}
          {metric
            ? aggregationLabel(aggregation, metric, locale)
            : aggregationName(aggregation, null, locale)}
        </span>
      </header>

      {reading ? (
        <>
          <div className="tile-value">
            {reading.approximate && reading.value !== null ? (
              <span className="tile-approx" title={t("approximate")}>
                ≈{" "}
              </span>
            ) : null}
            {formatValue(reading.value, reading.unit, locale)}
          </div>
          {note}
          {change ? (
            <div className={`tile-change ${change.tone}`}>
              <span aria-hidden="true">{ARROWS[change.direction]}</span>{" "}
              {change.text}{" "}
              <span className="tile-comparison">{comparison}</span>
            </div>
          ) : (
            <div className="tile-change flat">
              <span className="tile-comparison">
                {reading.value === null
                  ? t("noDataYet")
                  : t("noComparison", { comparison })}
              </span>
            </div>
          )}
          <Sparkline
            series={reading.series}
            unit={reading.unit}
            period={period}
            timeZone={reading.timeZone}
          />
        </>
      ) : (
        fallback
      )}

      <footer className="tile-footer">{footer}</footer>
    </article>
  );
}

/** A warning in a tile's footer: the numbers may be out of date. */
export function TileNotice({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  const t = useT("screen.widget");
  return (
    <span className="tile-stale" title={title ?? t("mayBeOutdated")}>
      <span aria-hidden="true">⚠</span> {children}
    </span>
  );
}
