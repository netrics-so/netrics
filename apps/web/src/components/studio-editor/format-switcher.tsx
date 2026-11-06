"use client";

import { useRef, type KeyboardEvent } from "react";

import {
  tabKeyTarget,
  type PreviewTarget,
  type TargetStatus,
} from "@/lib/studio-formats";
import { useT } from "@/lib/i18n/client";

import { formatRatio } from "./format-attention";

/** "TV" and "16:9", or "Phone" and "Scroll view". */
export function useTargetName(): (target: PreviewTarget) => {
  name: string;
  ratio: string;
} {
  const t = useT("studio.formats");
  return (target) => ({
    name: t(`names.${target}`),
    ratio: target === "scroll" ? t("scrollRatio") : formatRatio(target),
  });
}

/**
 * The format switcher above the Studio canvas (ADR 0017 section 10, #283):
 * one tab per format, the primary first, then scroll view; each says
 * whether the format is the primary, laid out automatically or arranged
 * by hand, with its readability warnings, widgets to review and the
 * paired screens that use it. A tablist: arrows, Home and End move and
 * select; "All formats" shows every format side by side.
 */
export function FormatSwitcher({
  statuses,
  selected,
  overview,
  panelId,
  onSelect,
  onOverview,
}: {
  statuses: readonly TargetStatus[];
  selected: PreviewTarget;
  overview: boolean;
  /** The id of the stage the tabs control. */
  panelId: string;
  onSelect: (target: PreviewTarget) => void;
  onOverview: (on: boolean) => void;
}) {
  const t = useT("studio.formats");
  const nameOf = useTargetName();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    statuses.findIndex((status) => status.target === selected),
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabKeyTarget(event.key, index, statuses.length);
    if (next === null) return;
    event.preventDefault();
    onSelect(statuses[next]!.target);
    tabs.current[next]?.focus();
  }

  return (
    <div className="format-switcher">
      <div
        className="format-chips"
        role="tablist"
        aria-label={t("switcher")}
        onKeyDown={onKeyDown}
      >
        {statuses.map((status, position) => {
          const { name, ratio } = nameOf(status.target);
          const active = !overview && position === index;
          return (
            <button
              key={status.target}
              ref={(element) => {
                tabs.current[position] = element;
              }}
              type="button"
              role="tab"
              id={`${panelId}-tab-${status.target}`}
              className={`format-chip format-chip--${status.layout}`}
              data-target={status.target}
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={position === index ? 0 : -1}
              aria-label={t("chipLabel", {
                name,
                ratio,
                layout: t(`layout.${status.layout}`),
                attention: status.attention,
                review: status.toReview,
                screens: status.screens,
              })}
              onClick={() => onSelect(status.target)}
            >
              <span className="format-chip-head" aria-hidden="true">
                <FormatGlyph target={status.target} />
                <span className="format-chip-ratio">{ratio}</span>
                <span className="format-chip-name">{name}</span>
              </span>
              <span className="format-chip-state" aria-hidden="true">
                <span className="format-chip-layout">
                  {t(`layout.${status.layout}`)}
                </span>
                {status.attention > 0 ? (
                  <span className="format-chip-badge format-chip-badge--attention">
                    ⚠ {status.attention}
                  </span>
                ) : null}
                {status.toReview > 0 ? (
                  <span className="format-chip-badge format-chip-badge--review">
                    {t("toReview", { count: status.toReview })}
                  </span>
                ) : null}
                {status.screens > 0 ? (
                  <span
                    className="format-chip-screens"
                    title={t("screens", { count: status.screens })}
                  >
                    <ScreenGlyph /> {status.screens}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="format-overview-toggle"
        aria-pressed={overview}
        onClick={() => onOverview(!overview)}
      >
        {t("allFormats")}
      </button>
    </div>
  );
}

/** A small outline of the format's shape (a phone for scroll view). */
export function FormatGlyph({ target }: { target: PreviewTarget }) {
  const [w, h] =
    target === "scroll"
      ? [7, 14]
      : ({
          "16x9": [16, 9],
          "21x9": [18, 7.7],
          "4x3": [14, 10.5],
          "3x4": [10.5, 14],
          "9x16": [7.9, 14],
        }[target] as [number, number]);
  return (
    <svg
      className="format-glyph"
      width="20"
      height="16"
      viewBox="0 0 20 16"
      aria-hidden="true"
    >
      <rect
        x={(20 - w) / 2}
        y={(16 - h) / 2}
        width={w}
        height={h}
        rx={target === "scroll" ? 1.6 : 0.8}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      {target === "scroll" ? (
        <path
          d="M10 5.5v5M8.4 9l1.6 1.6L11.6 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
      ) : null}
    </svg>
  );
}

function ScreenGlyph() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
      <rect
        x="0.6"
        y="0.6"
        width="10.8"
        height="6.6"
        rx="0.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M4 9.4h4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
