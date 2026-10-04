"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  SCREEN_FORMATS,
  STUDIO_LIMITS,
  type Locale,
  type ScreenFormat,
  type ThemeTokens,
} from "@netrics/domain";

import {
  insertionIndex,
  reorderTarget,
  type StudioAction,
  type StudioSlide,
} from "@/lib/studio-document";
import { webTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import { slideTitle } from "@/lib/studio-widgets";

/**
 * A slide as a small schematic: the theme's background with its widgets
 * as surface blocks. No live data, so a long rail stays cheap.
 */
export function SlideThumbnail({
  slide,
  tokens,
  primaryFormat = "16x9",
}: {
  slide: StudioSlide;
  tokens: ThemeTokens;
  /** The format the widgets are placed in: its grid and shape. */
  primaryFormat?: ScreenFormat;
}) {
  const { columns, rows, reference } = SCREEN_FORMATS[primaryFormat];
  const aspect = reference.width / reference.height;
  // As high as a 72 px wide 16:9 thumbnail, at most 72 px wide.
  const shape =
    primaryFormat === "16x9"
      ? {}
      : {
          width: `${Math.min(72, Math.round(40.5 * aspect * 10) / 10)}px`,
          aspectRatio: `${reference.width} / ${reference.height}`,
        };
  return (
    <span
      className="rail-thumb"
      aria-hidden="true"
      style={{
        background: tokens.background,
        borderColor: tokens.border,
        ...shape,
      }}
    >
      {slide.widgets.map((widget) => (
        <span
          key={widget.id}
          className="rail-thumb-widget"
          style={{
            left: `${(widget.x / columns) * 100}%`,
            top: `${(widget.y / rows) * 100}%`,
            width: `${(widget.w / columns) * 100}%`,
            height: `${(widget.h / rows) * 100}%`,
            background:
              widget.type === "text" || widget.type === "image"
                ? tokens.muted
                : tokens.surface,
            borderColor: tokens.border,
          }}
        />
      ))}
    </span>
  );
}

interface DragState {
  slideId: string;
  from: number;
  /** The gap the slide would be dropped in (0 … n). */
  insertAt: number;
  midpoints: number[];
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/** "1 widget cut off", "2 widgets cut off" (labels or text). */
export function cutOffText(count: number, locale: Locale): string {
  return webTranslator(locale, "studio.rail")("cutOff", { count });
}

/** Seconds one round of the visible slides takes. */
export function rotationSeconds(
  slides: ReadonlyArray<Pick<StudioSlide, "enabled" | "durationSeconds">>,
  defaultSeconds: number,
): number {
  const fallback = Number.isFinite(defaultSeconds) ? defaultSeconds : 0;
  return slides
    .filter((slide) => slide.enabled)
    .reduce((sum, slide) => sum + (slide.durationSeconds ?? fallback), 0);
}

/** "20 s", "1 min 20 s": the length of a rotation. */
export function rotationText(length: number, locale: Locale): string {
  const t = webTranslator(locale, "studio.rail");
  const total = Number.isFinite(length) ? Math.max(0, Math.round(length)) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return total < 60
    ? t("total", { seconds: total })
    : seconds === 0
      ? t("totalWholeMinutes", { minutes })
      : t("totalMinutes", { minutes, seconds });
}

/**
 * The slide rail (ADR 0015, section 9; design 3b): every slide in rotation
 * order as a card, with the rotation's length in the head. A slide is
 * selected by click or Enter; Alt+Arrow keys move it, the drag handle
 * moves it with a pointer, and every move is announced. The selected
 * slide's settings are in the inspector (SlideSettings); `children` go
 * below the list (the add-widget chips).
 */
export function SlideRail({
  slides,
  selectedSlideId,
  tokens,
  defaultSeconds,
  slidesWithProblems,
  unreadableCounts = NO_COUNTS,
  dispatch,
  onRequestDelete,
  primaryFormat = "16x9",
  children,
}: {
  slides: StudioSlide[];
  selectedSlideId: string;
  tokens: ThemeTokens;
  defaultSeconds: number;
  slidesWithProblems: ReadonlySet<string>;
  /** Labels cut off on TVs, per slide id (#241). */
  unreadableCounts?: ReadonlyMap<string, number>;
  dispatch: (action: StudioAction) => void;
  /** Delete or Backspace on a slide: ask before deleting it. */
  onRequestDelete?: (slideId: string) => void;
  /** The format the slides are designed in (thumbnails). */
  primaryFormat?: ScreenFormat;
  /** Below the list: the add-widget chips. */
  children?: ReactNode;
}) {
  const locale = useLocale();
  const t = useT("studio.rail");
  const hintId = useId();
  const items = useRef(new Map<string, HTMLLIElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const focusAfterMove = useRef<string | null>(null);

  const selectedIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.id === selectedSlideId),
  );
  const selected = slides[selectedIndex];

  // After a keyboard move the moved slide keeps focus in its new place.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id) {
      focusAfterMove.current = null;
      buttons.current.get(id)?.focus();
    }
  }, [slides]);

  function move(slideId: string, to: number) {
    focusAfterMove.current = slideId;
    dispatch({ type: "moveSlide", slideId, to });
  }

  function onItemKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const slide = slides[index]!;
    const up = event.key === "ArrowUp";
    const down = event.key === "ArrowDown";
    if (event.altKey && (up || down)) {
      event.preventDefault();
      move(slide.id, index + (up ? -1 : 1));
      return;
    }
    if (up || down || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? slides.length - 1
            : Math.min(Math.max(index + (up ? -1 : 1), 0), slides.length - 1);
      buttons.current.get(slides[target]!.id)?.focus();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (slides.length > 1) {
        event.preventDefault();
        dispatch({ type: "selectSlide", slideId: slide.id });
        dispatch({ type: "selectWidget", widgetId: null });
        onRequestDelete?.(slide.id);
      }
    }
  }

  function midpoints(): number[] {
    return slides.map((slide) => {
      const rect = items.current.get(slide.id)?.getBoundingClientRect();
      return rect ? rect.top + rect.height / 2 : 0;
    });
  }

  function onHandleDown(event: PointerEvent<HTMLSpanElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const points = midpoints();
    setDrag({
      slideId: slides[index]!.id,
      from: index,
      insertAt: index,
      midpoints: points,
    });
  }

  function onHandleMove(event: PointerEvent<HTMLSpanElement>) {
    if (!drag) return;
    const insertAt = insertionIndex(drag.midpoints, event.clientY);
    if (insertAt !== drag.insertAt) {
      setDrag({ ...drag, insertAt });
    }
  }

  function onHandleUp() {
    if (!drag) return;
    const to = reorderTarget(drag.from, drag.insertAt);
    setDrag(null);
    if (to !== drag.from) {
      move(drag.slideId, to);
    }
  }

  return (
    <aside className="studio-rail" aria-label={t("title")}>
      <div className="rail-head">
        <div className="rail-head-title">
          <h2>{t("title")}</h2>
          <span className="rail-total">
            {t("totalPrefix", {
              total: rotationText(
                rotationSeconds(slides, defaultSeconds),
                locale,
              ),
            })}
          </span>
        </div>
        <button
          type="button"
          className="rail-add"
          onClick={() => dispatch({ type: "addSlide" })}
          disabled={slides.length >= STUDIO_LIMITS.slides}
          aria-label={t("add")}
          title={
            slides.length >= STUDIO_LIMITS.slides
              ? t("atMost", { max: STUDIO_LIMITS.slides })
              : undefined
          }
        >
          {t("addShort")}
        </button>
      </div>
      <p id={hintId} className="visually-hidden">
        {t("keyboardHelp")}
      </p>
      <ol className={drag ? "rail-list rail-list--dragging" : "rail-list"}>
        {slides.map((slide, index) => {
          const isSelected = slide.id === selected?.id;
          const title = slideTitle(slide, index, locale);
          const cutOff = unreadableCounts.get(slide.id);
          const seconds = slide.durationSeconds ?? defaultSeconds;
          const dropBefore =
            drag &&
            drag.insertAt === index &&
            reorderTarget(drag.from, index) !== drag.from;
          const dropAfter =
            drag &&
            index === slides.length - 1 &&
            drag.insertAt === slides.length &&
            drag.from !== slides.length - 1;
          return (
            <li
              key={slide.id}
              ref={(element) => {
                if (element) items.current.set(slide.id, element);
                else items.current.delete(slide.id);
              }}
              className={[
                "rail-item",
                isSelected ? "rail-item--selected" : "",
                slide.enabled ? "" : "rail-item--off",
                drag?.slideId === slide.id ? "rail-item--dragged" : "",
                dropBefore ? "rail-item--drop-before" : "",
                dropAfter ? "rail-item--drop-after" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                className="rail-handle"
                aria-hidden="true"
                title={t("dragHandle")}
                onPointerDown={(event) => onHandleDown(event, index)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={() => setDrag(null)}
              >
                ⋮⋮
              </span>
              <button
                type="button"
                className="rail-select"
                ref={(element) => {
                  if (element) buttons.current.set(slide.id, element);
                  else buttons.current.delete(slide.id);
                }}
                aria-current={isSelected ? "true" : undefined}
                aria-describedby={hintId}
                aria-label={t("itemLabel", {
                  number: index + 1,
                  count: slides.length,
                  title,
                  seconds,
                  hidden: slide.enabled ? "no" : "yes",
                  problems: slidesWithProblems.has(slide.id) ? "yes" : "no",
                  cutOff: cutOff ?? 0,
                })}
                onClick={() => {
                  dispatch({ type: "selectSlide", slideId: slide.id });
                  // The selected slide again: its settings in the inspector.
                  if (isSelected) {
                    dispatch({ type: "selectWidget", widgetId: null });
                  }
                }}
                onKeyDown={(event) => onItemKeyDown(event, index)}
              >
                <SlideThumbnail
                  slide={slide}
                  tokens={tokens}
                  primaryFormat={primaryFormat}
                />
                <span className="rail-text">
                  <span className="rail-title">
                    {index + 1}. {title}
                  </span>
                  <span className="rail-seconds">
                    {t("seconds", { seconds })}
                  </span>
                </span>
                {!slide.enabled ||
                slidesWithProblems.has(slide.id) ||
                cutOff ? (
                  <span className="rail-meta">
                    {slide.enabled ? null : (
                      <span className="rail-hidden">{t("hidden")}</span>
                    )}
                    {slidesWithProblems.has(slide.id) ? (
                      <span className="rail-problem">⚠ {t("check")}</span>
                    ) : null}
                    {cutOff ? (
                      <span className="rail-unreadable">
                        {cutOffText(cutOff, locale)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>

      {children ? <div className="rail-foot">{children}</div> : null}
    </aside>
  );
}
