"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type { Dashboard } from "@netrics/contracts";
import type { ThemeTokens } from "@netrics/domain";

import {
  LiveWidget,
  SlideCanvas,
  useOffline,
} from "@/components/studio/slide-canvas";
import { playerEntries } from "@/components/studio/slide-player";
import { useLocale, useT } from "@/lib/i18n/client";
import { pageLabel, screenFormatOf, type ScreenSize } from "@/lib/screen-view";
import { keptSlideId } from "@/lib/slide-rotation";
import { logoImageId, slideTitle, type StudioEnv } from "@/lib/studio-widgets";
import { useFullscreen, useViewportSize, useWakeLock } from "@/lib/use-screen";

/**
 * The dashboard read-only in screen view (ADR 0015, ADR 0017 sections 5
 * and 11): tabs for its slides and the selected slide on a canvas of the
 * viewport's shape and format, in the dashboard's theme, with live
 * numbers. A slide on several pages in that format has a tab per page
 * ("Sales 1/2"). "Full screen" shows the canvas on the whole screen and
 * keeps it awake while it does (where the browser allows; failures are
 * ignored). Editing is the Studio's (#223).
 */
export function SlideViewer({
  dashboard,
  tokens,
  env,
  viewport: assumedViewport = null,
}: {
  dashboard: Dashboard;
  tokens: ThemeTokens;
  env: StudioEnv;
  /** The viewport assumed until measured (server render, tests). */
  viewport?: ScreenSize | null;
}) {
  const locale = useLocale();
  const t = useT("dashboard");
  const { slides } = dashboard;
  const viewport = useViewportSize() ?? assumedViewport;
  const format = screenFormatOf(viewport);
  const entries = useMemo(
    () =>
      playerEntries(
        slides.map((slide) => ({ ...slide, durationSec: 0 })),
        dashboard.primaryFormat,
        format,
      ),
    [slides, dashboard.primaryFormat, format],
  );
  // Keep the selected slide (or page) across refreshes and resizes, by id;
  // a page that is gone falls back to its slide, else the first.
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? null);
  const shownId = keptSlideId(entries, selectedId, true);
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.id === shownId),
  );
  const entry = entries[index];
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const frame = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const offline = useOffline();
  const fullscreen = useFullscreen(frame);
  useWakeLock(fullscreen.active);

  if (!entry) {
    return null;
  }
  const { slide } = entry;

  function select(next: number) {
    const target = entries[(next + entries.length) % entries.length]!;
    setSelectedId(target.id);
    tabs.current[(next + entries.length) % entries.length]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: entries.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      select(next);
    }
  }

  const panelId = `${baseId}-panel`;
  const tabbed = entries.length > 1;
  const aspect = viewport
    ? `${Math.round(viewport.width)} / ${Math.round(viewport.height)}`
    : undefined;
  return (
    <section className="slide-viewer" aria-label={t("slides")}>
      <div className="slide-viewer-bar">
        {tabbed ? (
          <div
            className="slide-tabs"
            role="tablist"
            aria-label={t("slides")}
            onKeyDown={onKeyDown}
          >
            {entries.map((candidate, candidateIndex) => {
              const slideIndex = slides.indexOf(candidate.slide);
              const label = pageLabel(candidate.page, candidate.pages);
              return (
                <button
                  key={candidate.id}
                  ref={(element) => {
                    tabs.current[candidateIndex] = element;
                  }}
                  type="button"
                  role="tab"
                  className="slide-tab"
                  id={`${baseId}-tab-${candidateIndex}`}
                  aria-selected={candidateIndex === index}
                  aria-controls={panelId}
                  tabIndex={candidateIndex === index ? 0 : -1}
                  onClick={() => setSelectedId(candidate.id)}
                >
                  {slideTitle(candidate.slide, slideIndex, locale)}
                  {label ? ` ${label}` : null}
                  {candidate.slide.enabled ? null : (
                    <span className="slide-tab-off"> ({t("slideOff")})</span>
                  )}
                </button>
              );
            })}
          </div>
        ) : null}
        {fullscreen.supported ? (
          <button
            type="button"
            className="slide-fullscreen"
            aria-pressed={fullscreen.active}
            onClick={fullscreen.toggle}
          >
            {fullscreen.active ? t("exitFullScreen") : t("fullScreen")}
          </button>
        ) : null}
      </div>
      <div
        ref={frame}
        id={panelId}
        className="slide-frame"
        role={tabbed ? "tabpanel" : undefined}
        aria-labelledby={tabbed ? `${baseId}-tab-${index}` : undefined}
        style={
          aspect ? ({ "--screen-aspect": aspect } as CSSProperties) : undefined
        }
      >
        <SlideCanvas
          key={entry.id}
          className="studio-slide-enter"
          slide={slide}
          tokens={tokens}
          showHeader={dashboard.settings.showHeader}
          header={{
            name: dashboard.name,
            slideName: slide.name,
            pageLabel: pageLabel(entry.page, entry.pages),
            logoImageId: logoImageId(dashboard.settings),
            timeZone: env.timeZone,
            offline,
          }}
          images={env.images}
          renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
          primaryFormat={dashboard.primaryFormat}
          format={format}
          placements={entry.placements}
          screen={viewport}
          fill
        />
      </div>
      {slide.widgets.length === 0 ? (
        <p className="muted">{t("slideEmpty")}</p>
      ) : null}
    </section>
  );
}
