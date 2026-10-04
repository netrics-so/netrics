import { describe, expect, it } from "vitest";

import type { DashboardWidget } from "@netrics/contracts";
import { BUILTIN_THEMES, type FormatWarningItem } from "@netrics/domain";

import { renderI18n } from "@/lib/i18n/test-render";
import type { StudioDocument } from "@/lib/studio-document";
import {
  PREVIEW_DEVICES,
  frameLayout,
  initialFormatView,
  targetStatuses,
  type FormatViewState,
} from "@/lib/studio-formats";
import type { StudioEnv } from "@/lib/studio-widgets";

import {
  DeviceFrame,
  FormatOverview,
  FormatPreview,
  FormatWarningsList,
  availableFor,
  type PreviewContext,
} from "./format-preview";
import { FormatSwitcher } from "./format-switcher";

// The format switcher, device frames and warnings of the Studio (ADR 0017
// section 10, #283), as static markup in English and German.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function text(id: number, x: number, y: number, body: string): DashboardWidget {
  return {
    type: "text",
    id: ID(id),
    x,
    y,
    w: 3,
    h: 2,
    title: null,
    text: body,
    options: { size: "body", align: "start" },
  };
}

/** Sixteen 3 × 2 text cards: the 16:9 grid is full, portrait needs pages. */
const FULL = Array.from({ length: 16 }, (_, index) =>
  text(
    100 + index,
    (index % 4) * 3,
    Math.floor(index / 4) * 2,
    `Card ${index}`,
  ),
);

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
  slides: [
    {
      id: ID(1),
      name: "Sales",
      durationSeconds: null,
      enabled: true,
      background: null,
      widgets: FULL,
    },
  ],
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

const context: PreviewContext = {
  document,
  primaryFormat: "16x9",
  layouts: new Map(),
  tokens: BUILTIN_THEMES.netrics_dark.tokens,
  env,
};

const warnings: FormatWarningItem[] = [
  {
    format: "9x16",
    code: "text_cut",
    severity: "attention",
    widgetId: ID(100),
    pages: null,
    rows: null,
  },
  {
    format: "9x16",
    code: "continues",
    severity: "info",
    widgetId: null,
    pages: 2,
    rows: null,
  },
  {
    format: "9x16",
    code: "header_name_cut",
    severity: "attention",
    widgetId: null,
    pages: null,
    rows: null,
  },
];

const statuses = targetStatuses({
  primaryFormat: "16x9",
  slides: [{ layouts: [] }],
  warnings,
  screens: new Map([["9x16", 2]]),
});

const noop = () => undefined;

function view(patch: Partial<FormatViewState> = {}): FormatViewState {
  return { ...initialFormatView("16x9"), ...patch };
}

