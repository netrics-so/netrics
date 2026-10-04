"use client";

import type { WorkspaceMetric } from "@netrics/contracts";
import { WIDGET_TYPES } from "@netrics/domain";

import {
  addWidgetBlocker,
  widgetTypeName,
  type StudioAction,
  type StudioDocument,
  type StudioSlide,
} from "@/lib/studio-document";
import { newWidget } from "@/lib/studio-new-widget";

/**
 * "Add" buttons for every widget type. A new widget takes the first free
 * spot on the slide; a type that cannot be added says why.
 */
export function AddWidgetMenu({
  document,
  slide,
  metrics,
  imageIds,
  dispatch,
}: {
  document: StudioDocument;
  slide: StudioSlide;
  metrics: readonly WorkspaceMetric[];
  imageIds: readonly string[];
  dispatch: (action: StudioAction) => void;
}) {
  return (
    <div className="add-widget" role="group" aria-label="Add a widget">
      <span className="add-widget-label" aria-hidden="true">
        Add
      </span>
      {WIDGET_TYPES.map((type) => {
        const made = newWidget(type, { metrics, imageIds });
        const reason =
          "reason" in made
            ? made.reason
            : addWidgetBlocker(document, slide, type);
        return (
          <button
            key={type}
            type="button"
            disabled={reason !== null}
            title={reason ?? undefined}
            aria-label={`Add ${widgetTypeName(type).toLowerCase()}${reason ? ` (${reason})` : ""}`}
            onClick={() => {
              if ("widget" in made) {
                dispatch({ type: "addWidget", widget: made.widget });
              }
            }}
          >
            {widgetTypeName(type)}
          </button>
        );
      })}
    </div>
  );
}
