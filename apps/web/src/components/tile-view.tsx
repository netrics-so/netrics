"use client";

import type { ReactNode } from "react";

import type { MetricAggregation, MetricPeriod } from "@netrics/contracts";

import {
  AGGREGATION_LABELS,
  COMPARISON_LABELS,
  PERIOD_LABELS,
  formatChange,
  formatValue,
} from "@/lib/format-metric";

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
}

/**
 * How a tile looks, given numbers someone else computed: the web dashboard
 * and its TV layout query them per tile, the kiosk gets them from the
 * device API (#59).
 */
export function TileView({
  label,
  period,
  aggregation,
  reading,
  fallback,
  footer,
  busy = false,
  variant = "default",
}: {
  label: string;
  period: MetricPeriod;
  aggregation: MetricAggregation;
  reading: TileReading | null;
  /** Shown instead of the numbers while there are none. */
  fallback: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  /** "tv": sized by its grid cell for reading at a distance (#52). */
  variant?: "default" | "tv";
}) {
  const change = reading
    ? formatChange(reading.delta, reading.ratio, reading.unit)
    : null;

  return (
    <article
      className={variant === "tv" ? "tile tile--tv" : "tile"}
      aria-busy={busy}
    >
      <header className="tile-header">
        <h3 className="tile-label">{label}</h3>
        <span className="tile-period">
          {PERIOD_LABELS[period]} · {AGGREGATION_LABELS[aggregation]}
        </span>
      </header>

      {reading ? (
        <>
          <div className="tile-value">
            {formatValue(reading.value, reading.unit)}
          </div>
          {change ? (
            <div className={`tile-change ${change.direction}`}>
              <span aria-hidden="true">{ARROWS[change.direction]}</span>{" "}
              {change.text}{" "}
              <span className="tile-comparison">
                {COMPARISON_LABELS[period]}
              </span>
            </div>
          ) : (
            <div className="tile-change flat">
              <span className="tile-comparison">
                {reading.value === null
                  ? "No data for this period yet"
                  : `No data to compare ${COMPARISON_LABELS[period]}`}
              </span>
            </div>
          )}
          <Sparkline
            series={reading.series}
            unit={reading.unit}
            hourly={period === "today"}
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
  title = "The numbers may be out of date",
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="tile-stale" title={title}>
      <span aria-hidden="true">⚠</span> {children}
    </span>
  );
}
