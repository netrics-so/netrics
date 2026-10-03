import { gzipSync } from "node:zlib";

import type {
  ConnectionContext,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { observationKey, syncResultSchema } from "@netrics/connector-sdk";
import { runConnectorContractTests } from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  BACKFILL_DAYS,
  INCREMENTAL_LOOKBACK_DAYS,
  MAX_REPORT_BYTES,
  OTHERS,
  PRODUCT_TYPES,
  SALES_REPORT_VERSION,
  TOP_TERRITORIES,
  appStoreConnectManifest,
  createAppStoreConnectConnector,
  currencyExponent,
  inflateReport,
  parseSalesReport,
  productCategory,
  rowProceeds,
  toMinorUnits,
} from "./index.js";
import {
  buildReport,
  createFakeAppStoreConnect,
  fixture,
  reportFixture,
  type FakeAppStoreConnectOptions,
  type FakeTeam,
} from "./test-helpers.js";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.team-a-token.c2lnbmF0dXJl";
const VENDOR = "85012345";
const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-10-01 18:00 UTC is 11:00 PDT: Sept 30 may or may not be published
// yet (pending on a 404), Sept 29 is the latest day that must exist.
const NOW = Date.parse("2026-10-01T18:00:00.000Z");
// From noon PDT on, Sept 30 must exist.
const AFTERNOON = Date.parse("2026-10-01T20:00:00.000Z");

const FIELD_NOTES = "1000000001";
const LEDGER = "1000000002";
const ATLAS = "1000000003";
const DRAFT = "1000000004";

const BASE_TEAM: FakeTeam = {
  tokens: [TOKEN],
  appPages: [fixture("apps-page-1"), fixture("apps-page-2")],
  vendorNumbers: [VENDOR],
};

function team(extra: Partial<FakeTeam> = {}): FakeTeam {
  return { ...BASE_TEAM, ...extra };
}

function fake(
  teamExtra: Partial<FakeTeam> = {},
  options: Partial<FakeAppStoreConnectOptions> = {},
) {
  return createFakeAppStoreConnect({ teams: [team(teamExtra)], ...options });
}

function connector(now = NOW, log: string[] = []) {
  // Sales pages alone; analytics.test.ts covers the analytics pages.
  return createAppStoreConnectConnector({
    now: () => now,
    log: (message) => log.push(message),
    analytics: false,
  });
}

const CONTEXT: ConnectionContext = {
  connectionId: "asc-sales-test",
  config: { vendorNumber: VENDOR },
  credentials: { accessToken: TOKEN },
};

function request(
  from: string,
  to: string,
  extra: Partial<SyncRequest> = {},
): SyncRequest {
  return { mode: "incremental", from, to, ...extra };
}

function salesDates(api: ReturnType<typeof fake>): string[] {
  return api.requests
    .filter((entry) => entry.url.pathname === "/v1/salesReports")
    .map((entry) => entry.url.searchParams.get("filter[reportDate]")!);
}

/** Every page of one run, as the engine pages it. */
async function runAll(
  run: (cursor?: string) => Promise<SyncResult>,
  startCursor?: string,
) {
  const pages: SyncResult[] = [];
  let cursor = startCursor;
  for (let page = 0; page < 100; page += 1) {
    const result = syncResultSchema.parse(await run(cursor));
    pages.push(result);
    if (result.done) break;
    expect(result.nextCursor).toBeDefined();
    expect(result.nextCursor! > (cursor ?? "")).toBe(true);
    cursor = result.nextCursor;
  }
  return { pages, observations: pages.flatMap((page) => page.observations) };
}

function valueOf(
  observations: Observation[],
  metric: string,
  dimensions: Record<string, string>,
  date: string,
): number | undefined {
  return observations.find(
    (observation) =>
      observation.metricKey === `app_store_connect.${metric}` &&
      observation.sourceTimestamp === `${date}T00:00:00.000Z` &&
      JSON.stringify(Object.entries(observation.dimensions).sort()) ===
        JSON.stringify(Object.entries(dimensions).sort()),
  )?.value;
}

// ─── Contract ───────────────────────────────────────────────────────────────

// The SDK's suite asks for 2024-01-01 … 2024-01-11: a clock in late January
// 2024 keeps those days inside Apple's one-year retention.
const CONTRACT_NOW = Date.parse("2024-01-25T20:00:00.000Z");
const contractReports: Record<string, string> = {};
for (let day = 1; day <= 24; day += 1) {
  contractReports[`2024-01-${String(day).padStart(2, "0")}`] = buildReport([
    {
      SKU: "EXFIELDNOTES",
      "Product Type Identifier": "1F",
      Units: String(day),
      "Developer Proceeds": "0",
      "Country Code": "US",
      "Currency of Proceeds": "USD",
      "Apple Identifier": FIELD_NOTES,
      Device: "iPhone",
    },
    {
      SKU: "EXFIELDNOTES.PRO",
      "Product Type Identifier": "IA1",
      Units: "2",
      "Developer Proceeds": "0.70",
      "Country Code": "JP",
      "Currency of Proceeds": "JPY",
      "Apple Identifier": "1100000001",
      "Parent Identifier": "EXFIELDNOTES",
      Device: "iPhone",
    },
  ]);
}

