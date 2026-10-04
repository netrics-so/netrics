import { describe, expect, it, vi } from "vitest";

import type { DashboardWidget } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import { CreateDashboardForm } from "@/app/workspaces/[workspaceId]/create-dashboard-form";
import { renderI18n } from "@/lib/i18n/test-render";
import type { StudioDocument, StudioSlide } from "@/lib/studio-document";
import { autoAsCustom, toSlideLayout } from "@/lib/studio-layouts";
import type { StudioEnv } from "@/lib/studio-widgets";

import { CustomFormatEditor, MakePrimaryButton } from "./custom-format";
import { EditorCanvas } from "./editor-canvas";

// The custom layout editor of a format (ADR 0017 section 4, #284) and the
// primary format choice, as static markup in English and German.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function text(id: number, x: number, y: number, w = 3, h = 2): DashboardWidget {
  return {
    type: "text",
    id: ID(id),
    x,
    y,
    w,
    h,
    title: `Card ${id}`,
    text: `Card ${id}`,
    options: { size: "body", align: "start" },
  };
}

function chart(id: number, x: number): DashboardWidget {
  return {
    type: "line",
    id: ID(id),
    x,
    y: 2,
    w: 6,
    h: 6,
    title: `Chart ${id}`,
    connectionId: ID(9),
    metricKey: "downloads",
    aggregation: "sum",
    period: "last_7_days",
    dimensions: {},
    displayCurrency: null,
    resourceName: null,
    allResourcesName: null,
    options: { showPrevious: false, showAxis: true },
  } as DashboardWidget;
}

/** Four cards over two charts: two pages in 9:16. */
const WIDGETS = [
  text(11, 0, 0),
  text(12, 3, 0),
  text(13, 6, 0),
  text(14, 9, 0),
  chart(15, 0),
  chart(16, 6),
];

const auto = autoAsCustom({ widgets: WIDGETS }, "16x9", "9x16");
/** 9:16 by hand: card 12 hidden, card 11 placed automatically. */
const custom = {
  ...auto,
  placements: auto.placements.map((placement) =>
    placement.id === ID(12)
      ? { ...placement, hidden: true }
      : placement.id === ID(11)
        ? { ...placement, autoPlaced: true }
        : placement,
  ),
};

const slide: StudioSlide = {
  id: ID(2),
  name: "Sales",
  durationSeconds: null,
  enabled: true,
  background: null,
  widgets: WIDGETS,
  layouts: [toSlideLayout("9x16", custom)],
};

