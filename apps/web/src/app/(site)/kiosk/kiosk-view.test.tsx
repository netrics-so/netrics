import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  DeviceDashboardResponse,
  DeviceDashboardV2Response,
  DeviceDashboardV3Response,
} from "@netrics/contracts";
import { BUILTIN_THEMES, SCREEN_FORMATS, type Locale } from "@netrics/domain";

import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/client";
import type { KioskState } from "@/lib/kiosk-client";
import { encodeQr, qrPath } from "@/lib/qr-code";
import { widgetBoxStyle } from "@/lib/studio-render";

import {
  KioskScreen,
  kioskLocale,
  kioskRefreshCycle,
  kioskShown,
  payloadRotation,
} from "./kiosk-view";

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
  dashboard:
    | DeviceDashboardV3Response
    | DeviceDashboardV2Response
    | DeviceDashboardResponse,
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
    expect(html).toContain('<div class="kiosk-message kiosk-pairing">');
    expect(html).toContain("Diesen Bildschirm hinzufügen");
    expect(html).toContain('aria-label="Kopplungscode"');
    expect(html).toMatch(
      /Öffne <strong class="kiosk-url">app\.example\/devices\/approve<\/strong> und gib den Code ein\./,
    );
    // The QR code of the approval URL, named, next to "or scan".
    expect(html).toContain(
      'role="img" aria-label="QR-Code, um diesen Bildschirm unter app.example/devices/approve freizugeben"',
    );
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain("oder scannen");
    expect(html).toContain("netrics ist nicht erreichbar");
  });

  it("encodes the approval URL with the code in the QR code", () => {
    const approveUrl = "https://app.example/devices/approve?code=ABCD-EFGH";
    const state: KioskState = {
      phase: "pairing",
      pairing: {
        code: "ABCD-EFGH",
        pairingUrl: "https://app.example/devices/approve",
        approveUrl,
        expiresAt: "2026-10-04T10:10:00Z",
      },
      dashboard: null,
      images: new Map(),
      updatedAt: null,
      offline: false,
      lastError: null,
    };
    const html = render(state);
    const path = /<svg[^>]*><rect[^>]*><\/rect><path d="([^"]+)"/.exec(
      html,
    )?.[1];
    expect(path).toBe(qrPath(encodeQr(approveUrl), 4));
    expect(html).toContain("Add this screen");
    expect(html).toContain("or scan");
    expect(html).not.toContain("netrics ist nicht erreichbar");
  });

  it("shows waiting screens in the light kiosk style", () => {
    const state: KioskState = {
      phase: "starting",
      pairing: null,
      dashboard: null,
      images: new Map(),
      updatedAt: null,
      offline: true,
      lastError: null,
    };
    const html = render(state);
    expect(html).toContain(
      '<div class="kiosk-message"><h1 class="kiosk-title">',
    );
    expect(html).not.toContain('class="tv');
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

/** Schema 3: the v2 content with formats, layouts and device settings. */
function formats(
  device: DeviceDashboardV3Response["device"],
  primaryFormat: DeviceDashboardV3Response["primaryFormat"] = "16x9",
): DeviceDashboardV3Response {
  const v2 = slides("en");
  const table = Object.fromEntries(
    Object.values(SCREEN_FORMATS).map((spec) => [
      spec.key,
      {
        columns: spec.columns,
        rows: spec.rows,
        reference: [spec.reference.width, spec.reference.height],
      },
    ]),
  ) as DeviceDashboardV3Response["formats"];
  const { grid: _grid, ...rest } = v2;
  return {
    ...rest,
    schema: 3,
    locale: "en",
    primaryFormat,
    formats: table,
    device,
    slides: v2.slides.map((slide) => ({ ...slide, layouts: [] })),
  } as DeviceDashboardV3Response;
}

describe("kiosk screen view (ADR 0017, #281)", () => {
  it("renders the slides in screen view, upright on schema 2", () => {
    const html = render(paired(slides("en")));
    expect(html).toContain('data-rotation="0"');
    // Until measured, the 16:9 canvas as before; the real viewport then
    // picks the format (the player measures itself).
    expect(html).toContain('data-format="16x9"');
    expect(html).not.toContain("rotate(");
  });

  it("reads the device rotation of a schema 3 payload (#277)", () => {
    expect(payloadRotation(slides("en"))).toBe(0);
    expect(payloadRotation({ device: { rotation: 90 } })).toBe(90);
    expect(payloadRotation({ device: { rotation: 270 } })).toBe(270);
    expect(payloadRotation({ device: { rotation: 45 } })).toBe(0);
    expect(payloadRotation({ device: null })).toBe(0);
  });
});

describe("kiosk on payload schema 3 (#277, #281)", () => {
  it("turns the whole screen by the device's rotation", () => {
    const html = render(
      paired(formats({ rotation: 90, displayMode: "screen" })),
    );
    expect(html).toContain('data-rotation="90"');
    expect(html).toContain("rotate(90deg)");
    expect(html).toContain("width:100vh;height:100vw");
    expect(html).toContain("slide-player");
    expect(
      kioskShown(formats({ rotation: 270, displayMode: "screen" })),
    ).toEqual({ rotation: 270, mode: "screen" });
  });

  it("uses the slide's custom layout for the screen's format", () => {
    // Designed for portrait (9x16); a custom 16x9 layout for landscape.
    const payload = formats({ rotation: 0, displayMode: "screen" }, "9x16");
    const [a, b, chart] = payload.slides[0]!.widgets;
    payload.slides[0]!.widgets = [
      { ...a!, x: 0, y: 0, w: 6, h: 4 },
      { ...b!, x: 0, y: 4, w: 6, h: 4 },
      { ...chart!, x: 0, y: 8, w: 6, h: 4 },
    ];
    const custom = [
      { widgetId: a!.id, page: 0, x: 0, y: 0, w: 4, h: 4, hidden: false },
      { widgetId: b!.id, page: 0, x: 4, y: 0, w: 4, h: 4, hidden: false },
      { widgetId: chart!.id, page: 0, x: 8, y: 0, w: 4, h: 8, hidden: false },
    ];
    payload.slides[0]!.layouts = [
      { format: "16x9", pages: 1, placements: custom },
    ];
    // Unmeasured, the kiosk lays out as 16:9: the custom placements.
    const html = render(paired(payload));
    expect(html).toContain('data-format="16x9"');
    for (const placement of custom) {
      const box = widgetBoxStyle(placement, true);
      expect(html).toContain(
        `style="left:${box.left};top:${box.top};width:${box.width};height:${box.height}" data-widget-id="${placement.widgetId}"`,
      );
    }
  });

  it("shows the scroll view when the device is set to it", () => {
    const payload = formats({ rotation: 0, displayMode: "scroll" });
    const html = render(paired(payload));
    expect(html).toContain('class="kiosk-scroll"');
    expect(html).toContain("scroll-view");
    expect(html).not.toContain("slide-player");
    expect(html).toContain("Deutschland");
    expect(kioskShown(payload)).toEqual({ rotation: 0, mode: "scroll" });
  });

  it("keeps schema 2 upright in screen view", () => {
    expect(kioskShown(slides("en"))).toEqual({ rotation: 0, mode: "screen" });
    expect(kioskShown(null)).toEqual({ rotation: 0, mode: "screen" });
  });
});

describe("kiosk refresh countdown (ADR 0018, section 5)", () => {
  it("counts from the API's last answer by the payload's cadence", () => {
    expect(
      kioskRefreshCycle(
        { updatedAt: 1_000, offline: false },
        { refreshAfterSec: 30 },
      ),
    ).toEqual({ since: 1_000, everyMs: 30_000 });
  });

  it("has none before the first answer or while offline", () => {
    expect(
      kioskRefreshCycle(
        { updatedAt: null, offline: false },
        { refreshAfterSec: 30 },
      ),
    ).toBeNull();
    expect(
      kioskRefreshCycle(
        { updatedAt: 1_000, offline: true },
        { refreshAfterSec: 30 },
      ),
    ).toBeNull();
  });
});