runConnectorContractTests(
  createAppStoreConnectConnector({ now: () => CONTRACT_NOW, log: () => {} }),
  {
    context: CONTEXT,
    runtime: fake({ reports: contractReports }).runtime,
  },
);

// ─── Manifest ───────────────────────────────────────────────────────────────

describe("sales manifest", () => {
  it("declares the ADR 0014 sales and analytics metrics, daily deltas", () => {
    const metrics = Object.fromEntries(
      appStoreConnectManifest.metrics.map((metric) => [
        metric.key,
        [metric.unit, metric.dimensions, metric.kind, metric.granularity],
      ]),
    );
    expect(metrics).toEqual({
      "app_store_connect.downloads": [
        "downloads",
        ["resource"],
        "delta",
        "day",
      ],
      "app_store_connect.downloads_by_territory": [
        "downloads",
        ["resource", "territory"],
        "delta",
        "day",
      ],
      "app_store_connect.downloads_by_device": [
        "downloads",
        ["resource", "device"],
        "delta",
        "day",
      ],
      "app_store_connect.redownloads": [
        "downloads",
        ["resource"],
        "delta",
        "day",
      ],
      "app_store_connect.updates": ["updates", ["resource"], "delta", "day"],
      "app_store_connect.iap_units": [
        "purchases",
        ["resource"],
        "delta",
        "day",
      ],
      "app_store_connect.proceeds": [
        "currency_minor",
        ["resource", "currency"],
        "delta",
        "day",
      ],
      // Analytics (#174), see analytics.test.ts.
      "app_store_connect.impressions": [
        "impressions",
        ["resource"],
        "delta",
        "day",
      ],
      "app_store_connect.product_page_views": [
        "views",
        ["resource"],
        "delta",
        "day",
      ],
      "app_store_connect.store_downloads": [
        "downloads",
        ["resource", "source"],
        "delta",
        "day",
      ],
    });
  });

  it("backfills Apple's one-year retention", () => {
    expect(appStoreConnectManifest.supportsBackfill).toBe(true);
    expect(appStoreConnectManifest.backfillDays).toBe(365);
  });
});

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("sales report parsing", () => {
  it("matches columns by header name: reordered and extra columns, CRLF", () => {
    const rows = parseSalesReport(
      reportFixture("sales-2026-09-27-reordered").replaceAll("\n", "\r\n"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      sku: "EXFIELDNOTES",
      productType: "1F",
      units: 6,
      rawUnits: "6",
      proceeds: "0",
      countryCode: "US",
      currency: "USD",
      appleId: FIELD_NOTES,
      parentId: "",
      device: "iPhone",
    });
    expect(rows[2]).toMatchObject({
      productType: "IA1",
      parentId: "EXFIELDNOTES",
      proceeds: "1.05",
      currency: "CAD",
    });
  });

  it("fails on a missing column and names it", () => {
    expect(() =>
      parseSalesReport(reportFixture("sales-missing-column")),
    ).toThrow('lacks the column "Currency of Proceeds"');
  });

  it("accepts the help's column name for proceeds and a byte-order mark", () => {
    const text = `\uFEFF${buildReport([
      {
        "Product Type Identifier": "1",
        Units: "3",
        "Developer Proceeds": "1.5",
      },
    ]).replace("\tDeveloper Proceeds\t", "\tDeveloper Proceeds (per unit)\t")}`;
    expect(parseSalesReport(text)[0]).toMatchObject({
      units: 3,
      proceeds: "1.5",
    });
  });

  it("parses numbers with a dot whatever the locale, and refuses others", () => {
    const report = (units: string) =>
      buildReport([{ "Product Type Identifier": "1", Units: units }]);
    expect(parseSalesReport(report("-2"))[0]!.units).toBe(-2);
    expect(parseSalesReport(report("1.00"))[0]!.units).toBe(1);
    expect(parseSalesReport(report(""))[0]!.units).toBe(0);
    for (const bad of ["1,5", "1.000,00", "1e3", "two"]) {
      expect(() => parseSalesReport(report(bad))).toThrow(
        "malformed Units value",
      );
    }
  });
});

