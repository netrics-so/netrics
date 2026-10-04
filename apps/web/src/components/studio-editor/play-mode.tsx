"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ThemeTokens } from "@netrics/domain";

import { LiveWidget } from "@/components/studio/slide-canvas";
import {
  SlidePlayer,
  type SlidePlayerControls,
} from "@/components/studio/slide-player";
import { documentRotation } from "@/lib/slide-rotation";
import type { StudioDocument } from "@/lib/studio-document";
import type { StudioEnv } from "@/lib/studio-widgets";

/**
 * "Play" (ADR 0015, section 9): the draft's rotation full-screen, as a
 * screen would run it: the same SlidePlayer as the kiosk and the TV mode,
 * so visible slides only, each for its duration, with the dashboard's
 * transition (none with reduced motion). Arrow keys step, Space pauses,
 * Escape ends.
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
  const controls = useRef<SlidePlayerControls | null>(null);
  const { settings } = document;
  const slides = useMemo(
    () => documentRotation(document.slides, settings),
    [document.slides, settings],
  );
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  // Without auto-advance a screen shows only the first slide.
  const count = settings.autoAdvance
    ? slides.length
    : Math.min(slides.length, 1);
  const index = Math.max(
    0,
    slides.findIndex((slide) => slide.id === currentId),
  );
  const step = (by: number) => controls.current?.step(by);

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
          step(1);
        } else if (event.key === "ArrowLeft") {
          step(-1);
        } else if (event.key === " ") {
          event.preventDefault();
          setPaused((value) => !value);
        }
      }}
    >
      <div className="play-stage">
        <SlidePlayer
          slides={slides}
          autoAdvance={settings.autoAdvance}
          transition={settings.transition}
          tokens={tokens}
          showHeader={settings.showHeader}
          header={{
            name: document.name.trim() || "Untitled",
            logoImageId: settings.logoImageId,
            timeZone: env.timeZone,
          }}
          images={env.images}
          renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
          startSlideId={startSlideId}
          paused={paused}
          controlsRef={controls}
          onSlideChange={setCurrentId}
          empty={
            <p className="play-empty">
              Every slide is hidden. Show at least one slide on screens to play
              the dashboard.
            </p>
          }
        />
      </div>
      <div className="play-controls">
        <span aria-live="polite">
          {count > 0
            ? `Slide ${Math.min(index, count - 1) + 1} of ${count}${paused && count > 1 ? " · paused" : ""}`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
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
          onClick={() => step(1)}
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
