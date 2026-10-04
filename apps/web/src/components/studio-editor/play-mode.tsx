"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ScreenFormat, ThemeTokens } from "@netrics/domain";

import { LiveWidget } from "@/components/studio/slide-canvas";
import {
  SlidePlayer,
  type SlidePlayerControls,
} from "@/components/studio/slide-player";
import { documentRotation } from "@/lib/slide-rotation";
import type { StudioDocument } from "@/lib/studio-document";
import type { SlideLayouts } from "@/lib/screen-view";
import type { StudioEnv } from "@/lib/studio-widgets";
import { useT } from "@/lib/i18n/client";
import { useWakeLock } from "@/lib/use-screen";

/**
 * "Play" (ADR 0015, section 9): the draft's rotation full-screen, as a
 * screen would run it: the same SlidePlayer as the kiosk and the TV mode,
 * so visible slides only, each for its duration, with the dashboard's
 * transition (none with reduced motion). Arrow keys step, Space pauses,
 * Escape ends. Screen view on the whole window in its format (ADR 0017):
 * the draft's slides, laid out from the primary format, with the saved
 * custom layouts completed against the draft as a save would.
 */
export function PlayMode({
  document,
  tokens,
  env,
  startSlideId,
  onClose,
  primaryFormat = "16x9",
  layouts,
}: {
  document: StudioDocument;
  tokens: ThemeTokens;
  env: StudioEnv;
  startSlideId: string;
  onClose: () => void;
  /** The dashboard's primary format. */
  primaryFormat?: ScreenFormat;
  /** The saved custom layouts by slide id. */
  layouts?: ReadonlyMap<string, SlideLayouts>;
}) {
  const t = useT("studio.play");
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef<SlidePlayerControls | null>(null);
  const { settings } = document;
  const slides = useMemo(
    () =>
      documentRotation(document.slides, settings).map((slide) => ({
        ...slide,
        layouts: layouts?.get(slide.id) ?? null,
      })),
    [document.slides, settings, layouts],
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
  useWakeLock(true);

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
      aria-label={t("label", { name: document.name })}
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
            name: document.name.trim() || t("untitled"),
            logoImageId: settings.logoImageId,
            timeZone: env.timeZone,
          }}
          images={env.images}
          renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
          primaryFormat={primaryFormat}
          startSlideId={startSlideId}
          paused={paused}
          controlsRef={controls}
          onSlideChange={setCurrentId}
          empty={<p className="play-empty">{t("allHidden")}</p>}
        />
      </div>
      <div className="play-controls">
        <span aria-live="polite">
          {count > 0
            ? t("position", {
                number: Math.min(index, count - 1) + 1,
                count,
                paused: paused && count > 1 ? "yes" : "no",
              })
            : ""}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={count <= 1}
          aria-label={t("previous")}
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          disabled={count <= 1}
        >
          {paused ? t("resume") : t("pause")}
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={count <= 1}
          aria-label={t("next")}
        >
          →
        </button>
        <button type="button" onClick={onClose}>
          {t("exit")}
        </button>
      </div>
    </div>
  );
}
