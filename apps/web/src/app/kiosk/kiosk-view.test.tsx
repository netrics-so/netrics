import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  DeviceDashboardResponse,
  DeviceDashboardV2Response,
} from "@netrics/contracts";
import { BUILTIN_THEMES, type Locale } from "@netrics/domain";

import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/client";
import type { KioskState } from "@/lib/kiosk-client";

import { KioskScreen, kioskLocale } from "./kiosk-view";

// The kiosk in the workspace's screen language (ADR 0016, #256): labels
// arrive finished in the payload; chrome, periods, comparisons, notices and
// numbers follow the payload's `locale`.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const data = {
  period: "last_30_days" as const,
  aggregation: "sum" as const,
  unit: "count",
  conversion: null,
  kind: "delta" as const,
  granularity: "day" as const,
  better: "higher" as const,
  status: "ok" as const,
  updatedAt: "2026-10-04T09:55:00.000Z",
};

function slides(locale?: string): DeviceDashboardV2Response {
  return {
    version: "v1",
    schema: 2,
    refreshAfterSec: 60,
    timeZone: "Europe/Berlin",
    ...(locale ? { locale } : {}),
    dashboard: {
      id: ID(1),
      name: "Wurfel",
      showHeader: true,
      logo: null,
    },
    theme: { name: "netrics Dark", tokens: BUILTIN_THEMES.netrics_dark.tokens },
    rotation: { autoAdvance: true, transition: "none" },
    grid: { columns: 12, rows: 8 },
    images: [],
    slides: [
      {
        id: ID(10),
        name: "Verkäufe",
        durationSec: 20,
        background: null,
        widgets: [
          {
            type: "metric",
            id: ID(11),
            x: 0,
            y: 0,
            w: 6,
            h: 4,
            label: "Downloads · Alle Apps",
            options: { showSparkline: true, showChange: true },
            data: {
              ...data,
              value: 12345.5,
              change: { previousValue: 10000, delta: 2345.5, ratio: 0.2345 },
              spark: [1, 2, 3],
            },
          },
          {
            type: "metric",
            id: ID(12),
            x: 6,
            y: 0,
            w: 6,
            h: 4,
            label: "Proceeds · Wurfel",
            options: { showSparkline: false, showChange: true },
            data: {
              ...data,
              status: "auth_failed",
              value: 7,
              change: { previousValue: null, delta: null, ratio: null },
              spark: [],
            },
          },
          {
            type: "bar",
            id: ID(13),
            x: 0,
            y: 4,
            w: 6,
            h: 4,
            label: "Downloads · Alle Apps",
            options: { groupBy: "territory", limit: 3 },
            data: {
              ...data,
              groupBy: "territory",
              bars: [{ key: "DE", label: "Deutschland", value: 812 }],
              others: { label: "Andere", value: 50, groups: 3 },
            },
          },
        ],
      },
    ],
  };
}

function paired(
  dashboard: DeviceDashboardV2Response | DeviceDashboardResponse,
  offline = false,
): KioskState {
  return {
    phase: "paired",
    pairing: null,
    dashboard,
    images: new Map(),
    updatedAt: Date.parse("2026-10-04T10:00:00Z"),
    offline,
    lastError: null,
  };
}

function render(state: KioskState, pageLocale: Locale = "en") {
  const locale = kioskLocale(state, pageLocale);
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      <KioskScreen state={state} />
    </I18nProvider>,
  );
}

describe("kiosk language", () => {
  it("follows the payload once paired, the page before", () => {
    expect(kioskLocale(paired(slides("de")), "en")).toBe("de");
    // A payload without a language (an older server, schema 1 in English).
    expect(kioskLocale(paired(slides()), "de")).toBe("en");
    // One this build does not know falls back to English.
    expect(kioskLocale(paired(slides("fr")), "de")).toBe("en");
    const pairing: KioskState = {
      ...paired(slides("de")),
      phase: "pairing",
      dashboard: null,
    };
    expect(kioskLocale(pairing, "de")).toBe("de");
    expect(kioskLocale(pairing, "en")).toBe("en");
  });

  it("renders a German payload in German", () => {
    const html = render(paired(slides("de"), true));
    // Finished labels from the payload ("Downloads · Alle Apps" is drawn
    // as title and resource line).
    expect(html).toMatch(
      />Downloads<\/h3><p class="sw-resource"[^>]*>Alle Apps</,
    );
    expect(html).toContain("Andere");
    // Periods, comparisons and numbers in German.
    expect(html).toContain("Letzte 30 Tage · Summe");
    expect(html).toContain("vs. vorherige 30 Tage");
    expect(html).toContain("12,3\u00a0Tsd.");
    expect(html).toContain("+23%");
    expect(html).toContain("Keine Daten zum Vergleich");
    // Notices and chrome.
    expect(html).toContain("Verbindung braucht neue Zugangsdaten");
    expect(html).toContain("Offline");
    expect(html).not.toContain("Last 30 days");
    expect(html).not.toContain("vs previous");
    expect(html).not.toContain("No data");
  });

  it("renders the same payload in English without a language", () => {
    const html = render(paired(slides()));
    expect(html).toContain("Last 30 days · Total");
    expect(html).toContain("vs previous 30 days");
    expect(html).toContain("12.3K");
    expect(html).toContain("Connection needs new credentials");
  });

  it("says in German that no dashboard is assigned", () => {
    const empty = { ...slides("de"), dashboard: null, slides: [] };
    const html = render(paired(empty));
    expect(html).toContain("Noch kein Dashboard zugewiesen");
    expect(html).not.toContain("No dashboard");
  });

  it("pairs in the page's language", () => {
    const state: KioskState = {
      phase: "pairing",
      pairing: {
        code: "ABCD-EFGH",
        pairingUrl: "https://app.example/devices/approve",
        approveUrl: "https://app.example/devices/approve?code=ABCD-EFGH",
        expiresAt: "2026-10-04T10:10:00Z",
      },
      dashboard: null,
      images: new Map(),
      updatedAt: null,
      offline: true,
      lastError: null,
    };
    const html = render(state, "de");
    expect(html).toContain("Zeig ein netrics-Dashboard auf diesem Bildschirm");
    expect(html).toContain('aria-label="Kopplungscode"');
    expect(html).toMatch(
      /Öffne <strong class="kiosk-url">app\.example\/devices\/approve<\/strong> und gib den Code ein\./,
    );
    expect(html).toContain("netrics ist nicht erreichbar");
  });

  it("labels schema 1 tiles in German", () => {
    const tiles: DeviceDashboardResponse = {
      version: "v1",
      refreshAfterSec: 60,
      timeZone: "Europe/Berlin",
      locale: "de",
      dashboard: { id: ID(1), name: "Wand" },
      tiles: [
        {
          id: ID(2),
          label: "Downloads · Alle Apps",
          ...data,
          period: "today",
          value: 1500,
          change: { previousValue: 1000, delta: 500, ratio: 0.5 },
          spark: [1, 2],
          status: "stale",
        },
      ],
    };
    const html = render(paired(tiles));
    expect(html).toContain("Heute · Summe");
    expect(html).toContain("vs. gestern");
    expect(html).toContain("1.500");
    expect(html).toContain("Zuletzt synchronisiert");
  });
});
