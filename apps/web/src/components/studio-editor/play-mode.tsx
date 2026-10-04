"use client";

import { useEffect, useRef, useState } from "react";

import type { ThemeTokens } from "@netrics/domain";

import { LiveWidget, SlideCanvas } from "@/components/studio/slide-canvas";
import type { StudioDocument } from "@/lib/studio-document";
import { playlist, stepIndex } from "@/lib/studio-play";
import type { StudioEnv } from "@/lib/studio-widgets";

/**
 * "Play" (ADR 0015, section 9): the draft's rotation full-screen, as a
 * screen would run it: visible slides only, each for its duration, with
 * the dashboard's transition (none with reduced motion). Arrow keys step,
 * Space pauses, Escape ends.
 */
export function PlayMode({
  document,
  tokens,
  env,
  startSlideId,
  onClose,
}: {
  document: StudioDocument;
  tokens: ThemeTokens;
  env: StudioEnv;
  startSlideId: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const items = playlist(document.slides, document.settings);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.slide.id === startSlideId),
    ),
  );
  const [paused, setPaused] = useState(false);
  const current = items[Math.min(index, items.length - 1)];
  const count = items.length;

  // Full screen when the browser allows it; leaving it ends Play.
  useEffect(() => {
    const element = root.current;
    element?.focus();
    let entered = false;
    element
      ?.requestFullscreen?.()
      .then(() => {
        entered = true;
      })
      .catch(() => {
        // Not allowed (or not supported): the overlay covers the window.
      });
    const onChange = () => {
      if (entered && !window.document.fullscreenElement) {
        onClose();
      }
    };
    window.document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.document.removeEventListener("fullscreenchange", onChange);
      if (window.document.fullscreenElement) {
        void window.document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [onClose]);

  // Advance after the slide's duration.
  const seconds = current?.seconds ?? 0;
  useEffect(() => {
    if (seconds <= 0 || paused || count <= 1) return;
    const timer = window.setTimeout(
      () => setIndex((value) => stepIndex(value, 1, count)),
      seconds * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [seconds, paused, count, index]);

  return (
    <div
      ref={root}
      className="play-mode"
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${document.name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowRight") {
          setIndex((value) => stepIndex(value, 1, count));
        } else if (event.key === "ArrowLeft") {
          setIndex((value) => stepIndex(value, -1, count));
        } else if (event.key === " ") {
          event.preventDefault();
          setPaused((value) => !value);
        }
      }}
    >
      {current ? (
        <div className="play-stage">
          <SlideCanvas
            key={`${current.slide.id}-${index}`}
            className={
              document.settings.transition === "fade"
                ? "studio-slide-enter"
                : undefined
            }
            slide={{ ...current.slide, position: index }}
            tokens={tokens}
            showHeader={document.settings.showHeader}
            header={{
              name: document.name.trim() || "Untitled",
              slideName: current.slide.name,
              logoImageId: document.settings.logoImageId,
              timeZone: env.timeZone,
            }}
            images={env.images}
            renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
          />
        </div>
      ) : (
        <p className="play-empty">
          Every slide is hidden. Show at least one slide on screens to play the
          dashboard.
        </p>
      )}
      <div className="play-controls">
        <span aria-live="polite">
          {count > 0
            ? `Slide ${Math.min(index, count - 1) + 1} of ${count}${paused ? " · paused" : ""}`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => setIndex((value) => stepIndex(value, -1, count))}
          disabled={count <= 1}
          aria-label="Previous slide"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          disabled={count <= 1}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => setIndex((value) => stepIndex(value, 1, count))}
          disabled={count <= 1}
          aria-label="Next slide"
        >
          →
        </button>
        <button type="button" onClick={onClose}>
          Exit
        </button>
      </div>
    </div>
  );
}