describe("product types (ADR 0014)", () => {
  it.each([
    ["download", ["1", "1-B", "F1-B", "1E", "1EP", "1EU", "1F", "1T", "F1"]],
    ["redownload", ["3", "3F"]],
    ["update", ["7", "7F", "7T", "F7"]],
    ["iap", ["IA1", "IA1-M", "FI1", "IA9", "IA9-M", "IAY", "IAY-M"]],
    ["restore", ["IA3"]],
  ])("%s: %j", (category, codes) => {
    for (const code of codes) expect(productCategory(code)).toBe(category);
  });

  it("knows exactly those codes, and nothing from the prototype chain", () => {
    expect(Object.keys(PRODUCT_TYPES)).toHaveLength(23);
    for (const code of ["ZZ9", "constructor", "toString", "", "1f"]) {
      expect(productCategory(code)).toBeUndefined();
    }
  });
});

describe("proceeds in minor units", () => {
  it("multiplies units by per-unit proceeds exactly", () => {
    expect(toMinorUnits(rowProceeds("5", "0.70"), "USD")).toBe(350);
    expect(toMinorUnits(rowProceeds("3", "0.10"), "USD")).toBe(30);
    expect(toMinorUnits(rowProceeds("-1", "0.70"), "USD")).toBe(-70);
  });

  it("uses ISO 4217 exponents: JPY 0, BHD 3", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("BHD")).toBe(3);
    expect(toMinorUnits(rowProceeds("2", "84"), "JPY")).toBe(168);
    expect(toMinorUnits(rowProceeds("2", "84.00"), "JPY")).toBe(168);
    expect(toMinorUnits(rowProceeds("1", "1.25"), "BHD")).toBe(1250);
  });

  it("sums before rounding, half away from zero", () => {
    // 3 × 0.5 JPY: 1.5 → 2, not 3 × round(0.5).
    expect(toMinorUnits(rowProceeds("3", "0.5"), "JPY")).toBe(2);
    expect(toMinorUnits(rowProceeds("-3", "0.5"), "JPY")).toBe(-2);
    const sum = rowProceeds("1", "0.4") + rowProceeds("1", "0.4");
    expect(toMinorUnits(sum, "JPY")).toBe(1);
  });
});

