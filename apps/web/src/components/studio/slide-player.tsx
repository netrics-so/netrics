"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DeviceDashboardV2Response } from "@netrics/contracts";
import type { ThemeTokens } from "@netrics/domain";

import {
  createSlideRotation,
  keptSlideId,
  type SlideRotation,
} from "@/lib/slide-rotation";
import { themeStyle } from "@/lib/studio-theme";
import type { StudioImages } from "@/lib/studio-widgets";

import {
  SlideCanvas,
  type CanvasSlide,
  type CanvasWidget,
  type SlideHeaderInfo,
} from "./slide-canvas";

/** One slide of a rotation: a device payload's, or a document's mapped. */
type SlideTransition = DeviceDashboardV2Response["rotation"]["transition"];

export interface PlayerSlide<W extends CanvasWidget> extends CanvasSlide<W> {
  id: string;
  /** Shown in the header; null for none. */
  name: string | null;
  /** How long the slide stays on screen when the rotation advances. */
  durationSec: number;
}

export interface SlidePlayerProps<W extends CanvasWidget> {
  /** The slides to rotate through, in order (enabled slides only). */
  slides: readonly PlayerSlide<W>[];
  /** False: show only the first slide. */
  autoAdvance: boolean;
  /** "fade" cross-fades (none with reduced motion); "none" cuts. */
  transition: SlideTransition;
  tokens: ThemeTokens;
  showHeader: boolean;
  /** The header without the slide name, which the player fills in. */
  header: Omit<SlideHeaderInfo, "slideName">;
  images: StudioImages;
  /** A widget's content: payload data on screens, live queries signed in. */
  renderWidget: (widget: W) => ReactNode;
  /** Shown when there is no slide. */
  empty?: ReactNode;
  className?: string;
}

/**
 * Plays a dashboard's slides as a screen does (ADR 0015, section 7): each
 * for its `durationSec`, then the next, with a fade or a cut. The rotation
 * state lives here; new `slides` (a refreshed payload) keep the slide on
 * screen when its id still exists. Every slide stays mounted, stacked, so
 * widgets keep their data and the fade is a cross-fade; hidden slides are
 * inert. Used by the kiosk (payload schema 2) and the signed-in TV mode;
 * the Studio's Play preview can use it too.
 */
export function SlidePlayer<W extends CanvasWidget>({
  slides,
  autoAdvance,
  transition,
  tokens,
  showHeader,
  header,
  images,
  renderWidget,
  empty,
  className,
}: SlidePlayerProps<W>) {
  const [currentId, setCurrentId] = useState<string | null>(() =>
    keptSlideId(slides, null, autoAdvance),
  );
  const rotation = useRef<SlideRotation | null>(null);

  useEffect(() => {
    const created = createSlideRotation({ onChange: setCurrentId });
    rotation.current = created;
    return () => {
      created.stop();
      rotation.current = null;
    };
  }, []);

  // Rotation only needs ids and durations: a payload with new numbers but
  // the same slides does not restart the slide on screen.
  const timing = JSON.stringify(
    slides.map((slide) => [slide.id, slide.durationSec]),
  );
  useEffect(() => {
    const parsed = JSON.parse(timing) as Array<[string, number]>;
    rotation.current?.update(
      parsed.map(([id, durationSec]) => ({ id, durationSec })),
      autoAdvance,
    );
  }, [timing, autoAdvance]);

  // Until the rotation has caught up with new slides, show what it will.
  const shownId = keptSlideId(slides, currentId, autoAdvance);
  const fade = transition === "fade";

  return (
    <div
      className={["slide-player", fade ? "slide-player--fade" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={themeStyle(tokens)}
      aria-roledescription="slide show"
    >
      {slides.length === 0
        ? (empty ?? null)
        : slides.map((slide) => {
            const active = slide.id === shownId;
            return (
              <div
                key={slide.id}
                className={
                  active ? "slide-player-slide active" : "slide-player-slide"
                }
                aria-hidden={active ? undefined : true}
                inert={!active}
                data-slide-id={slide.id}
              >
                <SlideCanvas
                  slide={slide}
                  tokens={tokens}
                  showHeader={showHeader}
                  header={{ ...header, slideName: slide.name }}
                  images={images}
                  renderWidget={renderWidget}
                />
              </div>
            );
          })}
    </div>
  );
}
