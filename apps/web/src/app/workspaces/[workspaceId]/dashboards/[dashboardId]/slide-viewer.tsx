"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";

import type { Dashboard } from "@netrics/contracts";
import type { ThemeTokens } from "@netrics/domain";

import {
  LiveWidget,
  SlideCanvas,
  useOffline,
} from "@/components/studio/slide-canvas";
import { logoImageId, slideTitle, type StudioEnv } from "@/lib/studio-widgets";

/**
 * The dashboard read-only, as screens show it (ADR 0015): tabs for its
 * slides and the selected slide on its canvas, in the dashboard's theme,
 * with live numbers. Editing is the Studio's (#223).
 */
export function SlideViewer({
  dashboard,
  tokens,
  env,
}: {
  dashboard: Dashboard;
  tokens: ThemeTokens;
  env: StudioEnv;
}) {
  const { slides } = dashboard;
  // Keep the selected slide across refreshes (by id), else the first.
  const [selectedId, setSelectedId] = useState(slides[0]?.id ?? null);
  const index = Math.max(
    0,
    slides.findIndex((slide) => slide.id === selectedId),
  );
  const slide = slides[index];
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const offline = useOffline();

  if (!slide) {
    return null;
  }

  function select(next: number) {
    const target = slides[(next + slides.length) % slides.length]!;
    setSelectedId(target.id);
    tabs.current[(next + slides.length) % slides.length]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: slides.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      select(next);
    }
  }

  const panelId = `${baseId}-panel`;
  return (
    <section className="slide-viewer" aria-label="Slides">
      {slides.length > 1 ? (
        <div
          className="slide-tabs"
          role="tablist"
          aria-label="Slides"
          onKeyDown={onKeyDown}
        >
          {slides.map((candidate, candidateIndex) => (
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
              {slideTitle(candidate, candidateIndex)}
              {candidate.enabled ? null : (
                <span className="slide-tab-off"> (off)</span>
              )}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id={panelId}
        className="slide-frame"
        role={slides.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={
          slides.length > 1 ? `${baseId}-tab-${index}` : undefined
        }
      >
        <SlideCanvas
          key={slide.id}
          className="studio-slide-enter"
          slide={slide}
          tokens={tokens}
          showHeader={dashboard.settings.showHeader}
          header={{
            name: dashboard.name,
            slideName: slide.name,
            logoImageId: logoImageId(dashboard.settings),
            timeZone: env.timeZone,
            offline,
          }}
          images={env.images}
          renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
        />
      </div>
      {slide.widgets.length === 0 ? (
        <p className="muted">This slide has no widgets yet.</p>
      ) : null}
    </section>
  );
}
