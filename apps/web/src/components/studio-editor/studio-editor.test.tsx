import { describe, expect, it } from "vitest";

import {
  dashboardWidgetInputSchema,
  type Dashboard,
  type DashboardWidget,
  type WorkspaceMetric,
} from "@netrics/contracts";
import { BUILTIN_THEMES, WIDGET_TYPES } from "@netrics/domain";

import { initialStudioState, type StudioSlide } from "@/lib/studio-document";
import { newWidget } from "@/lib/studio-new-widget";
import type { StudioEnv } from "@/lib/studio-widgets";

import { AddWidgetMenu } from "./add-widget-menu";
import { assignmentChanges } from "./assign-tvs";
import { EditorCanvas } from "./editor-canvas";
import { uploadProblem } from "./image-picker";
import {
  DashboardSettingsPanel,
  WidgetPanel,
  accentHint,
  themeChoice,
} from "./inspector";
import { SlideRail, rotationSeconds, rotationText } from "./slide-rail";
import { SlideSettings } from "./slide-settings";
import { leavesPage } from "./use-leave-guard";
import { renderI18n } from "@/lib/i18n/test-render";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dark = BUILTIN_THEMES.netrics_dark.tokens;
const noop = () => undefined;

const metric: WorkspaceMetric = {
  connectionId: ID(9),
  connectionName: "App Store",
  key: "downloads",
  name: "Downloads",
  description: "",
  kind: "counter",
  unit: "count",
  granularity: "day",
  dimensions: ["resource", "territory"],
  aggregations: ["sum"],
  better: "higher",
  role: "primary",
} as WorkspaceMetric;

const textWidget: DashboardWidget = {
  type: "text",
  id: ID(21),
  x: 0,
  y: 0,
  w: 4,
  h: 2,
  title: null,
  text: "## Hello",
  options: { size: "body", align: "start" },
};

function slide(n: number, extra: Partial<StudioSlide> = {}): StudioSlide {
  return {
    id: ID(n),
    name: null,
    durationSeconds: null,
    enabled: true,
    background: null,
    widgets: [],
    ...extra,
  };
}

