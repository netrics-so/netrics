"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { DashboardSettings, DashboardWidget } from "@netrics/contracts";
import {
  STUDIO_GRID,
  type StudioPlacement,
  type ThemeTokens,
} from "@netrics/domain";

import { LiveWidget, SlideCanvas } from "@/components/studio/slide-canvas";
import {
  widgetName,
  type StudioAction,
  type StudioSlide,
} from "@/lib/studio-document";
import {
  RESIZE_HANDLES,
  dragPlacement,
  gridMetrics,
  pixelsToCells,
  placementBlocker,
  samePlacement,
  type DragHandle,
  type GridMetrics,
} from "@/lib/studio-grid";
import { widgetBoxStyle } from "@/lib/studio-render";
import { themeStyle } from "@/lib/studio-theme";
import type { StudioEnv } from "@/lib/studio-widgets";

/** Pixels a pointer travels before a press becomes a drag (not a click). */
const DRAG_THRESHOLD = 4;

const HELP_ID = "editor-canvas-help";

/** A drag in progress: the widget, what is held, and where it would land. */
export interface CanvasDrag {
  widgetId: string;
  handle: DragHandle;
  pointerId: number;
  startX: number;
  startY: number;
  start: StudioPlacement;
  placement: StudioPlacement;
  moved: boolean;
  metrics: GridMetrics;
}

/**
 * What a key on a focused widget does: arrows move it by one cell,
 * Shift+arrows resize it, Delete or Backspace removes it (Undo brings it
 * back), Escape goes back to the slide. Keys with Ctrl, Cmd or Alt are left
 * to the editor (undo, save) and the slide rail.
 */
export function canvasKeyAction(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
  widgetId: string,
): StudioAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const arrow = arrows[event.key];
  if (arrow) {
    const [dx, dy] = arrow;
    return event.shiftKey
      ? { type: "resizeWidgetBy", widgetId, dw: dx, dh: dy }
      : { type: "nudgeWidget", widgetId, dx, dy };
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return { type: "deleteWidget", widgetId };
  }
  if (event.key === "Escape") {
    return { type: "selectWidget", widgetId: null };
  }
  return null;
}

/** The drag's outline: where the widget would land, and whether it may. */
export function dragOutline(
  drag: Pick<CanvasDrag, "widgetId" | "placement">,
  widgets: readonly DashboardWidget[],
): { placement: StudioPlacement; blocked: boolean; label: string } {
  const widget = widgets.find((w) => w.id === drag.widgetId);
  const others = widgets.filter((w) => w.id !== drag.widgetId);
  const sameSize =
    widget !== undefined &&
    widget.w === drag.placement.w &&
    widget.h === drag.placement.h;
  const blocker = widget
    ? placementBlocker(drag.placement, widget.type, others)
    : null;
  const blocked =
    blocker !== null && !(blocker.kind === "tooSmall" && sameSize);
  const { x, y, w, h } = drag.placement;
  return {
    placement: drag.placement,
    blocked,
    label:
      blocker?.kind === "overlap"
        ? `${w} × ${h} · overlaps ${widgetName(others[blocker.index]!)}`
        : `${w} × ${h} · column ${x + 1}, row ${y + 1}`,
  };
}

/**
 * The selected slide on its 16:9 canvas, with live data, as screens show
 * it (the #220 renderers). Every widget has a focusable handle on top: a
 * click, tap or Enter selects it for the inspector. A selected widget is
 * moved by dragging it and resized from its edges and corners (mouse,
 * touch or pen, with pointer capture), snapping to the 12 × 8 cells; while
 * dragging, the grid shows and an outline with the size follows the
 * pointer, in the warning colour where the widget may not go (a drop there
 * is refused). The keyboard does the same (see `canvasKeyAction`). Each
 * drop or key press is one undo step and is announced by the editor's live
 * region.
 */
