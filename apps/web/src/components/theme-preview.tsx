"use client";

import {
  comparisonLabel,
  othersLabel,
  periodLabel,
  type ThemeTokens,
} from "@netrics/domain";

import { formatValue } from "@/lib/format-metric";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";
import { themeStyle } from "@/lib/studio-theme";

// A sample slide in a theme (#216): a metric, a line and a bar widget on the
// theme's canvas, so the editor shows what a TV would. Sample numbers only;
// the real widget renderers come with #220.

/** The sample app (a product name: the same in every language). */
const SAMPLE_APP = "Wurfel";

const LINE = [42, 48, 45, 53, 58, 55, 63, 61, 70, 74, 69, 80];
const PREVIOUS = [38, 40, 44, 41, 47, 49, 46, 52, 50, 55, 57, 54];
const BARS: Array<[string | null, number]> = [
  ["Wurfel", 812],
  ["voilà", 604],
  ["Paperstand", 377],
  [null, 129],
];

/** The sample's "now": its widget was updated three hours before. */
const SAMPLE_NOW = Date.parse("2026-10-04T09:41:00Z");

/** A sample axis date, in the viewer's language. */
function axisDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function points(values: number[], width: number, height: number): string {
  const max = 90;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function ThemePreview({
  tokens,
  accent,
}: {
  tokens: ThemeTokens;
  /** A brand accent that overrides the theme's. */
  accent?: string | null;
}) {
  const locale = useLocale();
  const t = useT("themePreview");
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(value);
  const style = themeStyle(accent ? { ...tokens, accent } : tokens);
  const spark = points(LINE.slice(-8), 100, 30);
  const line = points(LINE, 300, 110);
  const previous = points(PREVIOUS, 300, 110);
  const barMax = BARS[0]![1];
  return (
    <div
      className="theme-preview"
      style={style}
      role="img"
      aria-label={t("label")}
    >
      <div className="theme-preview-header">
        <span className="theme-preview-title">{SAMPLE_APP}</span>
        <span className="theme-preview-clock">09:41</span>
      </div>
      <div className="theme-preview-grid">
        <div className="theme-preview-widget theme-preview-metric">
          <span className="tp-label">
            {t("downloads")} · {SAMPLE_APP}
          </span>
          <span className="tp-muted">{periodLabel("last_7_days", locale)}</span>
          <span className="tp-value">
            {formatValue(12_480, "downloads", locale)}
          </span>
          <span className="tp-up">
            ▲ +{percent(0.082)} {comparisonLabel("last_7_days", locale)}
          </span>
          <svg
            viewBox="-2 -2 104 34"
            preserveAspectRatio="none"
            className="tp-spark"
            aria-hidden="true"
          >
            <polyline points={spark} />
          </svg>
        </div>
        <div className="theme-preview-widget theme-preview-metric">
          <span className="tp-label">{t("proceeds")}</span>
          <span className="tp-muted">{periodLabel("this_month", locale)}</span>
          <span className="tp-value">
            {formatValue(391_200, "EUR_minor", locale)}
          </span>
          <span className="tp-down">
            ▼ −{percent(0.041)} {comparisonLabel("this_month", locale)}
          </span>
          <span className="tp-warning">
            {t("updated", {
              time: relativeTime("2026-10-04T06:41:00Z", locale, SAMPLE_NOW),
            })}
          </span>
        </div>
        <div className="theme-preview-widget theme-preview-line">
          <span className="tp-label">{t("clicks")}</span>
          <svg viewBox="0 0 300 130" className="tp-chart" aria-hidden="true">
            <polygon className="tp-area" points={`0,110 ${line} 300,110`} />
            <polyline className="tp-previous" points={previous} />
            <polyline className="tp-line" points={line} />
            <line className="tp-axis" x1="0" y1="110" x2="300" y2="110" />
            <text className="tp-axis-label" x="0" y="128">
              {axisDate("2026-09-22", locale)}
            </text>
            <text className="tp-axis-label" x="300" y="128" textAnchor="end">
              {axisDate("2026-10-03", locale)}
            </text>
          </svg>
        </div>
        <div className="theme-preview-widget theme-preview-bar">
          <span className="tp-label">{t("downloadsByApp")}</span>
          <ul className="tp-bars">
            {BARS.map(([label, value]) => (
              <li key={label ?? "others"}>
                <span className="tp-bar-label">
                  {label ?? othersLabel(locale)}
                </span>
                <span className="tp-bar-track">
                  <span
                    className="tp-bar"
                    style={{ width: `${(value / barMax) * 100}%` }}
                  />
                </span>
                <span className="tp-bar-value">
                  {formatValue(value, "downloads", locale)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
