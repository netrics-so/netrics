import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Dashboard, DashboardWidgetData } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import { renderI18n } from "@/lib/i18n/test-render";

import {
  failedWidgets,
  loadDashboardData,
} from "@/components/studio/dashboard-data-provider";

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

/** The dashboard's measure tile. */
function measure() {
  return dashboard("Downloads").slides[0]!.widgets[0] as Parameters<
    typeof failedWidgets
  >[0][number];
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

  it("shortens the note before the name is cut, as the kiosk does", () => {
    network.offline = true;
    /** The header's offline note for a dashboard name (16:9). */
    const noteFor = (name: string) =>
      /<span class="studio-offline"><span aria-hidden="true">⚠<\/span> ([^<]*)<\/span>/.exec(
        render("de", dashboard(name)),
      )?.[1];
    const words =
      "Unternehmenskennzahlen Vertrieb Marketing Service Logistik Europa Nord".split(
        " ",
      );
    // Room enough: the whole note.
    expect(noteFor(words.slice(0, 4).join(" "))).toBe(
      "Offline – letzte Aktualisierung 11:00",
    );
    // The long note would cut the name: the short one.
    expect(noteFor(words.slice(0, 6).join(" "))).toBe("Offline · 11:00");
    // Not even that: just "Offline".
    expect(noteFor(words.join(" "))).toBe("Offline");
  });

  it("keeps the last valid data on screen when a load fails", () => {
    const failing = { ...measureData(null) };
    data.widgets = failedWidgets(
      [measure()],
      new Map([[ID(10), failing]]),
      true,
    );
    const en = render("en");
    expect(en).toContain("Last valid data");
    expect(en).not.toContain("Data not available");
    expect(render("de")).toContain("Letzte gültige Daten");
  });

  it("marks the corner when the dashboard hides its header", () => {
    network.offline = true;
    const html = render("en", dashboard("Downloads", false));
    expect(html).not.toContain('class="studio-header"');
    expect(html).toContain("Offline — last update 11:00");
  });
});

describe("the TV mode's data loads (#681)", () => {
  const tile = () => measureData(null);
  it("reports each successful load's time, and none for a failed one", async () => {
    const times: number[] = [];
    const loaded = await loadDashboardData(
      async () => ({ widgets: [tile()] }),
      (at) => times.push(at),
      () => 1234,
    );
    expect(times).toEqual([1234]);
    expect(loaded?.get(ID(10))).toEqual(tile());
    const failed = await loadDashboardData(
      () => Promise.reject(new TypeError("Failed to fetch")),
      (at) => times.push(at),
      () => 5678,
    );
    expect(failed).toBeNull();
    expect(times).toEqual([1234]);
  });

  it("keeps last good results, marked stale, only on wall screens", () => {
    const previous = new Map([[ID(10), tile()]]);
    const kept = failedWidgets([measure()], previous, true).get(ID(10))!;
    expect(kept.error).toBeNull();
    expect(kept.result?.stale).toBe(true);
    expect(kept.result?.warnings).toEqual(tile().result!.warnings);
    // Editor surfaces show the failure.
    expect(
      failedWidgets([measure()], previous, false).get(ID(10)),
    ).toMatchObject({ error: "data_storage_failed", result: null });
    // Nothing loaded yet, or an error before: nothing to keep.
    expect(failedWidgets([measure()], undefined, true).get(ID(10))?.error).toBe(
      "data_storage_failed",
    );
    const errored = new Map([[ID(10), measureData("internal_error")]]);
    expect(failedWidgets([measure()], errored, true).get(ID(10))?.error).toBe(
      "data_storage_failed",
    );
  });
});