describe("gzip bound", () => {
  it("inflates a report and refuses one larger than the bound", () => {
    const text = reportFixture("sales-2026-09-28");
    expect(inflateReport(gzipSync(text))).toBe(text);
    expect(() => inflateReport(gzipSync(text), 100)).toThrow(
      "exceeds 100 bytes when inflated",
    );
    expect(MAX_REPORT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("fails a sync on a gzip bomb or a body that is not gzip", async () => {
    // 80 MiB of zeros compress to about 80 KiB.
    const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024));
    for (const body of [new Uint8Array(bomb), new TextEncoder().encode("hi")]) {
      const api = fake({ reports: { "2026-09-28": body } });
      await expect(
        connector().sync(
          CONTEXT,
          request("2026-09-28T00:00:00.000Z", "2026-09-29T00:00:00.000Z"),
          api.runtime,
        ),
      ).rejects.toThrow(/inflated|not a readable gzip/);
    }
  });
});

// ─── One day ────────────────────────────────────────────────────────────────

describe("a day of sales", () => {
  const reports = { "2026-09-28": reportFixture("sales-2026-09-28") };
  const window = request(
    "2026-09-28T00:00:00.000Z",
    "2026-09-29T00:00:00.000Z",
    { resources: [FIELD_NOTES, LEDGER, DRAFT] },
  );

  it("maps product types to metrics for the selected apps, stamped D T00:00Z", async () => {
    const log: string[] = [];
    const api = fake({ reports });
    const result = syncResultSchema.parse(
      await connector(NOW, log).sync(CONTEXT, window, api.runtime),
    );
    const at = "2026-09-28";
    const fieldNotes = { resource: FIELD_NOTES };
    const observations = result.observations.filter(
      (observation) => observation.sourceTimestamp === `${at}T00:00:00.000Z`,
    );
    // Every observation of the requested day is stamped at UTC midnight.
    expect(observations).toEqual(result.observations);

    expect(valueOf(observations, "downloads", fieldNotes, at)).toBe(15);
    expect(valueOf(observations, "redownloads", fieldNotes, at)).toBe(4);
    expect(valueOf(observations, "updates", fieldNotes, at)).toBe(20);
    // 5 + 2 + 3 − 1 refund; the restore (IA3) and the unknown type are not counted.
    expect(valueOf(observations, "iap_units", fieldNotes, at)).toBe(9);
    for (const [territory, value] of [
      ["US", 10],
      ["DE", 3],
      ["JP", 2],
    ] as const) {
      expect(
        valueOf(
          observations,
          "downloads_by_territory",
          { ...fieldNotes, territory },
          at,
        ),
      ).toBe(value);
    }
    expect(
      valueOf(
        observations,
        "downloads_by_device",
        { ...fieldNotes, device: "iPhone" },
        at,
      ),
    ).toBe(12);
    expect(
      valueOf(
        observations,
        "downloads_by_device",
        { ...fieldNotes, device: "iPad" },
        at,
      ),
    ).toBe(3);

    // Proceeds per currency of proceeds, never added across currencies.
    const proceeds = observations.filter(
      (observation) =>
        observation.metricKey === "app_store_connect.proceeds" &&
        observation.dimensions.resource === FIELD_NOTES,
    );
    expect(
      proceeds.map((observation) => [
        observation.dimensions.currency,
        observation.value,
      ]),
    ).toEqual([
      ["EUR", 1047], // 3 × 3.49
      ["JPY", 168], // 2 × 84, no minor unit
      ["USD", 280], // 5 × 0.70 − 1 × 0.70 refund; the unknown type is left out
    ]);

    // A paid app: downloads carry proceeds; a Mac download is "Desktop".
    const ledger = { resource: LEDGER };
    expect(valueOf(observations, "downloads", ledger, at)).toBe(3);
    expect(
      valueOf(observations, "proceeds", { ...ledger, currency: "GBP" }, at),
    ).toBe(398);
    expect(
      valueOf(observations, "proceeds", { ...ledger, currency: "USD" }, at),
    ).toBe(420);
    expect(
      valueOf(
        observations,
        "downloads_by_device",
        { ...ledger, device: "Desktop" },
        at,
      ),
    ).toBe(1);

    // An app with only an in-app purchase that day: its SKU comes from the
    // team's app list.
    const draft = { resource: DRAFT };
    expect(valueOf(observations, "iap_units", draft, at)).toBe(1);
    expect(valueOf(observations, "downloads", draft, at)).toBe(0);
    expect(
      valueOf(observations, "proceeds", { ...draft, currency: "EUR" }, at),
    ).toBe(70);
    expect(
      api.requests.some((entry) => entry.url.pathname === "/v1/apps"),
    ).toBe(true);

    // The unselected app, and its in-app purchase, are left out.
    expect(
      observations.filter(
        (observation) => observation.dimensions.resource === ATLAS,
      ),
    ).toEqual([]);
    expect(
      new Set(
        observations.map((observation) => observation.dimensions.resource),
      ),
    ).toEqual(new Set([FIELD_NOTES, LEDGER, DRAFT]));

    // The unknown product type is logged by its code only.
    expect(log).toEqual([
      'App Store sales report: unknown product type "ZZ9" counted in no metric',
    ]);
    const identities = observations.map(observationKey);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("reads the app list only when an in-app purchase's app has no rows", async () => {
    const api = fake({ reports });
    await connector().sync(
      CONTEXT,
      { ...window, resources: [FIELD_NOTES] },
      api.runtime,
    );
    // EXDRAFT has no app rows that day, whichever apps are selected.
    expect(
      api.requests.filter((entry) => entry.url.pathname === "/v1/apps").length,
    ).toBeGreaterThan(0);

    const withoutDraft = reportFixture("sales-2026-09-28")
      .split("\n")
      .filter((line) => !line.includes("EXDRAFT"))
      .join("\n");
    const quiet = fake({ reports: { "2026-09-28": withoutDraft } });
    await connector().sync(CONTEXT, window, quiet.runtime);
    expect(
      quiet.requests.some((entry) => entry.url.pathname === "/v1/apps"),
    ).toBe(false);
  });

  it("without a selection, collects every app of the vendor", async () => {
    const api = fake({ reports });
    const result = await connector().sync(
      CONTEXT,
      { ...window, resources: undefined } as SyncRequest,
      api.runtime,
    );
    expect(
      new Set(
        result.observations.map(
          (observation) => observation.dimensions.resource,
        ),
      ),
    ).toEqual(new Set([FIELD_NOTES, LEDGER, ATLAS, DRAFT]));
    expect(
      valueOf(
        result.observations,
        "downloads",
        { resource: ATLAS },
        "2026-09-28",
      ),
    ).toBe(50);
  });

  it("reads nothing for an empty selection", async () => {
    const api = fake({ reports });
    const result = await connector().sync(
      CONTEXT,
      { ...window, resources: [] },
      api.runtime,
    );
    expect(result.observations).toEqual([]);
    expect(result.done).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it("reads a report with reordered and extra columns like any other", async () => {
    const api = fake({
      reports: {
        "2026-09-27": reportFixture("sales-2026-09-27-reordered").replaceAll(
          "\n",
          "\r\n",
        ),
      },
    });
    const result = await connector().sync(
      CONTEXT,
      request("2026-09-27T00:00:00.000Z", "2026-09-28T00:00:00.000Z", {
        resources: [FIELD_NOTES],
      }),
      api.runtime,
    );
    const at = "2026-09-27";
    const app = { resource: FIELD_NOTES };
    expect(valueOf(result.observations, "downloads", app, at)).toBe(7);
    expect(valueOf(result.observations, "iap_units", app, at)).toBe(1);
    expect(
      valueOf(result.observations, "proceeds", { ...app, currency: "CAD" }, at),
    ).toBe(105);
  });

  it("fails the sync when a report lacks a column it needs", async () => {
    const api = fake({
      reports: { "2026-09-28": reportFixture("sales-missing-column") },
    });
    await expect(
      connector().sync(CONTEXT, window, api.runtime),
    ).rejects.toThrow('lacks the column "Currency of Proceeds"');
  });

  it("asks for the pinned report version with encoded filters", async () => {
    const api = fake({ reports });
    await connector().sync(CONTEXT, window, api.runtime);
    const sales = api.requests.find(
      (entry) => entry.url.pathname === "/v1/salesReports",
    )!;
    expect(SALES_REPORT_VERSION).toBe("1_0");
    expect(Object.fromEntries(sales.url.searchParams)).toMatchObject({
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[version]": "1_0",
      "filter[vendorNumber]": VENDOR,
    });
    // Apple rejects unencoded brackets (forums thread 796368).
    expect(sales.url.search).toContain("filter%5Bversion%5D=1_0");
    for (const entry of api.requests) {
      expect(entry.url.hostname).toBe("api.appstoreconnect.apple.com");
    }
  });
});

// ─── Territories ────────────────────────────────────────────────────────────

/** A September of downloads in 13 territories: A* lead, Z* trail. */
function territoryMonth(): Record<string, string> {
  const reports: Record<string, string> = {};
  const territories = [
    "AA",
    "AB",
    "AC",
    "AD",
    "AE",
    "AF",
    "AG",
    "AH",
    "AI",
    "AJ",
    "ZX",
    "ZY",
    "ZZ",
  ];
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    reports[date] = buildReport(
      territories.map((territory, index) => ({
        SKU: "EXFIELDNOTES",
        "Product Type Identifier": "1F",
        // ZZ leads on the first two days only; over the month it trails.
        Units: String(territory === "ZZ" ? (day <= 2 ? 60 : 1) : 20 - index),
        "Developer Proceeds": "0",
        "Country Code": territory,
        "Currency of Proceeds": "USD",
        "Apple Identifier": FIELD_NOTES,
        Device: "iPhone",
      })),
    );
  }
  return reports;
}

describe("downloads by territory: top 10 per app and month", () => {
  const selection = { resources: [FIELD_NOTES] };

  it("keeps the 10 largest territories of the month and groups the rest as Others", async () => {
    const api = fake({ reports: territoryMonth() });
    const result = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-10T00:00:00.000Z",
        "2026-09-11T00:00:00.000Z",
        selection,
      ),
      api.runtime,
    );
    const at = "2026-09-10";
    const byTerritory = result.observations.filter(
      (observation) =>
        observation.metricKey === "app_store_connect.downloads_by_territory",
    );
    const values = Object.fromEntries(
      byTerritory.map((observation) => [
        observation.dimensions.territory,
        observation.value,
      ]),
    );
    expect(TOP_TERRITORIES).toBe(10);
    expect(values).toEqual({
      AA: 20,
      AB: 19,
      AC: 18,
      AD: 17,
      AE: 16,
      AF: 15,
      AG: 14,
      AH: 13,
      AI: 12,
      AJ: 11,
      // ZX 10 + ZY 9 + ZZ 1.
      [OTHERS]: 20,
      // ZZ led the month's first days, when an earlier sync could have
      // stored it: an explicit 0 overwrites that value instead of
      // counting it twice.
      ZZ: 0,
    });
    // The day's breakdown adds up to its downloads.
    const total = byTerritory.reduce(
      (sum, observation) => sum + observation.value,
      0,
    );
    expect(total).toBe(
      valueOf(result.observations, "downloads", { resource: FIELD_NOTES }, at),
    );
    // The page read the whole month to rank it.
    expect(salesDates(api)).toHaveLength(30);
  });

  it("gives a day the same values whichever window asks for it", async () => {
    const reports = territoryMonth();
    const narrow = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-10T00:00:00.000Z",
        "2026-09-11T00:00:00.000Z",
        selection,
      ),
      fake({ reports }).runtime,
    );
    const wide = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
        selection,
      ),
      fake({ reports }).runtime,
    );
    const byIdentity = new Map(
      wide.observations.map((observation) => [
        observationKey(observation),
        observation.value,
      ]),
    );
    expect(narrow.observations.length).toBeGreaterThan(0);
    for (const observation of narrow.observations) {
      expect(byIdentity.get(observationKey(observation))).toBe(
        observation.value,
      );
    }
  });

  it("re-reading a running month after its ranking changed never counts a day twice", async () => {
    const reports = territoryMonth();
    // On Sept 3 (afternoon), the month so far is Sept 1–2: ZZ leads.
    const early = await connector(Date.parse("2026-09-03T20:00:00.000Z")).sync(
      CONTEXT,
      request(
        "2026-09-01T00:00:00.000Z",
        "2026-09-03T20:00:00.000Z",
        selection,
      ),
      fake({ reports }).runtime,
    );
    expect(
      valueOf(
        early.observations,
        "downloads_by_territory",
        { resource: FIELD_NOTES, territory: "ZZ" },
        "2026-09-02",
      ),
    ).toBe(60);
    // Later in the month the same days are read again with ZZ in Others.
    const later = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-01T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
        selection,
      ),
      fake({ reports }).runtime,
    );
    // Storage keeps the latest value per identity (ADR 0008).
    const stored = new Map<string, Observation>();
    for (const observation of [...early.observations, ...later.observations]) {
      stored.set(observationKey(observation), observation);
    }
    const day2 = [...stored.values()].filter(
      (observation) =>
        observation.metricKey === "app_store_connect.downloads_by_territory" &&
        observation.sourceTimestamp === "2026-09-02T00:00:00.000Z",
    );
    const sum = day2.reduce(
      (total, observation) => total + observation.value,
      0,
    );
    expect(sum).toBe(
      valueOf(
        later.observations,
        "downloads",
        { resource: FIELD_NOTES },
        "2026-09-02",
      ),
    );
  });

  it("emits no Others for an app with 10 territories or fewer", async () => {
    const api = fake({
      reports: { "2026-09-28": reportFixture("sales-2026-09-28") },
    });
    const result = await connector().sync(
      CONTEXT,
      request(
        "2026-09-28T00:00:00.000Z",
        "2026-09-29T00:00:00.000Z",
        selection,
      ),
      api.runtime,
    );
    expect(
      result.observations.some(
        (observation) => observation.dimensions.territory === OTHERS,
      ),
    ).toBe(false);
  });
});