const document: StudioDocument = {
  name: "Overview",
  projectId: null,
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
  slides: [slide],
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

const noop = () => undefined;

function editor(locale: "en" | "de", selected: string | null = ID(11)) {
  return renderI18n(
    <CustomFormatEditor
      slide={slide}
      format="9x16"
      primaryFormat="16x9"
      page={0}
      document={document}
      settings={document.settings}
      tokens={BUILTIN_THEMES.netrics_dark.tokens}
      env={env}
      selectedWidgetId={selected}
      widgetsWithProblems={new Set()}
      warnings={new Map()}
      panelId="stage"
      dispatch={noop}
      onPage={noop}
      makePrimary={
        <MakePrimaryButton
          format="9x16"
          primaryFormat="16x9"
          document={document}
          blockers={[]}
          disabled={false}
          onMake={noop}
        />
      }
    />,
    locale,
  );
}

describe("CustomFormatEditor", () => {
  it("edits the format's pages on its own grid", () => {
    const html = editor("en");
    expect(html).toContain('data-format="9x16"');
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("+ Add page");
    expect(html).toContain("Remove page 1");
    expect(html).toContain("Back to automatic");
    expect(html).toContain("Make 9:16 the primary format");
    expect(html).toContain(
      "Position, size, page and visibility here apply to 9:16 only.",
    );
    // The page label in the canvas header.
    expect(html).toContain("1/2");
  });

  it("shows review flags, the selected widget's actions and hidden widgets", () => {
    const html = editor("en");
    expect(html).toContain(
      "1 widget was placed automatically after a change in 16:9",
    );
    expect(html).toContain("Looks good (1 widget)");
    expect(html).toContain("editor-widget--review");
    expect(html).toContain("Placed automatically, to review");
    // Card 11 is selected and flagged.
    expect(html).toContain(">Looks good<");
    expect(html).toContain("Hide in 9:16");
    expect(html).toContain("Move to page");
    expect(html).toContain("Hidden in 9:16");
    expect(html).toContain('aria-label="Show Card 12 (text) in 9:16"');
    // The hidden card is not on the canvas.
    expect(html).not.toContain(
      `data-widget-id="${ID(12)}" class="editor-widget`,
    );
  });

  it("says it in German", () => {
    const html = editor("de");
    expect(html).toContain("Seite hinzufügen");
    expect(html).toContain("Zurück zu automatisch");
    expect(html).toContain("Passt so (1 Widget)");
    expect(html).toContain("In 9:16 ausgeblendet");
    expect(html).toContain("9:16 zum primären Format machen");
    expect(html).toContain("Automatisch platziert, zu prüfen");
  });

  it("renders nothing for a format laid out automatically", () => {
    const html = renderI18n(
      <CustomFormatEditor
        slide={{ ...slide, layouts: [] }}
        format="9x16"
        primaryFormat="16x9"
        page={0}
        document={document}
        settings={document.settings}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        env={env}
        selectedWidgetId={null}
        widgetsWithProblems={new Set()}
        warnings={new Map()}
        panelId="stage"
        dispatch={noop}
        onPage={noop}
      />,
    );
    expect(html).toBe("");
  });
});

describe("EditorCanvas on a custom page", () => {
  it("places the page's widgets on the format's grid, with the keyboard help for it", () => {
    const html = renderI18n(
      <EditorCanvas
        slide={slide}
        dashboardName="Overview"
        settings={document.settings}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        env={env}
        selectedWidgetId={null}
        widgetsWithProblems={new Set()}
        dispatch={noop}
        primaryFormat="16x9"
        format="9x16"
        layout={{
          placements: custom.placements.filter(
            (placement) => placement.page === 1,
          ),
          review: new Set(),
        }}
      />,
    );
    // Page 2 holds only the second chart.
    expect(html.match(/class="editor-widget/g)).toHaveLength(1);
    expect(html).toContain(`data-widget-id="${ID(16)}"`);
    expect(html).toContain("Delete hides it in this format");
    expect(html).toContain("aspect-ratio:1080 / 1920");
  });

  it("shows an empty page", () => {
    const html = renderI18n(
      <EditorCanvas
        slide={slide}
        dashboardName="Overview"
        settings={document.settings}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        env={env}
        selectedWidgetId={null}
        widgetsWithProblems={new Set()}
        dispatch={noop}
        primaryFormat="16x9"
        format="9x16"
        layout={{ placements: [], review: new Set() }}
      />,
    );
    expect(html).toContain("Nothing on this page yet.");
  });

  it("edits a 9:16 primary on its own grid", () => {
    const html = renderI18n(
      <EditorCanvas
        slide={{ ...slide, widgets: [text(11, 0, 12)], layouts: [] }}
        dashboardName="Overview"
        settings={document.settings}
        tokens={BUILTIN_THEMES.netrics_dark.tokens}
        env={env}
        selectedWidgetId={null}
        widgetsWithProblems={new Set()}
        dispatch={noop}
        primaryFormat="9x16"
        format="9x16"
      />,
    );
    expect(html).toContain('data-format="9x16"');
    expect(html).toContain("row 13");
    expect(html).toContain("Delete removes it");
  });
});

describe("MakePrimaryButton", () => {
  it("offers the change", () => {
    const html = renderI18n(
      <MakePrimaryButton
        format="4x3"
        primaryFormat="16x9"
        document={document}
        blockers={[{ slideId: ID(2), reason: "overflow" }]}
        disabled={false}
        onMake={noop}
      />,
      "de",
    );
    expect(html).toContain("4:3 zum primären Format machen");
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("new dashboard", () => {
  it("lets a blank dashboard start in any format", () => {
    const html = renderI18n(<CreateDashboardForm workspaceId={ID(3)} />);
    expect(html).toContain("Screen format");
    for (const ratio of ["16:9", "9:16", "21:9", "4:3", "3:4"]) {
      expect(html).toContain(`>${ratio}<`);
    }
    expect(html).toMatch(
      /<input[^>]*(value="16x9"[^>]*checked=""|checked=""[^>]*value="16x9")/,
    );
    expect(html).toContain("Portrait");
    const de = renderI18n(<CreateDashboardForm workspaceId={ID(3)} />, "de");
    expect(de).toContain("Bildschirmformat");
    expect(de).toContain("Hochformat");
  });
});
