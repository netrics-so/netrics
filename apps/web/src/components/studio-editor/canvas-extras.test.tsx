import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  DashboardSettings,
  DashboardWidget,
  WorkspaceMetric,
} from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import type { StudioDocument, StudioSlide } from "@/lib/studio-document";
import type { UnreadableLabel } from "@/lib/studio-readability";
import type { StudioEnv } from "@/lib/studio-widgets";

import { AddWidgetMenu, incomingLabel } from "./add-widget-menu";
import { WidgetClipboardBar, clipboardKey } from "./canvas-extras";
import { EditorCanvas } from "./editor-canvas";
import { SlideRail, cutOffText } from "./slide-rail";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dark = BUILTIN_THEMES.netrics_dark.tokens;
const noop = () => undefined;

const text: DashboardWidget = {
  type: "text",
  id: ID(21),
  x: 0,
  y: 0,
  w: 4,
  h: 2,
  title: "Notes",
  text: "Hello",
  options: { size: "body", align: "start" },
};

const slide: StudioSlide = {
  id: ID(2),
  name: null,
  durationSeconds: null,
  enabled: true,
  background: null,
  widgets: [text],
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

const cut: UnreadableLabel = {
  slideId: ID(2),
  widgetId: ID(21),
  label: "A long title",
  fit: { fits: false, titleLines: 3, resourceLines: 0 },
  fitsAtWidth: 6,
  hint: "The title is cut off on TVs. Make it 6 cells wide or shorten the title.",
};

function canvas(extra: Partial<Parameters<typeof EditorCanvas>[0]> = {}) {
  return renderToStaticMarkup(
    <EditorCanvas
      slide={slide}
      dashboardName="Overview"
      settings={settings}
      tokens={dark}
      env={env}
      selectedWidgetId={null}
      widgetsWithProblems={new Set()}
      dispatch={noop}
      {...extra}
    />,
  );
}

describe("readability badges", () => {
  it("marks a widget whose label is cut off and says why in its name", () => {
    const html = canvas({ unreadable: new Map([[ID(21), cut]]) });
    expect(html).toContain("editor-widget--unreadable");
    expect(html).toContain(">Label cut off</span>");
    expect(html).toContain(`title="${cut.hint}"`);
    expect(html).toContain(
      `aria-label="Notes (text), column 1, row 1, 4 by 2 cells. ${cut.hint}"`,
    );
  });

  it("spells out the fix on the selected widget", () => {
    const html = canvas({
      unreadable: new Map([[ID(21), cut]]),
      selectedWidgetId: ID(21),
    });
    expect(html).toContain(`>${cut.hint}</span>`);
  });

  it("shows no badge on readable widgets", () => {
    expect(canvas()).not.toContain("editor-badge");
  });

  it("shows the count per slide in the rail", () => {
    const html = renderToStaticMarkup(
      <SlideRail
        slides={[slide, { ...slide, id: ID(3), widgets: [] }]}
        selectedSlideId={ID(2)}
        tokens={dark}
        defaultSeconds={20}
        slidesWithProblems={new Set()}
        unreadableCounts={new Map([[ID(2), 2]])}
        images={[]}
        dispatch={noop}
      />,
    );
    expect(html).toContain(
      "1 of 2: Slide 1, 20 seconds, 2 labels cut off on TVs",
    );
    expect(html.match(/rail-unreadable/g)).toHaveLength(1);
    expect(cutOffText(1)).toBe("1 label cut off");
  });
});

describe("a new widget dragged from the add menu", () => {
  it("shows the grid and its outline on the canvas", () => {
    const placement = { x: 4, y: 3, w: 4, h: 2 };
    const html = canvas({
      incoming: {
        placement,
        blocked: false,
        label: incomingLabel(placement, false),
      },
    });
    expect(html).toContain('class="editor-outline"');
    expect(html).toContain("4 × 2 · column 5, row 4");
    expect(html).toContain("editor-grid-cell");
    expect(html).toContain("data-editor-overlay");
  });

  it("is in the warning colour where there is no room", () => {
    const placement = { x: 0, y: 0, w: 4, h: 2 };
    const html = canvas({
      incoming: {
        placement,
        blocked: true,
        label: incomingLabel(placement, true),
      },
    });
    expect(html).toContain("editor-outline--blocked");
    expect(html).toContain("4 × 2 · no room here");
  });

  it("tells pointer users they can drag the add buttons", () => {
    const document: StudioDocument = {
      name: "Overview",
      projectId: null,
      settings,
      slides: [slide],
    };
    const html = renderToStaticMarkup(
      <AddWidgetMenu
        document={document}
        slide={slide}
        metrics={[] as WorkspaceMetric[]}
        imageIds={[]}
        dispatch={noop}
        onDragNew={noop}
      />,
    );
    expect(html).toContain(
      'title="Click to add it in the first free spot, or drag it onto the slide"',
    );
  });
});

describe("widget clipboard", () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  it("maps Cmd/Ctrl+C, V and D", () => {
    expect(clipboardKey(key("c", { metaKey: true }))).toBe("copy");
    expect(clipboardKey(key("V", { ctrlKey: true }))).toBe("paste");
    expect(clipboardKey(key("d", { metaKey: true }))).toBe("duplicate");
    expect(clipboardKey(key("d"))).toBe(null);
    expect(clipboardKey(key("z", { metaKey: true }))).toBe(null);
    expect(clipboardKey(key("c", { metaKey: true, shiftKey: true }))).toBe(
      null,
    );
  });

  it("offers buttons with their shortcuts, enabled when they apply", () => {
    const none = renderToStaticMarkup(
      <WidgetClipboardBar
        selected={null}
        clipboard={null}
        onCopy={noop}
        onPaste={noop}
        onDuplicate={noop}
      />,
    );
    expect(none.match(/disabled=""/g)).toHaveLength(3);
    const ready = renderToStaticMarkup(
      <WidgetClipboardBar
        selected={text}
        clipboard={text}
        onCopy={noop}
        onPaste={noop}
        onDuplicate={noop}
      />,
    );
    expect(ready).not.toContain("disabled");
    expect(ready).toContain('aria-keyshortcuts="Control+D Meta+D"');
    expect(ready).toContain('title="Paste Notes (text)"');
  });
});
