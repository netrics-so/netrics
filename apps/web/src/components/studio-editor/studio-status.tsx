"use client";

import type { ReactNode } from "react";

import { SCREEN_FORMATS, type ScreenFormat } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";

import { formatRatio } from "./format-attention";

// The Studio's quiet status texts (design 3b): which screens show the
// dashboard (header), what the canvas shows and whether it reads well
// (above the canvas), and the look and keyboard hints (below it).

/**
 * "● Live on Office wall, Kitchen" in the header: the paired screens that
 * show this dashboard (its saved version); "Not on any screen" otherwise.
 */
export function LiveIndicator({ screens }: { screens: readonly string[] }) {
  const t = useT("studio.status");
  const locale = useLocale();
  if (screens.length === 0) {
    return <span className="studio-live studio-live--off">{t("notLive")}</span>;
  }
  const list = new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(screens);
  const text = t("liveOn", { screens: list });
  return (
    <span className="studio-live" title={text}>
      <span className="studio-live-dot" aria-hidden="true" />
      <span className="studio-live-text">{text}</span>
    </span>
  );
}

/**
 * The line above the canvas: "Slide 2 · Sales · 16:9 · 1920 × 1080
 * preview", and on the right whether the slide's placements are fine and
 * its labels readable at a distance (the canvas's readability warnings).
 */
export function CanvasHead({
  number,
  name,
  format,
  hasProblems,
  cutOff,
}: {
  number: number;
  /** The slide's own name, or null ("Slide 2" says it all). */
  name: string | null;
  format: ScreenFormat;
  hasProblems: boolean;
  /** Labels and texts cut off on this slide. */
  cutOff: number;
}) {
  const t = useT("studio.status");
  const { width, height } = SCREEN_FORMATS[format].reference;
  return (
    <div className="canvas-head">
      <span className="canvas-head-title">
        {t(name ? "canvasSlideNamed" : "canvasSlide", {
          number,
          name: name ?? "",
          ratio: formatRatio(format),
          // Resolutions read without group separators ("1920 × 1080").
          width: String(width),
          height: String(height),
        })}
      </span>
      <span className="canvas-head-checks">
        <span className={hasProblems ? "canvas-check--warn" : undefined}>
          {hasProblems ? t("gridProblems") : t("gridOk")}
        </span>
        <span>
          {t("readable")}{" "}
          <span
            className={cutOff > 0 ? "canvas-check--warn" : "canvas-check--ok"}
          >
            {cutOff > 0 ? t("labelsCut", { count: cutOff }) : t("allFit")}
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * The line below the canvas: theme, accent, header and clock, the widget
 * clipboard (`children`) and the keyboard hints.
 */
export function StatusLine({
  themeName,
  accent,
  showHeader,
  children,
}: {
  themeName: string;
  accent: string;
  showHeader: boolean;
  children?: ReactNode;
}) {
  const t = useT("studio.status");
  return (
    <div className="studio-status">
      <span>
        {t("theme")} <b>{themeName}</b>
      </span>
      <span>
        {t("accent")}{" "}
        <span
          className="studio-status-swatch"
          style={{ background: accent }}
          aria-hidden="true"
        />
      </span>
      <span>{showHeader ? t("headerOn") : t("headerOff")}</span>
      {children}
      <span className="studio-status-keys" title={t("keysHelp")}>
        {t("keys")}
      </span>
    </div>
  );
}
