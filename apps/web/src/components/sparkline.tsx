"use client";

import { useRef, useState, type PointerEvent } from "react";

import type { MetricPeriod } from "@netrics/contracts";

import { formatValue, sparkBucketLabel } from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";
import { useElementSize } from "@/lib/use-screen";

export interface SparkPoint {
  /** The bucket's start; absent when only the values are known (devices). */
  bucket?: string;
  value: number | null;
}

/** The drawing's size until the plot is measured (server render). */
const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 40;
const PAD = 3;

/**
 * A tile's trend: the current period, one point per bucket. Gaps where a
 * bucket has no data; the latest value is marked in the accent colour.
 */
export function Sparkline({
  series,
  unit,
  period,
  timeZone,
}: {
  series: SparkPoint[];
  unit: string;
  /** Which points the series has: hours, days, weeks or months. */
  period: MetricPeriod;
  timeZone: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  // Measured, the viewBox is the plot's own size in pixels: strokes keep
  // their widths without non-scaling-stroke, which a dash offset drawn
  // over pathLength (the enter, ADR 0018 section 6) cannot be combined
  // with. Until then, the stretched default.
  const measured = useElementSize(plot);
  const WIDTH = measured?.width ?? DEFAULT_WIDTH;
  const HEIGHT = measured?.height ?? DEFAULT_HEIGHT;
  const scaling = measured ? undefined : "non-scaling-stroke";
  const locale = useLocale();
  const t = useT("screen.widget");
  const values = series
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
  if (series.length < 2 || values.length === 0) {
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) =>
    PAD + (index / (series.length - 1)) * (WIDTH - 2 * PAD);
  const y = (value: number) =>
    HEIGHT - PAD - ((value - min) / span) * (HEIGHT - 2 * PAD);

  // Break the line at empty buckets instead of bridging them.
  const segments: string[] = [];
  let current = "";
  series.forEach((point, index) => {
    if (point.value === null) {
      if (current) {
        segments.push(current);
      }
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`;
  });
  if (current) {
    segments.push(current);
  }

  let lastIndex = series.length - 1;
  while (lastIndex > 0 && series[lastIndex]!.value === null) {
    lastIndex -= 1;
  }
  const last = series[lastIndex]!;

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(
      Math.max(
        0,
        Math.min(series.length - 1, Math.round(ratio * (series.length - 1))),
      ),
    );
  }

  const hovered = hover === null ? null : series[hover]!;
  const lastLabel = sparkBucketLabel(last.bucket, period, timeZone, locale);
  const trend = {
    min: formatValue(min, unit, locale),
    max: formatValue(max, unit, locale),
    latest: formatValue(last.value, unit, locale),
  };
  const summary = lastLabel
    ? t("trendAt", { ...trend, date: lastLabel })
    : t("trend", trend);
  const hoveredLabel = hovered
    ? sparkBucketLabel(hovered.bucket, period, timeZone, locale)
    : null;

  return (
    <div className="sparkline">
      <div className="sparkline-plot" ref={plot}>
        <svg
          viewBox={`0 0 ${round(WIDTH)} ${round(HEIGHT)}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={summary}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {hover !== null ? (
            <line
              className="sparkline-hairline"
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={HEIGHT}
              vectorEffect={scaling}
            />
          ) : null}
          {segments.map((d) => (
            <path
              key={d}
              className="sparkline-line"
              d={d}
              vectorEffect={scaling}
              pathLength={measured ? 100 : undefined}
            />
          ))}
        </svg>
        {last.value !== null ? (
          // HTML, not SVG: a stretched viewBox would draw an ellipse.
          <span
            className="sparkline-last"
            style={{
              left: `${(x(lastIndex) / WIDTH) * 100}%`,
              top: `${(y(last.value) / HEIGHT) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <div className="sparkline-readout" aria-hidden="true">
        {hovered
          ? `${hoveredLabel ? `${hoveredLabel}: ` : ""}${formatValue(hovered.value, unit, locale)}`
          : " "}
      </div>
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