export function EditorCanvas({
  slide,
  dashboardName,
  settings,
  tokens,
  env,
  selectedWidgetId,
  widgetsWithProblems,
  dispatch,
  initialDrag = null,
}: {
  slide: StudioSlide;
  dashboardName: string;
  settings: DashboardSettings;
  tokens: ThemeTokens;
  env: StudioEnv;
  selectedWidgetId: string | null;
  widgetsWithProblems: ReadonlySet<string>;
  dispatch: (action: StudioAction) => void;
  /** For tests: render as if a drag were in progress. */
  initialDrag?: CanvasDrag | null;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<CanvasDrag | null>(initialDrag);
  /** The element holding pointer capture during a drag. */
  const captureRef = useRef<HTMLElement | null>(null);

  function beginDrag(
    event: PointerEvent<HTMLElement>,
    widget: DashboardWidget,
    handle: DragHandle,
  ) {
    // Primary button only; touch and pen report button 0 too.
    if (event.button !== 0 || drag) {
      return;
    }
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    event.stopPropagation();
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    captureRef.current = event.currentTarget;
    // Safari does not focus a pressed button: focus it, so Escape cancels
    // the drag and the arrow keys go on from here.
    event.currentTarget
      .closest<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    if (widget.id !== selectedWidgetId) {
      dispatch({ type: "selectWidget", widgetId: widget.id });
    }
    const start = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
    setDrag({
      widgetId: widget.id,
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start,
      placement: start,
      moved: false,
      metrics: gridMetrics(
        { width: rect.width, height: rect.height },
        settings.showHeader,
      ),
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const delta = {
      x: event.clientX - drag.startX,
      y: event.clientY - drag.startY,
    };
    const moved = drag.moved || Math.hypot(delta.x, delta.y) >= DRAG_THRESHOLD;
    if (!moved) {
      return;
    }
    const widget = slide.widgets.find((w) => w.id === drag.widgetId);
    if (!widget) {
      setDrag(null);
      return;
    }
    const placement = dragPlacement(
      drag.start,
      drag.handle,
      pixelsToCells(delta, drag.metrics),
      widget.type,
    );
    if (!drag.moved || !samePlacement(placement, drag.placement)) {
      setDrag({ ...drag, moved: true, placement });
    }
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, drop: boolean) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    setDrag(null);
    captureRef.current = null;
    if (drop && drag.moved && !samePlacement(drag.placement, drag.start)) {
      dispatch({
        type: "placeWidget",
        widgetId: drag.widgetId,
        placement: drag.placement,
      });
    }
  }

  function cancelDrag() {
    if (!drag) {
      return;
    }
    const target = captureRef.current;
    captureRef.current = null;
    setDrag(null);
    if (target?.hasPointerCapture(drag.pointerId)) {
      target.releasePointerCapture(drag.pointerId);
    }
    dispatch({ type: "announce", text: "Drag cancelled." });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (drag) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDrag();
      }
      return;
    }
    const action = canvasKeyAction(event, id);
    if (!action) {
      return;
    }
    event.preventDefault();
    dispatch(action);
    if (action.type === "deleteWidget") {
      // The widget's button goes away: keep focus on the canvas.
      overlayRef.current?.focus();
    }
  }

  const outline = drag?.moved ? dragOutline(drag, slide.widgets) : null;

  return (
    <div className="editor-canvas" style={themeStyle(tokens)}>
      <SlideCanvas
        slide={slide}
        tokens={tokens}
        showHeader={settings.showHeader}
        header={{
          name: dashboardName.trim() || "Untitled",
          slideName: slide.name,
          logoImageId: settings.logoImageId,
          timeZone: env.timeZone,
        }}
        images={env.images}
        renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
      />
      <div
        ref={overlayRef}
        className={
          drag?.moved
            ? "editor-overlay editor-overlay--dragging"
            : "editor-overlay"
        }
        role="group"
        tabIndex={-1}
        aria-label="Slide canvas"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            dispatch({ type: "selectWidget", widgetId: null });
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onLostPointerCapture={(event) => endDrag(event, false)}
      >
        {outline ? (
          <div className="editor-grid" aria-hidden="true">
            {Array.from({ length: STUDIO_GRID.rows }, (_, y) =>
              Array.from({ length: STUDIO_GRID.columns }, (_, x) => (
                <span
                  key={`${x}-${y}`}
                  className="editor-grid-cell"
                  style={widgetBoxStyle(
                    { x, y, w: 1, h: 1 },
                    settings.showHeader,
                  )}
                />
              )),
            )}
          </div>
        ) : null}
        {slide.widgets.map((widget) => {
          const selected = widget.id === selectedWidgetId;
          const problem = widgetsWithProblems.has(widget.id);
          const dragging = drag?.moved && drag.widgetId === widget.id;
          return (
            <button
              key={widget.id}
              type="button"
              data-widget-id={widget.id}
              className={[
                "editor-widget",
                selected ? "editor-widget--selected" : "",
                problem ? "editor-widget--problem" : "",
                dragging ? "editor-widget--dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={widgetBoxStyle(widget, settings.showHeader)}
              aria-pressed={selected}
              aria-label={`${widgetName(widget)}, column ${widget.x + 1}, row ${widget.y + 1}, ${widget.w} by ${widget.h} cells${problem ? ", has a problem" : ""}`}
              aria-describedby={HELP_ID}
              onClick={() =>
                dispatch({ type: "selectWidget", widgetId: widget.id })
              }
              onPointerDown={(event) => beginDrag(event, widget, "move")}
              onKeyDown={(event) => onKeyDown(event, widget.id)}
            >
              {selected
                ? RESIZE_HANDLES.map((handle) => (
                    <span
                      key={handle}
                      className={`editor-handle editor-handle--${handle}`}
                      data-handle={handle}
                      aria-hidden="true"
                      onPointerDown={(event) =>
                        beginDrag(event, widget, handle)
                      }
                    />
                  ))
                : null}
            </button>
          );
        })}
        {outline ? (
          <div
            className={
              outline.blocked
                ? "editor-outline editor-outline--blocked"
                : "editor-outline"
            }
            style={widgetBoxStyle(outline.placement, settings.showHeader)}
            aria-hidden="true"
          >
            <span className="editor-readout">{outline.label}</span>
          </div>
        ) : null}
      </div>
      <p id={HELP_ID} className="visually-hidden">
        Arrow keys move the widget by one cell, Shift and arrow keys resize it,
        Delete removes it, Escape goes back to the slide.
      </p>
      {slide.widgets.length === 0 ? (
        <p className="editor-empty">This slide is empty. Add a widget above.</p>
      ) : null}
    </div>
  );
}
