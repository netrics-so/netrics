import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Dashboard, DashboardWidgetData } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import { renderI18n } from "@/lib/i18n/test-render";

import { TvDashboard } from "./tv-dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

/** The browser's connection, as the TV mode reads it. */
const network = vi.hoisted(() => ({ offline: false }));
vi.mock("@/components/studio/slide-canvas", async (actual) => ({
  ...(await actual<typeof import("@/components/studio/slide-canvas")>()),
  useOffline: () => network.offline,
}));

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The measure tile's data: no rows yet, a warning, sources paused. */
const data = vi.hoisted(() => ({
  widgets: new Map<string, unknown>(),
}));
vi.mock("@/components/studio/dashboard-data-provider", async (actual) => ({
  ...(await actual<
    typeof import("@/components/studio/dashboard-data-provider")
  >()),
  useDashboardData: () => ({ widgets: data.widgets, loading: false }),
}));

function measureData(error: string | null): DashboardWidgetData {
  return {
    widgetId: ID(10),
    status: "ok",
    error,
    exclusions: [],
    metadata: {
      modelId: ID(11),
      modelName: "Downloads",
      measures: [{ id: "downloads", name: "Downloads" }],
      dimensions: [{ id: "app", name: "App", type: "string" }],
    },
    result: error
      ? null
      : {
          releaseId: null,
          rows: [],
          warnings: [{ code: "w", message: "w" }],
          operations: 1,
          provenance: [],
          appliedFilter: null,
          groupBy: [],
        },
    sourceHealth: [
      {
        connectionId: ID(12),
        name: "Apple team",
        status: "needs_reauthorization",
      },
    ],
  } as unknown as DashboardWidgetData;
}

function dashboard(name: string, showHeader = true): Dashboard {
  return {
    id: ID(1),
    name,
    projectId: null,
    version: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settings: {
      showHeader,
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
        id: ID(2),
        name: null,
        durationSeconds: null,
        enabled: true,
        background: null,
        position: 0,
        layouts: [],
        formatWarnings: [],
        widgets: [
          {
            id: ID(10),
            type: "measure",
            title: "Downloads",
            x: 0,
            y: 0,
            w: 12,
            h: 8,
            binding: {
              modelId: ID(11),
              measureIds: ["downloads"],
              groupBy: ["app"],
              exclusions: [],
            },
            options: { view: "table", limit: 20 },
          },
        ],
      },
    ],
    tiles: [],
  } as unknown as Dashboard;
}

function render(
  locale: "en" | "de",
  board: Dashboard = dashboard("Downloads"),
): string {
  return renderI18n(
    <TvDashboard
      workspaceId={ID(3)}
      timeZone="Europe/Berlin"
      dashboard={board}
      theme={{
        name: "netrics dark",
        builtin: "netrics_dark",
        tokens: BUILTIN_THEMES.netrics_dark.tokens,
      }}
      images={[]}
      metrics={[]}
      connections={{}}
    />,
    locale,
  );
}

/** Editor instructions, in either language. */
const INSTRUCTION =
  /Check|Reconnect|Update access|Try again|Prüfe|Verbinde|Aktualisiere|Versuche/;

describe("signed-in TV mode wording on wall screens (#681)", () => {
  beforeEach(() => {
    // 10:00 UTC is 11:00 in Berlin (CET), the workspace's time zone.
    vi.useFakeTimers({ now: new Date("2026-11-16T10:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    network.offline = false;
    data.widgets = new Map();
  });

  it("shows measure tiles as the kiosk does, without editor instructions", () => {
    data.widgets = new Map([[ID(10), measureData(null)]]);
    const en = render("en");
    expect(en).toContain("No data yet");
    expect(en).toContain("1 data warning");
    expect(en).toContain("Imports from Apple team are paused.");
    expect(en).not.toContain("No rows in this preview.");
    expect(en).not.toMatch(INSTRUCTION);
    const de = render("de");
    expect(de).toContain("Noch keine Daten");
    expect(de).toContain("1 Datenhinweis");
    expect(de).toContain("Die Importe von Apple team sind pausiert.");
    expect(de).not.toMatch(INSTRUCTION);
  });

  it("says only the state when the data request fails", () => {
    data.widgets = new Map([[ID(10), measureData("data_source_pending")]]);
    expect(render("en")).toContain("Data not available yet");
    expect(render("de")).toContain("Daten noch nicht verfügbar");
    data.widgets = new Map([[ID(10), measureData("internal_error")]]);
    const en = render("en");
    expect(en).toContain("Data not available");
    expect(en).not.toMatch(INSTRUCTION);
  });

  it("puts the last update time in the header's offline note", () => {
    expect(render("en")).not.toContain("Offline");
    network.offline = true;
    const en = render("en");
    expect(en).toContain('class="studio-header"');
    expect(en).toContain("Offline — last update 11:00");
    expect(render("de")).toContain("Offline – letzte Aktualisierung 11:00");
  });

  it("shortens the note before a long name is cut, as the kiosk does", () => {
    network.offline = true;
    // A name that leaves no room for the long note beside the clock.
    const long = dashboard(
      "Unternehmenskennzahlen Vertrieb Marketing Service und Logistik Europa",
    );
    const de = render("de", long);
    expect(de).not.toContain("letzte Aktualisierung");
    expect(de).toMatch(/Offline( · 11:00)?</);
  });

  it("marks the corner when the dashboard hides its header", () => {
    network.offline = true;
    const html = render("en", dashboard("Downloads", false));
    expect(html).not.toContain('class="studio-header"');
    expect(html).toContain("Offline — last update 11:00");
  });
});