// ─── Windows, cursors and 404s ──────────────────────────────────────────────

describe("backfill", () => {
  it("reads 365 days at most, one month per page, and never older", async () => {
    const api = fake({ salesDays: ["2026-09-29"] });
    const from = new Date(NOW - BACKFILL_DAYS * DAY_MS).toISOString();
    const to = new Date(NOW).toISOString();
    const run = await runAll((cursor) =>
      connector().sync(
        CONTEXT,
        {
          mode: "backfill",
          from,
          to,
          ...(cursor ? { cursor } : {}),
          resources: [FIELD_NOTES],
        },
        api.runtime,
      ),
    );
    const dates = salesDates(api);
    // Today (PT) is Oct 1: the oldest day is 364 days back, Sept 30 is the newest.
    expect(dates.toSorted()[0]).toBe("2025-10-02");
    expect(dates.toSorted().at(-1)).toBe("2026-09-30");
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates.length).toBe(BACKFILL_DAYS - 1);
    // 12 calendar months, far below the engine's 100-page bound and within
    // a tenth of Apple's 3,500 requests per hour.
    expect(run.pages).toHaveLength(12);
    expect(run.pages.slice(0, -1).map((page) => page.nextCursor)).toEqual([
      "2025-11-01T00:00:00.000Z",
      "2025-12-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    const timestamps = run.observations.map(
      (observation) => observation.sourceTimestamp,
    );
    expect(timestamps.toSorted()[0]).toBe("2025-10-02T00:00:00.000Z");
    // Sept 30 answered 404 before noon PT: not published yet, not stored.
    expect(timestamps).not.toContain("2026-09-30T00:00:00.000Z");
    expect(timestamps).toContain("2026-09-29T00:00:00.000Z");
    // The next sync starts 3 days before the unpublished day.
    expect(run.pages.at(-1)!.nextCursor).toBe("2026-09-27T00:00:00.000Z");
  });

  it("resumes from a checkpoint in a later run with the same result", async () => {
    const reports = territoryMonth();
    const from = new Date(NOW - BACKFILL_DAYS * DAY_MS).toISOString();
    const whole = await runAll((cursor) =>
      connector().sync(
        CONTEXT,
        {
          mode: "backfill",
          from,
          to: new Date(NOW).toISOString(),
          ...(cursor ? { cursor } : {}),
        },
        fake({ reports }).runtime,
      ),
    );
    // A retry an hour later (later `to`, same clock day) from the checkpoint
    // of the August page.
    const later = NOW + 60 * 60 * 1000;
    const resumed = await runAll(
      (cursor) =>
        connector(later).sync(
          CONTEXT,
          {
            mode: "backfill",
            from: new Date(later - BACKFILL_DAYS * DAY_MS).toISOString(),
            to: new Date(later).toISOString(),
            ...(cursor ? { cursor } : {}),
          },
          fake({ reports }).runtime,
        ),
      "2026-09-01T00:00:00.000Z",
    );
    const september = whole.observations.filter((observation) =>
      observation.sourceTimestamp.startsWith("2026-09"),
    );
    expect(resumed.observations).toEqual(september);
    expect(september.length).toBeGreaterThan(0);
  });
});

