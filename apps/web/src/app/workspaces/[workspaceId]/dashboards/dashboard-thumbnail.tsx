import type { CSSProperties } from "react";

import type { DashboardListResponse } from "@netrics/contracts";
import { SCREEN_FORMATS } from "@netrics/domain";

type Summary = DashboardListResponse["dashboards"][number];

/** The card's thumbnail is always 16:9; other formats sit inside it. */
const CARD_ASPECT = 16 / 9;

/**
 * Width and height of the slide inside a 16:9 box, in percent: a wider
 * format fills the width, a narrower one the height (#304).
 */
export function thumbnailFrame(format: Summary["primaryFormat"]): {
  width: number;
  height: number;
} {
  const { width, height } = SCREEN_FORMATS[format].reference;
  const aspect = width / height;
  return aspect >= CARD_ASPECT
    ? { width: 100, height: (CARD_ASPECT / aspect) * 100 }
    : { width: (aspect / CARD_ASPECT) * 100, height: 100 };
}

/**
 * The first enabled slide as a schematic (ADR 0018 section 1: TV surfaces
 * stay in the theme's colours in the admin): the theme background with
 * each widget as a stub at its grid place. No live data, so a long list
 * stays cheap. Decorative; the card names the dashboard.
 */
export function DashboardThumbnail({
  dashboard,
  pill,
}: {
  dashboard: Pick<Summary, "preview" | "primaryFormat" | "accent">;
  /** "3 slides", shown on top. */
  pill: string;
}) {
  const { preview, primaryFormat } = dashboard;
  const { columns, rows } = SCREEN_FORMATS[primaryFormat];
  const frame = thumbnailFrame(primaryFormat);
  return (
    <div
      className="dash-thumb"
      style={
        {
          "--thumb-bg": preview.background,
          "--thumb-surface": preview.surface,
          "--thumb-border": preview.border,
          "--thumb-accent": dashboard.accent,
        } as CSSProperties
      }
    >
      <div
        className="dash-thumb-frame"
        data-format={primaryFormat}
        style={{ width: `${frame.width}%`, height: `${frame.height}%` }}
        aria-hidden="true"
      >
        <div className="dash-thumb-grid">
          {preview.widgets.map((widget, index) => (
            <span
              key={index}
              className={`dash-thumb-stub dash-thumb-stub--${widget.type}`}
              style={{
                left: `${(widget.x / columns) * 100}%`,
                top: `${(widget.y / rows) * 100}%`,
                width: `${(widget.w / columns) * 100}%`,
                height: `${(widget.h / rows) * 100}%`,
              }}
            />
          ))}
        </div>
      </div>
      <span className="dash-thumb-pill">{pill}</span>
    </div>
  );
}