describe("FormatSwitcher", () => {
  const render = (locale: "en" | "de", target = "16x9" as const) =>
    renderI18n(
      <FormatSwitcher
        statuses={statuses}
        selected={target}
        overview={false}
        panelId="stage"
        onSelect={noop}
        onOverview={noop}
      />,
      locale,
    );

  it("is a tablist with the primary first and the selected format current", () => {
    const html = render("en");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Screen formats"');
    const order = [...html.matchAll(/data-target="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(order).toEqual(["16x9", "9x16", "21x9", "4x3", "3x4", "scroll"]);
    expect(html).toMatch(
      /data-target="16x9" aria-selected="true"[^>]*tabindex="0"/,
    );
    expect(html).toMatch(
      /data-target="9x16" aria-selected="false"[^>]*tabindex="-1"/,
    );
  });

  it("states each chip: primary, auto, warnings and paired screens (en)", () => {
    const html = render("en");
    expect(html).toContain('aria-label="TV 16:9, Primary"');
    expect(html).toContain(
      'aria-label="Portrait 9:16, Auto, 2 warnings, used by 2 screens"',
    );
    expect(html).toContain('aria-label="Phone Scroll view, Auto"');
    expect(html).toContain("⚠ 2");
    expect(html).toContain("Used by 2 paired screens");
    expect(html).toContain("All formats");
  });

  it("states each chip in German", () => {
    const html = render("de");
    expect(html).toContain('aria-label="TV 16:9, Primär"');
    expect(html).toContain(
      'aria-label="Hochformat 9:16, Automatisch, 2 Warnungen, von 2 Bildschirmen genutzt"',
    );
    expect(html).toContain(
      'aria-label="Smartphone Scroll-Ansicht, Automatisch"',
    );
    expect(html).toContain("Alle Formate");
  });

  it("shows widgets to review apart from warnings", () => {
    const review = targetStatuses({
      primaryFormat: "16x9",
      slides: [{ layouts: [{ format: "3x4", pages: 1, placements: [] }] }],
      warnings: [
        {
          format: "3x4",
          code: "widget_to_review",
          severity: "attention",
          widgetId: ID(100),
          pages: null,
          rows: null,
        },
      ],
    });
    const html = renderI18n(
      <FormatSwitcher
        statuses={review}
        selected="16x9"
        overview={false}
        panelId="stage"
        onSelect={noop}
        onOverview={noop}
      />,
      "de",
    );
    expect(html).toContain("Tablet hochkant 3:4, Angepasst, 1 zu prüfen");
    expect(html).toContain("1 zu prüfen");
  });
});

describe("DeviceFrame", () => {
  it("scales the device's real screen into the frame", () => {
    const device = PREVIEW_DEVICES.tv;
    const available = { width: 640, height: 600 };
    const layout = frameLayout(device, available);
    const html = renderI18n(
      <DeviceFrame device={device} available={available} label="TV">
        <span>content</span>
      </DeviceFrame>,
    );
    expect(html).toContain('data-device="tv"');
    expect(html).toContain(`width:${layout.width}px`);
    expect(html).toContain(
      `width:${layout.screen.width}px;height:${layout.screen.height}px`,
    );
    expect(html).toContain(
      `width:1920px;height:1080px;transform:scale(${layout.scale})`,
    );
  });

  it("leaves room for a screen of the viewport's height", () => {
    expect(availableFor({ width: 900, height: 10 }, null)).toEqual({
      width: 900,
      height: 520,
    });
    expect(
      availableFor({ width: 900, height: 10 }, { width: 1400, height: 1000 })
        .height,
    ).toBe(680);
  });
});

describe("FormatPreview", () => {
  const render = (locale: "en" | "de", patch: Partial<FormatViewState>) => {
    const shown = view(patch);
    return renderI18n(
      <FormatPreview
        context={context}
        view={shown}
        status={statuses.find((status) => status.target === shown.target)!}
        slideId={ID(1)}
        warnings={new Map([[ID(1), warnings]])}
        panelId="stage"
        onDevice={noop}
        onPage={noop}
        onShowWarning={noop}
      />,
      locale,
    );
  };

  it("renders the draft slide in the format with its pages as tabs", () => {
    const html = render("en", { target: "9x16" });
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="stage-tab-9x16"');
    expect(html).toContain('data-device="tv-portrait"');
    expect(html).toContain('data-format="9x16"');
    expect(html).toContain('aria-label="Preview: Portrait 9:16, Portrait TV"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Page 1 of 2</);
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("Card 0");
    expect(html).toContain("Laid out automatically from the 16:9 layout:");
  });

  it("shows the second page and offers the phone", () => {
    const html = render("en", {
      target: "9x16",
      page: 1,
      devices: { "9x16": "phone" },
    });
    expect(html).toMatch(/aria-selected="true"[^>]*>Page 2 of 2</);
    expect(html).toContain('data-device="phone"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Phone</);
    expect(html).toContain('aria-label="Preview on"');
  });

  it("lists the format's warnings, attention first, the widgets as links", () => {
    const html = render("en", { target: "9x16" });
    expect(html).toContain("Readability in 9:16");
    const header = html.indexOf("The dashboard name does not fit the header.");
    const cut = html.indexOf("Text: the text is cut off.");
    const pages = html.indexOf("Continues on 2 pages.");
    expect(cut).toBeGreaterThan(0);
    expect(header).toBeGreaterThan(cut);
    expect(pages).toBeGreaterThan(header);
    expect(html).toContain('title="Select in 16:9"');
  });

  it("speaks German", () => {
    const html = render("de", { target: "9x16" });
    expect(html).toContain("Seite 1 von 2");
    expect(html).toContain("Lesbarkeit in 9:16");
    expect(html).toContain("Geht auf 2 Seiten weiter.");
    expect(html).toContain(
      "Der Name des Dashboards passt nicht in die Kopfzeile.",
    );
    expect(html).toContain("Automatisch aus dem Layout in 16:9 angeordnet:");
    expect(html).toContain(
      'aria-label="Vorschau: Hochformat 9:16, TV hochkant"',
    );
  });

  it("shows the whole dashboard in scroll view on a phone", () => {
    const html = render("en", { target: "scroll" });
    expect(html).toContain('data-device="phone"');
    expect(html).toContain("device-viewport--scroll");
    expect(html).toContain('class="scroll-view"');
    expect(html).toContain("Sales");
    expect(html).not.toContain("Readability in");
    expect(html).toContain("every slide as a section");
  });

  it("says when a format reads well", () => {
    const html = render("en", { target: "21x9" });
    expect(html).toContain("Everything reads well in this format.");
    expect(html).not.toContain("Page 1 of");
  });
});

describe("FormatWarningsList", () => {
  it("skips slides without warnings in the format", () => {
    const html = renderI18n(
      <FormatWarningsList
        document={document}
        format="3x4"
        primaryFormat="16x9"
        warnings={new Map([[ID(1), warnings]])}
        onShow={noop}
      />,
    );
    expect(html).toContain("Everything reads well in this format.");
  });
});

describe("FormatOverview", () => {
  it("shows every format as a thumbnail with its state", () => {
    const html = renderI18n(
      <FormatOverview
        context={context}
        view={view({ overview: true })}
        statuses={statuses}
        slideId={ID(1)}
        panelId="stage"
        onOpen={noop}
      />,
      "en",
    );
    for (const id of [
      "tv",
      "tv-portrait",
      "monitor-wide",
      "monitor",
      "monitor-portrait",
      "phone",
    ]) {
      expect(html).toContain(`data-device="${id}"`);
    }
    expect(html).toContain('aria-label="Open Portrait 9:16"');
    expect(html).toContain("inert");
  });
});