describe("incremental syncs and the two meanings of 404", () => {
  const selection = { resources: [FIELD_NOTES] };
  const reports = {
    "2026-09-26": reportFixture("sales-2026-09-28").replaceAll(
      "09/28/2026",
      "09/26/2026",
    ),
    "2026-09-29": reportFixture("sales-2026-09-28").replaceAll(
      "09/28/2026",
      "09/29/2026",
    ),
  };

  it("a 404 for a day that must exist is a day without sales: zeros, and the cursor moves on", async () => {
    const api = fake({ reports });
    const result = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-26T00:00:00.000Z",
        new Date(AFTERNOON).toISOString(),
        selection,
      ),
      api.runtime,
    );
    const app = { resource: FIELD_NOTES };
    expect(valueOf(result.observations, "downloads", app, "2026-09-27")).toBe(
      0,
    );
    expect(valueOf(result.observations, "downloads", app, "2026-09-30")).toBe(
      0,
    );
    expect(valueOf(result.observations, "downloads", app, "2026-09-29")).toBe(
      15,
    );
    expect(result.done).toBe(true);
    // Sept 30 is settled: the next sync re-reads the last 3 days.
    expect(INCREMENTAL_LOOKBACK_DAYS).toBe(3);
    expect(result.nextCursor).toBe("2026-09-28T00:00:00.000Z");
  });

  it("a day without sales has proceeds 0 in each currency the app earned in that month", async () => {
    const usdOnly = buildReport([
      {
        SKU: "EXFIELDNOTES",
        "Product Type Identifier": "1F",
        Units: "1",
        "Developer Proceeds": "0.70",
        "Country Code": "US",
        "Currency of Proceeds": "USD",
        "Apple Identifier": FIELD_NOTES,
        Device: "iPhone",
      },
    ]);
    const NO_SALES = "1000000099";
    const api = fake({ reports: { ...reports, "2026-09-28": usdOnly } });
    const result = await connector(AFTERNOON).sync(
      CONTEXT,
      request("2026-09-26T00:00:00.000Z", new Date(AFTERNOON).toISOString(), {
        resources: [FIELD_NOTES, NO_SALES],
      }),
      api.runtime,
    );
    const app = { resource: FIELD_NOTES };
    const proceedsOf = (currency: string, at: string) =>
      valueOf(result.observations, "proceeds", { ...app, currency }, at);
    // Each currency is a continuous daily series: no gaps on days (or in
    // currencies) without sales.
    for (const currency of ["EUR", "JPY", "USD"]) {
      expect(proceedsOf(currency, "2026-09-27")).toBe(0);
      expect(proceedsOf(currency, "2026-09-30")).toBe(0);
    }
    expect(proceedsOf("USD", "2026-09-28")).toBe(70);
    expect(proceedsOf("EUR", "2026-09-28")).toBe(0);
    expect(proceedsOf("JPY", "2026-09-28")).toBe(0);
    expect(proceedsOf("EUR", "2026-09-29")).toBe(1047);
    // The zeros change no sum: the window's total per currency is the
    // sales days' total.
    const total = (currency: string) =>
      result.observations
        .filter(
          (observation) =>
            observation.metricKey === "app_store_connect.proceeds" &&
            observation.dimensions.resource === FIELD_NOTES &&
            observation.dimensions.currency === currency,
        )
        .reduce((sum, observation) => sum + observation.value, 0);
    expect(total("EUR")).toBe(2 * 1047);
    expect(total("USD")).toBe(2 * 280 + 70);
    // An app without any proceeds this month has no currency to fill: its
    // counts are 0, and it has no proceeds series.
    expect(
      valueOf(
        result.observations,
        "downloads",
        { resource: NO_SALES },
        "2026-09-27",
      ),
    ).toBe(0);
    expect(
      result.observations.some(
        (observation) =>
          observation.metricKey === "app_store_connect.proceeds" &&
          observation.dimensions.resource === NO_SALES,
      ),
    ).toBe(false);
  });

  it("a 404 for a day that may not be published yet keeps the cursor before it", async () => {
    const api = fake({ reports, pendingDays: ["2026-09-30"] });
    const result = await connector(NOW).sync(
      CONTEXT,
      request(
        "2026-09-26T00:00:00.000Z",
        new Date(NOW).toISOString(),
        selection,
      ),
      api.runtime,
    );
    expect(salesDates(api)).toContain("2026-09-30");
    expect(
      result.observations.some(
        (observation) =>
          observation.sourceTimestamp === "2026-09-30T00:00:00.000Z",
      ),
    ).toBe(false);
    expect(result.nextCursor).toBe("2026-09-27T00:00:00.000Z");

    // The next sync, after noon PT, finds it published.
    const published = fake({
      reports: {
        ...reports,
        "2026-09-30": reports["2026-09-29"]!.replaceAll(
          "09/29/2026",
          "09/30/2026",
        ),
      },
    });
    const next = await connector(AFTERNOON).sync(
      CONTEXT,
      request(result.nextCursor!, new Date(AFTERNOON).toISOString(), selection),
      published.runtime,
    );
    expect(
      valueOf(
        next.observations,
        "downloads",
        { resource: FIELD_NOTES },
        "2026-09-30",
      ),
    ).toBe(15);
    expect(next.nextCursor).toBe("2026-09-28T00:00:00.000Z");
  });

  it("takes yesterday's report before noon PT when Apple already published it", async () => {
    const api = fake({
      reports: { "2026-09-30": reports["2026-09-29"]! },
    });
    const result = await connector(NOW).sync(
      CONTEXT,
      request(
        "2026-09-29T00:00:00.000Z",
        new Date(NOW).toISOString(),
        selection,
      ),
      api.runtime,
    );
    expect(
      valueOf(
        result.observations,
        "downloads",
        { resource: FIELD_NOTES },
        "2026-09-30",
      ),
    ).toBe(15);
  });

  it("re-reads the lookback days on every sync and replays identical values", async () => {
    const first = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-09-26T00:00:00.000Z",
        new Date(AFTERNOON).toISOString(),
        selection,
      ),
      fake({ reports }).runtime,
    );
    const api = fake({ reports });
    const second = await connector(AFTERNOON).sync(
      CONTEXT,
      request(first.nextCursor!, new Date(AFTERNOON).toISOString(), selection),
      api.runtime,
    );
    const firstByIdentity = new Map(
      first.observations.map((observation) => [
        observationKey(observation),
        observation.value,
      ]),
    );
    expect(second.observations.length).toBeGreaterThan(0);
    for (const observation of second.observations) {
      expect(firstByIdentity.get(observationKey(observation))).toBe(
        observation.value,
      );
    }
    expect(
      new Set(
        second.observations.map((observation) => observation.sourceTimestamp),
      ),
    ).toEqual(
      new Set([
        "2026-09-28T00:00:00.000Z",
        "2026-09-29T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
      ]),
    );
  });

  it("does nothing for a window that holds no reporting day yet", async () => {
    const api = fake({ reports });
    const result = await connector(AFTERNOON).sync(
      CONTEXT,
      request(
        "2026-10-01T00:00:00.000Z",
        new Date(AFTERNOON).toISOString(),
        selection,
      ),
      api.runtime,
    );
    expect(result).toEqual({
      observations: [],
      nextCursor: "2026-10-01T00:00:00.000Z",
      done: true,
    });
    expect(api.requests).toEqual([]);
  });
});

