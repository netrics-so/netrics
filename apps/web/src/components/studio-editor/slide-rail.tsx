"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  BACKGROUND_DIM,
  SLIDE_SECONDS,
  STUDIO_GRID,
  STUDIO_LIMITS,
  type ThemeTokens,
} from "@netrics/domain";

import {
  insertionIndex,
  reorderTarget,
  type StudioAction,
  type StudioSlide,
} from "@/lib/studio-document";
import { slideTitle } from "@/lib/studio-widgets";

import type { PickableImage } from "./image-picker";
import { ImagePicker } from "./image-picker";

/**
 * A slide as a small schematic: the theme's background with its widgets
 * as surface blocks. No live data, so a long rail stays cheap.
 */
export function SlideThumbnail({
  slide,
  tokens,
}: {
  slide: StudioSlide;
  tokens: ThemeTokens;
}) {
  return (
    <span
      className="rail-thumb"
      aria-hidden="true"
      style={{ background: tokens.background, borderColor: tokens.border }}
    >
      {slide.widgets.map((widget) => (
        <span
          key={widget.id}
          className="rail-thumb-widget"
          style={{
            left: `${(widget.x / STUDIO_GRID.columns) * 100}%`,
            top: `${(widget.y / STUDIO_GRID.rows) * 100}%`,
            width: `${(widget.w / STUDIO_GRID.columns) * 100}%`,
            height: `${(widget.h / STUDIO_GRID.rows) * 100}%`,
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

/**
 * The slide rail (ADR 0015, section 9): every slide in rotation order. A
 * slide is selected by click or Enter; Alt+Arrow keys move it, the drag
 * handle moves it with a pointer, and every move is announced. Below the
 * list: the selected slide's name, duration, visibility and background.
 */
export function SlideRail({
  slides,
  selectedSlideId,
  tokens,
  defaultSeconds,
  slidesWithProblems,
  images,
  dispatch,
  onUploadImage,
}: {
  slides: StudioSlide[];
  selectedSlideId: string;
  tokens: ThemeTokens;
  defaultSeconds: number;
  slidesWithProblems: ReadonlySet<string>;
  images: PickableImage[];
  dispatch: (action: StudioAction) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
}) {
  const hintId = useId();
  const items = useRef(new Map<string, HTMLLIElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
        setConfirmDelete(slide.id);
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
    <aside className="studio-rail" aria-label="Slides">
      <div className="rail-head">
        <h2>Slides</h2>
        <button
          type="button"
          onClick={() => dispatch({ type: "addSlide" })}
          disabled={slides.length >= STUDIO_LIMITS.slides}
          title={
            slides.length >= STUDIO_LIMITS.slides
              ? `At most ${STUDIO_LIMITS.slides} slides`
              : undefined
          }
        >
          Add slide
        </button>
      </div>
      <p id={hintId} className="visually-hidden">
        Arrow keys move between slides. Alt plus Arrow Up or Down moves the
        slide. Delete removes it after a confirmation.
      </p>
      <ol className={drag ? "rail-list rail-list--dragging" : "rail-list"}>
        {slides.map((slide, index) => {
          const isSelected = slide.id === selected?.id;
          const title = slideTitle(slide, index);
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
                title="Drag to reorder"
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
                aria-label={`${index + 1} of ${slides.length}: ${title}, ${seconds} seconds${slide.enabled ? "" : ", hidden on screens"}${slidesWithProblems.has(slide.id) ? ", has problems" : ""}`}
                onClick={() =>
                  dispatch({ type: "selectSlide", slideId: slide.id })
                }
                onKeyDown={(event) => onItemKeyDown(event, index)}
              >
                <SlideThumbnail slide={slide} tokens={tokens} />
                <span className="rail-text">
                  <span className="rail-title">
                    {index + 1}. {title}
                  </span>
                  <span className="rail-meta">
                    {seconds} s{slide.enabled ? "" : " · hidden"}
                    {slidesWithProblems.has(slide.id) ? (
                      <span className="rail-problem"> · ⚠ check</span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {selected ? (
        <section className="rail-slide" aria-label="Selected slide">
          <h3>Slide {selectedIndex + 1}</h3>
          <div className="field">
            <label htmlFor="slide-name">Name</label>
            <input
              id="slide-name"
              type="text"
              value={selected.name ?? ""}
              maxLength={STUDIO_LIMITS.slideNameLength}
              placeholder={`Slide ${selectedIndex + 1}`}
              onChange={(event) =>
                dispatch({
                  type: "updateSlide",
                  slideId: selected.id,
                  patch: {
                    name: event.target.value === "" ? null : event.target.value,
                  },
                })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="slide-duration">Duration (seconds)</label>
            <input
              id="slide-duration"
              type="number"
              inputMode="numeric"
              min={SLIDE_SECONDS.min}
              max={SLIDE_SECONDS.max}
              value={selected.durationSeconds ?? ""}
              placeholder={`${defaultSeconds} (dashboard default)`}
              onChange={(event) =>
                dispatch({
                  type: "updateSlide",
                  slideId: selected.id,
                  patch: {
                    durationSeconds:
                      event.target.value === ""
                        ? null
                        : Math.round(Number(event.target.value)),
                  },
                })
              }
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={selected.enabled}
              onChange={(event) =>
                dispatch({
                  type: "updateSlide",
                  slideId: selected.id,
                  patch: { enabled: event.target.checked },
                })
              }
            />
            Show on screens
          </label>
          <ImagePicker
            id="slide-background"
            label="Background image"
            noneLabel="No background"
            images={images}
            value={selected.background?.imageId ?? null}
            onChange={(imageId) =>
              dispatch({
                type: "updateSlide",
                slideId: selected.id,
                patch: {
                  background: imageId
                    ? {
                        imageId,
                        dim: selected.background?.dim ?? BACKGROUND_DIM.default,
                      }
                    : null,
                },
              })
            }
            onUpload={onUploadImage}
          />
          {selected.background ? (
            <div className="field">
              <label htmlFor="slide-dim">
                Dim the background: {selected.background.dim} %
              </label>
              <input
                id="slide-dim"
                type="range"
                min={BACKGROUND_DIM.min}
                max={BACKGROUND_DIM.max}
                step={5}
                value={selected.background.dim}
                onChange={(event) =>
                  dispatch({
                    type: "updateSlide",
                    slideId: selected.id,
                    patch: {
                      background: {
                        imageId: selected.background!.imageId,
                        dim: Number(event.target.value),
                      },
                    },
                  })
                }
              />
            </div>
          ) : null}
          <div className="actions rail-actions">
            <button
              type="button"
              onClick={() => move(selected.id, selectedIndex - 1)}
              disabled={selectedIndex === 0}
              aria-label="Move slide up"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(selected.id, selectedIndex + 1)}
              disabled={selectedIndex === slides.length - 1}
              aria-label="Move slide down"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "duplicateSlide", slideId: selected.id })
              }
              disabled={slides.length >= STUDIO_LIMITS.slides}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => setConfirmDelete(selected.id)}
              disabled={slides.length <= 1}
              title={
                slides.length <= 1
                  ? "A dashboard keeps at least one slide"
                  : undefined
              }
            >
              Delete
            </button>
          </div>
          {confirmDelete === selected.id ? (
            <div
              className="rail-confirm"
              role="alertdialog"
              aria-label="Delete slide"
            >
              <p>
                Delete {slideTitle(selected, selectedIndex)}
                {selected.widgets.length > 0
                  ? ` and its ${selected.widgets.length} widget${selected.widgets.length === 1 ? "" : "s"}`
                  : ""}
                ? You can undo this until you save.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  autoFocus
                  onClick={() => {
                    setConfirmDelete(null);
                    dispatch({ type: "deleteSlide", slideId: selected.id });
                  }}
                >
                  Delete slide
                </button>
                <button type="button" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
