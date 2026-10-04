"use client";

import { useRef, type PointerEvent } from "react";

import type { WorkspaceMetric } from "@netrics/contracts";
import {
  WIDGET_TYPES,
  type Locale,
  type ScreenFormat,
  type StudioPlacement,
  type WidgetType,
} from "@netrics/domain";

import {
  DEFAULT_WIDGET_SIZE,
  addWidgetBlocker,
  widgetTypeName,
  type NewWidget,
  type StudioAction,
  type StudioDocument,
  type StudioSlide,
} from "@/lib/studio-document";
import { dropPlacement, gridMetrics } from "@/lib/studio-grid";
import { webTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import { newWidget } from "@/lib/studio-new-widget";

import type { CanvasOutline } from "./editor-canvas";

/** Pixels a pointer travels before a press becomes a drag (not a click). */
const DRAG_THRESHOLD = 4;

interface MenuDrag {
  type: WidgetType;
  widget: NewWidget;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  drop: StudioPlacement | null;
  blocked: boolean;
}

/** The outline's text for a new widget dragged over the canvas. */
export function incomingLabel(
  placement: StudioPlacement,
  blocked: boolean,
  locale: Locale,
): string {
  const t = webTranslator(locale, "studio.canvas");
  const { w, h } = placement;
  return blocked
    ? t("readoutNoRoom", { w, h })
    : t("readout", { w, h, column: placement.x + 1, row: placement.y + 1 });
}

/**
 * "Add" buttons for every widget type. A click (or Enter) puts the new
 * widget in the first free spot on the slide; dragging a button onto the
 * canvas puts it where it is dropped, with the same outline as a move
 * (#241). A type that cannot be added says why.
 */
export function AddWidgetMenu({
  document,
  slide,
  metrics,
  imageIds,
  dispatch,
  showHeader = true,
  primaryFormat = "16x9",
  onDragNew,
}: {
  document: StudioDocument;
  slide: StudioSlide;
  metrics: readonly WorkspaceMetric[];
  imageIds: readonly string[];
  dispatch: (action: StudioAction) => void;
  /** Whether the canvas shows the header (it moves the grid). */
  showHeader?: boolean;
  /** The format the canvas edits (its grid). */
  primaryFormat?: ScreenFormat;
  /** The outline to show on the canvas while dragging, null to clear it. */
  onDragNew?: (outline: CanvasOutline | null) => void;
}) {
  const locale = useLocale();
  const t = useT("studio.addMenu");
  const documentText = useT("studio.document");
  const drag = useRef<MenuDrag | null>(null);
  /** A drag ends with a click on the button: that click adds nothing. */
  const suppressClick = useRef(false);

  function onPointerDown(
    event: PointerEvent<HTMLButtonElement>,
    type: WidgetType,
    widget: NewWidget,
  ) {
    suppressClick.current = false;
    if (event.button !== 0 || !onDragNew) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      type,
      widget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      drop: null,
      blocked: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId || !onDragNew) {
      return;
    }
    if (
      !current.moved &&
      Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY,
      ) < DRAG_THRESHOLD
    ) {
      return;
    }
    current.moved = true;
    const overlay = window.document.querySelector<HTMLElement>(
      "[data-editor-overlay]",
    );
    const rect = overlay?.getBoundingClientRect();
    const inside =
      rect &&
      rect.width > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!rect || !inside) {
      current.drop = null;
      onDragNew(null);
      return;
    }
    const { placement, blocked } = dropPlacement(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      gridMetrics(
        { width: rect.width, height: rect.height },
        showHeader,
        primaryFormat,
      ),
      current.type,
      DEFAULT_WIDGET_SIZE[current.type],
      slide.widgets,
      primaryFormat,
    );
    current.drop = placement;
    current.blocked = blocked;
    onDragNew({
      placement,
      blocked,
      label: incomingLabel(placement, blocked, locale),
    });
  }

  function onPointerEnd(event: PointerEvent<HTMLButtonElement>, drop: boolean) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) {
      return;
    }
    drag.current = null;
    onDragNew?.(null);
    if (!current.moved) {
      return;
    }
    suppressClick.current = true;
    if (!drop || !current.drop) {
      return;
    }
    if (current.blocked) {
      dispatch({ type: "announce", text: documentText("spotTaken") });
      return;
    }
    dispatch({
      type: "addWidgetAt",
      widget: current.widget,
      placement: current.drop,
    });
  }

  return (
    <div className="add-widget" role="group" aria-label={t("group")}>
      <span className="add-widget-label" aria-hidden="true">
        {t("add")}
      </span>
      {WIDGET_TYPES.map((type) => {
        const made = newWidget(type, { metrics, imageIds, locale });
        const reason =
          "reason" in made
            ? made.reason
            : addWidgetBlocker(document, slide, type, locale);
        return (
          <button
            key={type}
            type="button"
            disabled={reason !== null}
            title={reason ?? (onDragNew ? t("hint") : undefined)}
            aria-label={`${t("addType", { type })}${reason ? ` (${reason})` : ""}`}
            onPointerDown={(event) => {
              if ("widget" in made) {
                onPointerDown(event, type, made.widget);
              }
            }}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => onPointerEnd(event, true)}
            onPointerCancel={(event) => onPointerEnd(event, false)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if ("widget" in made) {
                dispatch({ type: "addWidget", widget: made.widget });
              }
            }}
          >
            {widgetTypeName(type, locale)}
          </button>
        );
      })}
    </div>
  );
}