const dashboard: Dashboard = {
  id: ID(1),
  name: "Overview",
  projectId: null,
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  settings: {
    showHeader: true,
    autoAdvance: true,
    defaultSlideSeconds: 20,
    transition: "fade",
    themeBuiltin: "netrics_dark",
    themeId: null,
    accentColor: null,
    logoImageId: null,
  },
  primaryFormat: "16x9",
  slides: [
    {
      ...slide(2, { widgets: [textWidget] }),
      position: 0,
      layouts: [],
      formatWarnings: [],
    },
  ],
  tiles: [],
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

describe("slide rail", () => {
  const slides = [
    slide(2, { name: "Sales", widgets: [textWidget] }),
    slide(3, { enabled: false, durationSeconds: 45 }),
  ];
  const html = renderI18n(
    <SlideRail
      slides={slides}
      selectedSlideId={ID(3)}
      tokens={dark}
      defaultSeconds={20}
      slidesWithProblems={new Set([ID(2)])}
      dispatch={noop}
    />,
  );

  it("labels every slide with its position, duration and state", () => {
    expect(html).toContain(
      'aria-label="1 of 2: Sales, 20 seconds, has problems"',
    );
    expect(html).toContain(
      'aria-label="2 of 2: Slide 2, 45 seconds, hidden on screens"',
    );
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("Alt plus Arrow Up or Down moves the");
  });

  it("shows the rotation's length and cards with name and duration", () => {
    // Only visible slides count: the hidden one's 45 s do not.
    expect(html).toContain(">· 20 s</span>");
    expect(html).toContain('<span class="rail-seconds">45 s</span>');
    expect(html).toContain('aria-label="Add slide"');
    expect(html).toContain(">+ Add</button>");
    // The settings moved to the inspector.
    expect(html).not.toContain("slide-name");
  });

  it("puts children (the add-widget chips) at its foot", () => {
    const withFoot = renderI18n(
      <SlideRail
        slides={slides}
        selectedSlideId={ID(2)}
        tokens={dark}
        defaultSeconds={20}
        slidesWithProblems={new Set()}
        dispatch={noop}
      >
        <span id="foot" />
      </SlideRail>,
    );
    expect(withFoot).toContain('<div class="rail-foot"><span id="foot">');
  });

  it("formats the rotation in seconds and minutes", () => {
    expect(rotationSeconds(slides, 20)).toBe(20);
    expect(
      rotationSeconds([...slides, slide(4, { durationSeconds: 70 })], 20),
    ).toBe(90);
    expect(rotationText(20, "en")).toBe("20 s");
    expect(rotationText(90, "en")).toBe("1 min 30 s");
    expect(rotationText(120, "en")).toBe("2 min");
    expect(rotationText(Number.NaN, "en")).toBe("0 s");
  });
});

describe("slide settings in the inspector", () => {
  const slides = [
    slide(2, { name: "Sales", widgets: [textWidget] }),
    slide(3, { enabled: false, durationSeconds: 45 }),
  ];
  const settings = (
    selectedSlideId: string,
    list: StudioSlide[] = slides,
    confirmDelete: string | null = null,
  ) =>
    renderI18n(
      <SlideSettings
        slides={list}
        selectedSlideId={selectedSlideId}
        defaultSeconds={20}
        images={[]}
        dispatch={noop}
        confirmDelete={confirmDelete}
        onConfirmDelete={noop}
      />,
    );

  it("edits the selected slide with labelled fields", () => {
    const html = settings(ID(3));
    expect(html).toContain('<h2 id="inspector-slide">Slide 2</h2>');
    expect(html).toContain('<label for="slide-name">Name</label>');
    expect(html).toContain('placeholder="20 (dashboard default)"');
    expect(html).toContain('value="45"');
    expect(html).toContain('disabled="" aria-label="Move slide down"');
  });

  it("never offers to delete the only slide", () => {
    const single = settings(ID(2), [slide(2)]);
    expect(single).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
  });

  it("asks before deleting", () => {
    expect(settings(ID(2))).not.toContain("alertdialog");
    expect(settings(ID(2), slides, ID(2))).toContain(
      "Delete Sales and its widget? You can undo this until you save.",
    );
  });
});

describe("editor canvas", () => {
  it("puts a focusable, labelled handle on every widget", () => {
    const html = renderI18n(
      <EditorCanvas
        slide={slide(2, { widgets: [textWidget] })}
        dashboardName="Overview"
        settings={dashboard.settings}
        tokens={dark}
        env={env}
        selectedWidgetId={ID(21)}
        widgetsWithProblems={new Set([ID(21)])}
        dispatch={noop}
      />,
    );
    expect(html).toContain(
      'aria-label="Text, column 1, row 1, 4 by 2 cells, has a problem"',
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("editor-widget--problem");
    // The live renderer draws the widget underneath.
    expect(html).toContain("Hello");
  });
});

describe("inspector", () => {
  const state = initialStudioState(dashboard, "en");

  const settingsPanel = (
    <DashboardSettingsPanel
      document={{
        ...state.draft,
        settings: { ...state.draft.settings, accentColor: "#20242c" },
      }}
      themes={{
        builtins: Object.entries(BUILTIN_THEMES).map(([key, theme]) => ({
          key: key as "netrics_dark",
          name: theme.name,
          tokens: theme.tokens,
        })),
        custom: [
          {
            id: ID(40),
            name: "Wurfel",
            base: "netrics_dark",
            tokens: dark,
            version: 1,
            warnings: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }}
      baseTokens={dark}
      projects={[]}
      images={[]}
      problems={[]}
      themesHref="/themes"
      dispatch={noop}
    />
  );

  it("shows the dashboard settings as labelled controls", () => {
    const html = renderI18n(settingsPanel);
    for (const label of [
      '<label for="dashboard-name">Name</label>',
      '<label for="dashboard-theme">Theme</label>',
      '<label for="dashboard-logo">Logo</label>',
      '<label for="dashboard-duration">Default duration (seconds)</label>',
      '<label for="dashboard-transition">Transition</label>',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('<optgroup label="Custom">');
    expect(html).toContain(`value="custom:${ID(40)}"`);
    // A dark accent on a dark surface is flagged as unreadable.
    expect(html).toContain("too low to read on a TV");
    expect(html).toContain(">Paper</option>");
  });

  it("names the built-in themes in the viewer's language", () => {
    const html = renderI18n(settingsPanel, "de");
    expect(html).toContain(">Papier</option>");
    expect(html).toContain(">netrics Dunkel</option>");
    expect(html).not.toContain(">Paper</option>");
  });

  it("edits a text widget's title and text", () => {
    const html = renderI18n(
      <WidgetPanel
        widget={textWidget}
        workspaceId={ID(3)}
        metrics={[]}
        images={[]}
        problems={[{ slideId: ID(2), widgetId: ID(21), message: "Overlaps." }]}
        dispatch={noop}
      />,
    );
    expect(html).toContain('<label for="widget-title">Title</label>');
    expect(html).toContain('<label for="widget-text">Text</label>');
    expect(html).toContain("Overlaps.");
    expect(html).toContain("Delete widget");
  });

  it("names the theme choice and judges accent contrast", () => {
    expect(themeChoice({ themeBuiltin: "light", themeId: null })).toBe(
      "builtin:light",
    );
    expect(themeChoice({ themeBuiltin: null, themeId: ID(4) })).toBe(
      `custom:${ID(4)}`,
    );
    expect(accentHint("#ffffff", dark, "en").level).toBe("pass");
    expect(accentHint("#20242c", dark, "en").level).toBe("fail");
  });
});

describe("add widget", () => {
  it("makes every type with defaults the API accepts", () => {
    for (const type of WIDGET_TYPES) {
      const made = newWidget(type, {
        metrics: [metric],
        imageIds: [ID(50)],
        locale: "en",
        goals: [{ id: ID(70), name: "Monthly downloads" }],
        reviewConnectionIds: [ID(70)],
      });
      expect("widget" in made).toBe(true);
      if ("widget" in made) {
        const input = { ...made.widget, id: ID(60), x: 0, y: 0, w: 6, h: 4 };
        expect(() => dashboardWidgetInputSchema.parse(input)).not.toThrow();
      }
    }
  });

  it("says why a type cannot be added yet", () => {
    const state = initialStudioState(dashboard, "en");
    const html = renderI18n(
      <AddWidgetMenu
        document={state.draft}
        slide={state.draft.slides[0]!}
        metrics={[]}
        imageIds={[]}
        dispatch={noop}
      />,
    );
    expect(html).toContain(
      'aria-label="Add metric (Add a connection with metrics first.)"',
    );
    expect(html).toMatch(/aria-label="Add image \(Upload an image first/);
    expect(html).toContain('aria-label="Add text"');
  });

  it("checks uploads before sending them", () => {
    expect(uploadProblem({ type: "image/svg+xml", size: 10 }, "en")).toMatch(
      /PNG, JPEG or WebP/,
    );
    expect(uploadProblem({ type: "image/png", size: 2_000_000 }, "en")).toMatch(
      /1 MiB/,
    );
    expect(uploadProblem({ type: "image/webp", size: 1000 }, "en")).toBeNull();
  });
});

describe("show on TVs", () => {
  it("assigns checked TVs and unassigns unchecked ones", () => {
    const devices = [
      { id: "a", dashboardId: ID(1) },
      { id: "b", dashboardId: ID(2) },
      { id: "c", dashboardId: null },
    ];
    expect(assignmentChanges(devices, ID(1), new Set(["b", "c"]))).toEqual([
      { deviceId: "a", dashboardId: null },
      { deviceId: "b", dashboardId: ID(1) },
      { deviceId: "c", dashboardId: ID(1) },
    ]);
    expect(assignmentChanges(devices, ID(1), new Set(["a"]))).toEqual([]);
  });
});

describe("leave guard", () => {
  const location = {
    href: "https://netrics.example/workspaces/w/dashboards/d/studio",
    origin: "https://netrics.example",
  };
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  const anchor = (href: string, target = "", download = false) => ({
    href,
    target,
    hasAttribute: (name: string) => name === "download" && download,
  });

  it("asks only for links that leave the page in this tab", () => {
    expect(leavesPage(anchor("/workspaces/w"), click, location)).toBe(true);
    expect(
      leavesPage(
        anchor("/workspaces/w/dashboards/d/studio#x"),
        click,
        location,
      ),
    ).toBe(false);
    expect(leavesPage(anchor("/workspaces/w", "_blank"), click, location)).toBe(
      false,
    );
    expect(
      leavesPage(
        anchor("/workspaces/w"),
        { ...click, metaKey: true },
        location,
      ),
    ).toBe(false);
    expect(leavesPage(anchor("/x", "", true), click, location)).toBe(false);
  });
});
