"use client";

import type { KeyboardEvent } from "react";

import type { DashboardSettings } from "@netrics/contracts";
import type { ThemeTokens } from "@netrics/domain";

import { LiveWidget, SlideCanvas } from "@/components/studio/slide-canvas";
import {
  widgetName,
  type StudioAction,
  type StudioSlide,
} from "@/lib/studio-document";
import { widgetBoxStyle } from "@/lib/studio-render";
import { themeStyle } from "@/lib/studio-theme";
import type { StudioEnv } from "@/lib/studio-widgets";

/**
 * The selected slide on its 16:9 canvas, with live data, as screens show
 * it (the #220 renderers). Every widget has a focusable handle on top: a
 * click or Enter selects it for the inspector, Delete removes it, Escape
 * goes back to the slide. Moving and resizing on the grid plug in here
 * (#224) without changing the shell.
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
}: {
  slide: StudioSlide;
  dashboardName: string;
  settings: DashboardSettings;
  tokens: ThemeTokens;
  env: StudioEnv;
  selectedWidgetId: string | null;
  widgetsWithProblems: ReadonlySet<string>;
  dispatch: (action: StudioAction) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "deleteWidget", widgetId: id });
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "selectWidget", widgetId: null });
    }
  }

  return (
    <div className="editor-canvas" style={themeStyle(tokens)}>
      <SlideCanvas
        slide={{ ...slide, position: 0 }}
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
        className="editor-overlay"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            dispatch({ type: "selectWidget", widgetId: null });
          }
        }}
      >
        {slide.widgets.map((widget) => {
          const selected = widget.id === selectedWidgetId;
          const problem = widgetsWithProblems.has(widget.id);
          return (
            <button
              key={widget.id}
              type="button"
              className={[
                "editor-widget",
                selected ? "editor-widget--selected" : "",
                problem ? "editor-widget--problem" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={widgetBoxStyle(widget, settings.showHeader)}
              aria-pressed={selected}
              aria-label={`${widgetName(widget)}, column ${widget.x + 1}, row ${widget.y + 1}, ${widget.w} by ${widget.h} cells${problem ? ", has a problem" : ""}`}
              onClick={() =>
                dispatch({ type: "selectWidget", widgetId: widget.id })
              }
              onKeyDown={(event) => onKeyDown(event, widget.id)}
            />
          );
        })}
      </div>
      {slide.widgets.length === 0 ? (
        <p className="editor-empty">This slide is empty. Add a widget above.</p>
      ) : null}
    </div>
  );
}
