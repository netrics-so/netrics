import type { ThemeTokens } from "@netrics/domain";

import { themeStyle } from "@/lib/studio-theme";

// A sample slide in a theme (#216): a metric, a line and a bar widget on the
// theme's canvas, so the editor shows what a TV would. Sample numbers only;
// the real widget renderers come with #220.

const LINE = [42, 48, 45, 53, 58, 55, 63, 61, 70, 74, 69, 80];
const PREVIOUS = [38, 40, 44, 41, 47, 49, 46, 52, 50, 55, 57, 54];
const BARS: Array<[string, number]> = [
  ["Wurfel", 812],
  ["voilà", 604],
  ["Paperstand", 377],
  ["Other", 129],
];

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
      aria-label="Preview of a slide in this theme"
    >
      <div className="theme-preview-header">
        <span className="theme-preview-title">Wurfel</span>
        <span className="theme-preview-clock">09:41</span>
      </div>
      <div className="theme-preview-grid">
        <div className="theme-preview-widget theme-preview-metric">
          <span className="tp-label">Downloads · Wurfel</span>
          <span className="tp-muted">Last 7 days</span>
          <span className="tp-value">12,480</span>
          <span className="tp-up">▲ 8.2% vs previous 7 days</span>
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
          <span className="tp-label">Proceeds · All apps</span>
          <span className="tp-muted">This month</span>
          <span className="tp-value">€3,912</span>
          <span className="tp-down">▼ 4.1% vs last month</span>
          <span className="tp-warning">Updated 3 hours ago</span>
        </div>
        <div className="theme-preview-widget theme-preview-line">
          <span className="tp-label">Search clicks</span>
          <svg viewBox="0 0 300 130" className="tp-chart" aria-hidden="true">
            <polygon className="tp-area" points={`0,110 ${line} 300,110`} />
            <polyline className="tp-previous" points={previous} />
            <polyline className="tp-line" points={line} />
            <line className="tp-axis" x1="0" y1="110" x2="300" y2="110" />
            <text className="tp-axis-label" x="0" y="128">
              Sep 22
            </text>
            <text className="tp-axis-label" x="300" y="128" textAnchor="end">
              Oct 3
            </text>
          </svg>
        </div>
        <div className="theme-preview-widget theme-preview-bar">
          <span className="tp-label">Downloads by app</span>
          <ul className="tp-bars">
            {BARS.map(([label, value]) => (
              <li key={label}>
                <span className="tp-bar-label">{label}</span>
                <span className="tp-bar-track">
                  <span
                    className="tp-bar"
                    style={{ width: `${(value / barMax) * 100}%` }}
                  />
                </span>
                <span className="tp-bar-value">{value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
