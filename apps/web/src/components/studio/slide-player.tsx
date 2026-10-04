"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { DeviceDashboardV2Response } from "@netrics/contracts";
import {
  STUDIO_SPACING,
  STUDIO_TEXT_MINIMUMS,
  type LayoutPlacement,
  type ScreenFormat,
  type ThemeTokens,
} from "@netrics/domain";

import {
  pageLabel,
  screenFormatOf,
  slidePages,
  type ScreenSize,
} from "@/lib/screen-view";
import {
  createSlideRotation,
  keptSlideId,
  pageEntryId,
  parsePageEntryId,
  type SlideRotation,
} from "@/lib/slide-rotation";
import { useT } from "@/lib/i18n/client";
import { u } from "@/lib/studio-render";
import { themeStyle, themeSurface } from "@/lib/studio-theme";
import type { StudioImages } from "@/lib/studio-widgets";
import { useElementSize } from "@/lib/use-screen";

import {
  SlideCanvas,
  type CanvasSlide,
  type CanvasWidget,
  type PlacedWidget,
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

/**
 * One entry of the rotation: a page of a slide in the screen's format
 * (ADR 0017, section 3 step 7). Each page shows for the slide's full
 * duration; a slide on one page is one entry with the slide's id.
 */
export interface PlayerEntry<W extends CanvasWidget, S extends PlayerSlide<W>> {
  /** `pageEntryId(slide.id, page)`. */
  id: string;
  slide: S;
  page: number;
  pages: number;
  placements: LayoutPlacement[];
  durationSec: number;
}

/** The rotation of `slides` on a screen of `format`: every slide's pages. */
export function playerEntries<W extends CanvasWidget, S extends PlayerSlide<W>>(
  slides: readonly S[],
  primaryFormat: ScreenFormat,
  format: ScreenFormat,
): Array<PlayerEntry<W, S>> {
  return slides.flatMap((slide) => {
    const pages = slidePages(slide.widgets, {
      primaryFormat,
      format,
      layouts: slide.layouts,
    });
    return pages.map((placements, page) => ({
      id: pageEntryId(slide.id, page),
      slide,
      page,
      pages: pages.length,
      placements,
      durationSec: slide.durationSec,
    }));
  });
}

/** The slide footer's text and bar in units, in the canvas's padding. */
const FOOTER_TEXT = STUDIO_TEXT_MINIMUMS.any;
const FOOTER_BAR = 4.5;
const FOOTER_GAP = 3;

/** "Sales 2/2" for a page of a slide on several pages; null without name. */
function entryName<W extends CanvasWidget, S extends PlayerSlide<W>>(
  entry: PlayerEntry<W, S>,
): string | null {
  const name = entry.slide.name?.trim() || null;
  const page = pageLabel(entry.page, entry.pages);
  return name && page ? `${name} ${page}` : name;
}

/**
 * The slide footer (ADR 0018 section 5): "2 / 3 · Sales · next: Team"
 * over a thin bar that fills over the slide's duration (a CSS animation,
 * paused with the rotation; none with reduced motion). It sits in the
 * canvas's bottom padding (32 units, the grid unchanged): 24 units of
 * text, the bar under it.
 */
export function SlideFooter({
  position,
  count,
  name,
  next,
  durationSec,
  paused,
}: {
  position: number;
  count: number;
  name: string | null;
  next: string | null;
  durationSec: number;
  paused: boolean;
}) {
  const t = useT("screen.player");
  const text = [
    t("position", { number: position, count }),
    name,
    next ? t("next", { name: next }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="studio-slide-footer"
      style={{
        height: u(STUDIO_SPACING.padding),
        padding: `0 ${u(STUDIO_SPACING.padding)}`,
        gap: u(FOOTER_GAP),
      }}
    >
      <p
        className="studio-slide-footer-text"
        style={{ fontSize: u(FOOTER_TEXT) }}
      >
        {text}
      </p>
      <span
        className="studio-slide-footer-bar"
        style={{ height: u(FOOTER_BAR) }}
        aria-hidden="true"
      >
        <span
          className="studio-slide-footer-fill"
          style={{
            animationDuration: `${durationSec}s`,
            animationPlayState: paused ? "paused" : "running",
          }}
        />
      </span>
    </div>
  );
}

/** Steps a playing rotation from outside (the Studio's Play controls). */
export interface SlidePlayerControls {
  /**
   * Moves `by` slides (pages of a slide on several pages count as
   * slides), wrapping round; the new slide's time starts now.
   */
  step(by: number): void;
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
  renderWidget: (widget: PlacedWidget<W>) => ReactNode;
  /** The format the slides' widgets are placed in (default 16x9). */
  primaryFormat?: ScreenFormat;
  /** The format to show; default: the player's measured size's. */
  format?: ScreenFormat;
  /** The screen size assumed until measured (server render, tests). */
  screen?: ScreenSize | null;
  /** Shown when there is no slide. */
  empty?: ReactNode;
  className?: string;
  /** The slide to start on when it is there (Play from a slide). */
  startSlideId?: string | null;
  /** True holds the slide on screen; false resumes with its time left. */
  paused?: boolean;
  /** Filled with the player's controls while it is mounted. */
  controlsRef?: RefObject<SlidePlayerControls | null>;
  /** The slide on screen changed (or was first shown): the slide's id. */
  onSlideChange?: (slideId: string | null) => void;
}

/**
 * Plays a dashboard's slides as a screen does (ADR 0015 section 7, ADR 0017
 * sections 2 and 3): each for its `durationSec`, then the next, with a fade
 * or a cut, in screen view on the player's measured size. A slide that
 * needs several pages in the screen's format rotates as several slides
 * ("Sales 1/2", "Sales 2/2"), each for the slide's full duration. The
 * rotation state lives here; new `slides` (a refreshed payload) or a new
 * size (a resize, a turned tablet) keep the slide on screen when it still
 * exists, and a page that is gone falls back to its slide. Every page stays
 * mounted, stacked, so widgets keep their data and the fade is a
 * cross-fade; hidden pages are inert. Used by the kiosk, the signed-in TV
 * mode and the Studio's Play preview, so all three rotate alike.
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
  startSlideId = null,
  paused = false,
  controlsRef,
  onSlideChange,
  primaryFormat = "16x9",
  format: forcedFormat,
  screen: assumedScreen = null,
}: SlidePlayerProps<W>) {
  const t = useT("dashboard");
  const root = useRef<HTMLDivElement>(null);
  const measured = useElementSize(root);
  const screen = measured ?? assumedScreen;
  const format = forcedFormat ?? screenFormatOf(screen);
  const entries = useMemo(
    () => playerEntries(slides, primaryFormat, format),
    [slides, primaryFormat, format],
  );
  const [currentId, setCurrentId] = useState<string | null>(() =>
    keptSlideId(entries, startSlideId, autoAdvance),
  );
  const rotation = useRef<SlideRotation | null>(null);
  // The first slide's id: where the rotation starts (read once).
  const start = useRef(startSlideId);

  useEffect(() => {
    const created = createSlideRotation({
      onChange: setCurrentId,
      startId: start.current,
    });
    rotation.current = created;
    return () => {
      created.stop();
      rotation.current = null;
    };
  }, []);

  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      step: (by) => rotation.current?.step(by),
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef]);

  // Rotation only needs ids and durations: a payload with new numbers but
  // the same slides does not restart the slide on screen.
  const timing = JSON.stringify(
    entries.map((entry) => [entry.id, entry.durationSec]),
  );
  useEffect(() => {
    const parsed = JSON.parse(timing) as Array<[string, number]>;
    rotation.current?.update(
      parsed.map(([id, durationSec]) => ({ id, durationSec })),
      autoAdvance,
    );
  }, [timing, autoAdvance]);

  useEffect(() => {
    rotation.current?.setPaused(paused);
  }, [paused, timing, autoAdvance]);

  // Until the rotation has caught up with new slides, show what it will.
  const shownId = keptSlideId(entries, currentId, autoAdvance);
  const shownSlideId =
    shownId === null ? null : parsePageEntryId(shownId).slideId;
  const reported = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (reported.current !== shownSlideId) {
      reported.current = shownSlideId;
      onSlideChange?.(shownSlideId);
    }
  });

  const fade = transition === "fade";
  // The slide footer shows while the rotation moves on by itself.
  const showFooter = autoAdvance && entries.length > 1;

  return (
    <div
      ref={root}
      className={["slide-player", fade ? "slide-player--fade" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={themeStyle(tokens)}
      data-surface={themeSurface(tokens)}
      aria-roledescription={t("slideShow")}
      data-format={format}
    >
      {entries.length === 0
        ? empty && <div className="slide-player-empty">{empty}</div>
        : entries.map((entry, index) => {
            const active = entry.id === shownId;
            const next = entries[(index + 1) % entries.length]!;
            return (
              <div
                key={entry.id}
                className={
                  active ? "slide-player-slide active" : "slide-player-slide"
                }
                aria-hidden={active ? undefined : true}
                inert={!active}
                data-slide-id={entry.slide.id}
                data-page={entry.pages > 1 ? entry.page + 1 : undefined}
              >
                <SlideCanvas
                  slide={entry.slide}
                  tokens={tokens}
                  showHeader={showHeader}
                  header={{
                    ...header,
                    slideName: entry.slide.name,
                    pageLabel: pageLabel(entry.page, entry.pages),
                  }}
                  images={images}
                  renderWidget={renderWidget}
                  primaryFormat={primaryFormat}
                  format={format}
                  placements={entry.placements}
                  screen={screen}
                  fill
                  footer={
                    active && showFooter ? (
                      <SlideFooter
                        position={index + 1}
                        count={entries.length}
                        name={entryName(entry)}
                        next={entryName(next)}
                        durationSec={entry.durationSec}
                        paused={paused}
                      />
                    ) : null
                  }
                />
              </div>
            );
          })}
    </div>
  );
}