// ─── Failures ───────────────────────────────────────────────────────────────

describe("sync failures", () => {
  const window = request(
    "2026-09-28T00:00:00.000Z",
    "2026-09-29T00:00:00.000Z",
    {
      resources: [FIELD_NOTES],
    },
  );

  it("429 throws a retryable error so the job backs off", async () => {
    const api = fake(
      {},
      { failures: [{ status: 429, fixture: "error-rate-limit" }] },
    );
    const error = await connector()
      .sync(CONTEXT, window, api.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppStoreConnectApiError);
    expect((error as AppStoreConnectApiError).isRetryable).toBe(true);
  });

  it("stops before Apple's limit when the hourly budget runs low", async () => {
    const api = fake({}, { remaining: 40 });
    await expect(
      connector().sync(CONTEXT, window, api.runtime),
    ).rejects.toBeInstanceOf(AppStoreConnectRateBudgetError);
    // The first answers told it to stop; it did not read the whole month.
    expect(salesDates(api).length).toBeLessThan(28);
  });

  it("a refused token surfaces as AccessTokenRejectedError", async () => {
    const api = fake();
    const error = await connector()
      .sync(
        { ...CONTEXT, credentials: { accessToken: "eyJ.other.token" } },
        window,
        api.runtime,
      )
      .catch((caught: unknown) => caught as Error);
    expect((error as Error).name).toBe("AccessTokenRejectedError");
    expect((error as Error).message).not.toContain("eyJ.other.token");
  });

  it("a 404 marked not available for an old day still counts as no sales", async () => {
    // Apple's wording is not a contract (it says to branch on codes): only
    // the time decides between the two meanings.
    const api = fake({ pendingDays: ["2026-09-28"] });
    const result = await connector().sync(CONTEXT, window, api.runtime);
    expect(
      valueOf(
        result.observations,
        "downloads",
        { resource: FIELD_NOTES },
        "2026-09-28",
      ),
    ).toBe(0);
  });

  it("requires a vendor number", async () => {
    await expect(
      connector().sync({ ...CONTEXT, config: {} }, window, fake().runtime),
    ).rejects.toThrow("vendor number");
  });
});
