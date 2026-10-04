import { describe, expect, it } from "vitest";

import type { DashboardSettings, DashboardWidget } from "@netrics/contracts";
import { BUILTIN_THEMES, STUDIO_GRID } from "@netrics/domain";

import type { StudioSlide } from "@/lib/studio-document";
import { gridMetrics } from "@/lib/studio-grid";
import type { StudioEnv } from "@/lib/studio-widgets";

import {
  EditorCanvas,
  canvasKeyAction,
  dragOutline,
  type CanvasDrag,
} from "./editor-canvas";
import { renderI18n } from "@/lib/i18n/test-render";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function text(id: number, x: number, y: number): DashboardWidget {
  return {
    type: "text",
    id: ID(id),
    x,
    y,
    w: 4,
    h: 2,
    title: id === 21 ? "Notes" : null,
    text: "Hello",
    options: { size: "body", align: "start" },
  };
}

const widgets = [text(21, 0, 0), text(22, 6, 0)];

const slide: StudioSlide = {
  id: ID(2),
  name: null,
  durationSeconds: null,
  enabled: true,
  background: null,
  widgets,
};

const settings: DashboardSettings = {
  showHeader: true,
  autoAdvance: true,
  defaultSlideSeconds: 20,
  transition: "fade",
  themeBuiltin: "netrics_dark",
  themeId: null,
  accentColor: null,
  logoImageId: null,
};

const env: StudioEnv = {
  workspaceId: ID(3),
  timeZone: "Europe/Berlin",
  fontScale: 1,
  showHeader: true,
  metrics: new Map(),
  connections: {},
  images: new Map(),
};

function render(
  selectedWidgetId: string | null,
  initialDrag: CanvasDrag | null = null,
) {
  return renderI18n(
    <EditorCanvas
      slide={slide}
      dashboardName="Overview"
      settings={settings}
      tokens={BUILTIN_THEMES.netrics_dark.tokens}
      env={env}
      selectedWidgetId={selectedWidgetId}
      widgetsWithProblems={new Set()}
      dispatch={() => undefined}
      initialDrag={initialDrag}
    />,
  );
}

function drag(placement: CanvasDrag["placement"]): CanvasDrag {
  return {
    widgetId: ID(21),
    handle: "move",
    pointerId: 1,
    startX: 0,
    startY: 0,
    start: { x: 0, y: 0, w: 4, h: 2 },
    placement,
    moved: true,
    metrics: gridMetrics({ width: 1920, height: 1080 }, true),
  };
}

const key = (k: string, extra: Partial<Record<string, boolean>> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

describe("canvas keys", () => {
  it("moves with arrows and resizes with Shift+arrows", () => {
    expect(canvasKeyAction(key("ArrowRight"), "w")).toEqual({
      type: "nudgeWidget",
      widgetId: "w",
      dx: 1,
      dy: 0,
    });
    expect(canvasKeyAction(key("ArrowUp"), "w")).toEqual({
      type: "nudgeWidget",
      widgetId: "w",
      dx: 0,
      dy: -1,
    });
    expect(canvasKeyAction(key("ArrowLeft", { shiftKey: true }), "w")).toEqual({
      type: "resizeWidgetBy",
      widgetId: "w",
      dw: -1,
      dh: 0,
    });
    expect(canvasKeyAction(key("ArrowDown", { shiftKey: true }), "w")).toEqual({
      type: "resizeWidgetBy",
      widgetId: "w",
      dw: 0,
      dh: 1,
    });
  });

  it("deletes with Delete or Backspace and deselects with Escape", () => {
    expect(canvasKeyAction(key("Delete"), "w")).toEqual({
      type: "deleteWidget",
      widgetId: "w",
    });
    expect(canvasKeyAction(key("Backspace"), "w")?.type).toBe("deleteWidget");
    expect(canvasKeyAction(key("Escape"), "w")).toEqual({
      type: "selectWidget",
      widgetId: null,
    });
  });

  it("leaves modified keys and other keys to the page", () => {
    expect(canvasKeyAction(key("ArrowUp", { altKey: true }), "w")).toBe(null);
    expect(canvasKeyAction(key("ArrowUp", { metaKey: true }), "w")).toBe(null);
    expect(canvasKeyAction(key("z", { ctrlKey: true }), "w")).toBe(null);
    expect(canvasKeyAction(key("a"), "w")).toBe(null);
    expect(canvasKeyAction(key("Enter"), "w")).toBe(null);
  });
});

describe("drag outline", () => {
  it("shows the size and target cell where the widget may go", () => {
    expect(dragOutline(drag({ x: 1, y: 3, w: 4, h: 2 }), widgets)).toEqual({
      placement: { x: 1, y: 3, w: 4, h: 2 },
      blocked: false,
      label: "4 × 2 · column 2, row 4",
    });
  });

  it("is blocked, naming the widget in the way, over another widget", () => {
    expect(dragOutline(drag({ x: 4, y: 0, w: 4, h: 2 }), widgets)).toEqual({
      placement: { x: 4, y: 0, w: 4, h: 2 },
      blocked: true,
      label: "4 × 2 · overlaps Text",
    });
  });
});

describe("editor canvas", () => {
  it("makes every widget focusable with its place, size and key help", () => {
    const html = render(null);
    expect(html).toContain(
      'aria-label="Notes (text), column 1, row 1, 4 by 2 cells"',
    );
    expect(html).toContain('aria-describedby="editor-canvas-help"');
    expect(html).toContain("Arrow keys move the widget by one cell");
    expect(html).not.toContain("editor-handle");
    expect(html).not.toContain("editor-outline");
  });

  it("gives the selected widget eight resize handles", () => {
    const html = render(ID(21));
    expect(html.match(/class="editor-handle /g)).toHaveLength(8);
    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      expect(html).toContain(`data-handle="${handle}"`);
    }
  });

  it("shows the grid and a live outline with the size while dragging", () => {
    const html = render(ID(21), drag({ x: 1, y: 3, w: 4, h: 2 }));
    expect(html.match(/class="editor-grid-cell"/g)).toHaveLength(
      STUDIO_GRID.columns * STUDIO_GRID.rows,
    );
    expect(html).toContain('class="editor-outline"');
    expect(html).toContain("4 × 2 · column 2, row 4");
    expect(html).toContain("editor-widget--dragging");
  });

  it("draws the outline in the warning colour where it would overlap", () => {
    const html = render(ID(21), drag({ x: 4, y: 0, w: 4, h: 2 }));
    expect(html).toContain('class="editor-outline editor-outline--blocked"');
  });
});
