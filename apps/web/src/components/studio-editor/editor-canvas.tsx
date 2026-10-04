"use client";

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type { DashboardSettings, DashboardWidget } from "@netrics/contracts";
import {
  SCREEN_FORMATS,
  type Locale,
  type ScreenFormat,
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
import type { UnreadableLabel } from "@/lib/studio-readability";
import { canvasGeometry } from "@/lib/screen-view";
import { useLocale, useT } from "@/lib/i18n/client";
import { themeStyle } from "@/lib/studio-theme";
import type { StudioEnv } from "@/lib/studio-widgets";
import { webTranslator } from "@/lib/i18n/catalogs";

/** Pixels a pointer travels before a press becomes a drag (not a click). */
const DRAG_THRESHOLD = 4;

const HELP_ID = "editor-canvas-help";

const NO_LABELS: ReadonlyMap<string, UnreadableLabel> = new Map();

/** An outline on the canvas: where a widget would go, and whether it may. */
export interface CanvasOutline {
  placement: StudioPlacement;
  blocked: boolean;
  label: string;
}

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
 * to the editor (undo, save) and the slide rail. In a custom layout
 * (`format`, #284) the arrows act on that format and Delete hides the
 * widget there instead of deleting it everywhere.
 */
export function canvasKeyAction(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
  widgetId: string,
  format?: ScreenFormat,
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
  const inFormat = format ? { format } : {};
  if (arrow) {
    const [dx, dy] = arrow;
    return event.shiftKey
      ? { type: "resizeWidgetBy", widgetId, dw: dx, dh: dy, ...inFormat }
      : { type: "nudgeWidget", widgetId, dx, dy, ...inFormat };
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return format
      ? { type: "setWidgetHidden", widgetId, format, hidden: true }
      : { type: "deleteWidget", widgetId };
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
  locale: Locale,
  format: ScreenFormat = "16x9",
): { placement: StudioPlacement; blocked: boolean; label: string } {
  const t = webTranslator(locale, "studio.canvas");
  const widget = widgets.find((w) => w.id === drag.widgetId);
  const others = widgets.filter((w) => w.id !== drag.widgetId);
  const sameSize =
    widget !== undefined &&
    widget.w === drag.placement.w &&
    widget.h === drag.placement.h;
  const blocker = widget
    ? placementBlocker(drag.placement, widget.type, others, format)
    : null;
  const blocked =
    blocker !== null && !(blocker.kind === "tooSmall" && sameSize);
  const { x, y, w, h } = drag.placement;
  return {
    placement: drag.placement,
    blocked,
    label:
      blocker?.kind === "overlap"
        ? t("readoutOverlap", {
            w,
            h,
            other: widgetName(others[blocker.index]!, locale),
          })
        : t("readout", { w, h, column: x + 1, row: y + 1 }),
  };
}

/** The grid's cells no widget covers, row by row. */
export function freeCells(
  widgets: ReadonlyArray<StudioPlacement>,
  columns: number,
  rows: number,
): Array<{ x: number; y: number }> {
  const covered = (x: number, y: number) =>
    widgets.some(
      (widget) =>
        x >= widget.x &&
        x < widget.x + widget.w &&
        y >= widget.y &&
        y < widget.y + widget.h,
    );
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (!covered(x, y)) cells.push({ x, y });
    }
  }
  return cells;
}

/** A page of a custom layout the canvas edits (#284). */
export interface CanvasLayoutPage {
  /** The visible widgets of the page, at their placements in the format. */
  placements: ReadonlyArray<StudioPlacement & { id: string }>;
  /** Widgets placed automatically, waiting for review. */
  review: ReadonlySet<string>;
}

/**
 * The selected slide on its canvas, with live data, as screens show it
 * (the #220 renderers): the primary format's grid, or (with `layout`) one
 * page of the slide's custom layout in `format` (ADR 0017 section 4). Every widget has a focusable handle on top: a
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
  unreadable = NO_LABELS,
  incoming = null,
  initialDrag = null,
  primaryFormat = "16x9",
  format = primaryFormat,
  layout = null,
  pageLabel = null,
}: {
  slide: StudioSlide;
  dashboardName: string;
  settings: DashboardSettings;
  tokens: ThemeTokens;
  env: StudioEnv;
  selectedWidgetId: string | null;
  widgetsWithProblems: ReadonlySet<string>;
  dispatch: (action: StudioAction) => void;
  /** Widgets whose label is cut off on TVs, by widget id (#241). */
  unreadable?: ReadonlyMap<string, UnreadableLabel>;
  /** A new widget being dragged in from the add menu (#241). */
  incoming?: CanvasOutline | null;
  /** For tests: render as if a drag were in progress. */
  initialDrag?: CanvasDrag | null;
  /** The format the slide's widgets are placed in. */
  primaryFormat?: ScreenFormat;
  /** The format edited: the primary, or one with a custom layout. */
  format?: ScreenFormat;
  /** The page of the custom layout edited, when `format` is not the primary. */
  layout?: CanvasLayoutPage | null;
  /** "1/2" in the header for a layout on several pages. */
  pageLabel?: string | null;
}) {
  const locale = useLocale();
  const t = useT("studio.canvas");
  const custom = layout !== null && format !== primaryFormat;
  const customFormat = custom ? format : undefined;
  // The widgets as this canvas places them: in a custom layout, the
  // page's widgets at their placements in the format.
  const widgets: DashboardWidget[] = useMemo(() => {
    if (!custom) return slide.widgets;
    const byId = new Map(slide.widgets.map((widget) => [widget.id, widget]));
    return layout.placements.flatMap((placement) => {
      const widget = byId.get(placement.id);
      return widget
        ? [
            {
              ...widget,
              x: placement.x,
              y: placement.y,
              w: placement.w,
              h: placement.h,
            } as DashboardWidget,
          ]
        : [];
    });
  }, [custom, layout, slide.widgets]);
  const review = custom ? layout.review : null;
  const grid = SCREEN_FORMATS[format];
  const geometry = canvasGeometry(null, format, settings.showHeader);
  const boxOf = (placement: StudioPlacement) => geometry.widget(placement).box;
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
        format,
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
    const widget = widgets.find((w) => w.id === drag.widgetId);
    if (!widget) {
      setDrag(null);
      return;
    }
    const placement = dragPlacement(
      drag.start,
      drag.handle,
      pixelsToCells(delta, drag.metrics),
      widget.type,
      format,
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
        ...(customFormat ? { format: customFormat } : {}),
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
    dispatch({ type: "announce", text: t("dragCancelled") });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (drag) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDrag();
      }
      return;
    }
    const action = canvasKeyAction(event, id, customFormat);
    if (!action) {
      return;
    }
    event.preventDefault();
    dispatch(action);
    if (action.type === "deleteWidget" || action.type === "setWidgetHidden") {
      // The widget's button goes away: keep focus on the canvas.
      overlayRef.current?.focus();
    }
  }

  const outline: CanvasOutline | null = drag?.moved
    ? dragOutline(drag, widgets, locale, format)
    : incoming;
  const reference = grid.reference;
  const classic = format === "16x9";
  // Formats other than 16:9 keep their shape and fit the stage's height.
  const shape: CSSProperties = classic
    ? {}
    : {
        width: "100%",
        maxWidth: `calc(70vh * ${reference.width} / ${reference.height})`,
        marginInline: "auto",
      };

  return (
    <div
      className="editor-canvas"
      data-format={format}
      style={{ ...themeStyle(tokens), ...shape }}
    >
      <SlideCanvas
        slide={slide}
        tokens={tokens}
        showHeader={settings.showHeader}
        header={{
          name: dashboardName.trim() || t("untitled"),
          slideName: slide.name,
          pageLabel,
          logoImageId: settings.logoImageId,
          timeZone: env.timeZone,
        }}
        images={env.images}
        renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
        primaryFormat={primaryFormat}
        format={format}
        {...(custom ? { placements: layout.placements } : {})}
        {...(classic
          ? {}
          : {
              screen: { width: reference.width, height: reference.height },
              style: {
                aspectRatio: `${reference.width} / ${reference.height}`,
              },
            })}
      />
      <div
        ref={overlayRef}
        className={
          drag?.moved
            ? "editor-overlay editor-overlay--dragging"
            : "editor-overlay"
        }
        data-editor-overlay=""
        role="group"
        tabIndex={-1}
        aria-label={t("label")}
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
            {Array.from({ length: grid.rows }, (_, y) =>
              Array.from({ length: grid.columns }, (_, x) => (
                <span
                  key={`${x}-${y}`}
                  className="editor-grid-cell"
                  style={boxOf({ x, y, w: 1, h: 1 })}
                />
              )),
            )}
          </div>
        ) : (
          // The 12 × 8 grid, faintly, where no widget covers it (design 3b).
          <div className="editor-gridlines" aria-hidden="true">
            {freeCells(widgets, grid.columns, grid.rows).map(({ x, y }) => (
              <span
                key={`${x}-${y}`}
                className="editor-gridline"
                style={boxOf({ x, y, w: 1, h: 1 })}
              />
            ))}
          </div>
        )}
        {widgets.map((widget) => {
          const selected = widget.id === selectedWidgetId;
          const problem = widgetsWithProblems.has(widget.id);
          const dragging = drag?.moved && drag.widgetId === widget.id;
          // Label fit is measured on the primary canvas; a custom format
          // has its own warnings below the canvas.
          const cut = custom ? undefined : unreadable.get(widget.id);
          const toReview = review?.has(widget.id) ?? false;
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
                cut ? "editor-widget--unreadable" : "",
                toReview ? "editor-widget--review" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={boxOf(widget)}
              aria-pressed={selected}
              aria-label={`${t("widgetLabel", {
                name: widgetName(widget, locale),
                column: widget.x + 1,
                row: widget.y + 1,
                w: widget.w,
                h: widget.h,
                problem: problem ? "yes" : "no",
              })}${cut ? `. ${cut.hint}` : ""}${toReview ? `. ${t("toReviewLabel")}` : ""}`}
              aria-describedby={HELP_ID}
              onClick={() =>
                dispatch({ type: "selectWidget", widgetId: widget.id })
              }
              onPointerDown={(event) => beginDrag(event, widget, "move")}
              onKeyDown={(event) => onKeyDown(event, widget.id)}
            >
              {cut ? (
                <span
                  className={
                    selected
                      ? `editor-badge editor-badge--hint editor-badge--${widget.y + widget.h > grid.rows - 2 ? "above" : "below"}`
                      : "editor-badge"
                  }
                  title={cut.hint}
                  aria-hidden="true"
                >
                  {selected
                    ? cut.hint
                    : cut.kind === "text"
                      ? t("textCut")
                      : t("labelCut")}
                </span>
              ) : null}
              {toReview ? (
                <span className="editor-review" aria-hidden="true">
                  {t("toReview")}
                </span>
              ) : null}
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
            style={boxOf(outline.placement)}
            aria-hidden="true"
          >
            <span className="editor-readout">{outline.label}</span>
          </div>
        ) : null}
      </div>
      <p id={HELP_ID} className="visually-hidden">
        {custom ? t("keyboardHelpCustom") : t("keyboardHelp")}
      </p>
      {widgets.length === 0 ? (
        <p className="editor-empty">
          {custom
            ? slide.widgets.length === 0
              ? t("emptyCustomSlide")
              : t("emptyPage")
            : t("empty")}
        </p>
      ) : null}
    </div>
  );
}
