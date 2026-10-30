import { readFileSync, writeFileSync } from "node:fs";
import {
  BUILTIN_THEMES,
  SCREEN_FORMATS,
  STUDIO_MIN_WIDGET_SIZE,
} from "@netrics/domain";
import { describe, expect, it } from "vitest";
import {
  deviceDashboardV3ResponseSchema,
  type DeviceDashboardV3Response,
  type DeviceWidgetV3,
} from "./index.js";

// The demo dashboard netrics TV bundles for "Try a demo" (#416, ADR 0021
// section 5): a schema 3 payload in English and German, shown offline
// without a server. Built here so it always parses with the contract;
// `pnpm demo:tv` rewrites the bundled files. The numbers are generated
// from a fixed seed and belong to no one: an invented coffee roastery with
// sites under example.com.
//
// The app moves the dates to the day it shows them
// (`DemoDashboard.retime` in NetricsKit): ages (`updatedAt`,
// `lastSuccessAt`) stay as old relative to now as they are relative to
// `DEMO_GENERATED_AT`, every other instant keeps its wall-clock time and
// moves by whole days; the payload's time zone becomes the device's.

/** The instant the payload pretends to be from; NetricsKit's `DemoDashboard.generatedAt`. */
const DEMO_GENERATED_AT = "2026-10-29T09:00:00.000Z";

const DAY_MS = 24 * 60 * 60 * 1000;
const generatedAt = Date.parse(DEMO_GENERATED_AT);
/** Midnight (UTC, the payload's zone) of the day the payload is from. */
const today = Math.floor(generatedAt / DAY_MS) * DAY_MS;

type Language = "en" | "de";

/** Deterministic numbers (mulberry32): the same files on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `days` daily values ending today: a base with a weekly rhythm, a slow
 * trend and noise.
 */
function daily(
  seed: number,
  days: number,
  base: number,
  trend: number,
): number[] {
  const next = random(seed);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today - (days - 1 - index) * DAY_MS);
    const weekday = date.getUTCDay();
    const weekly = weekday === 0 || weekday === 6 ? 0.72 : 1;
    const growth = 1 + (trend * index) / days;
    return Math.round(base * weekly * growth * (0.9 + next() * 0.2));
  });
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => iso(generatedAt - minutes * 60_000);

function change(value: number, previousValue: number) {
  const delta = value - previousValue;
  return {
    previousValue,
    delta,
    ratio: previousValue === 0 ? null : delta / Math.abs(previousValue),
  };
}

/** Stable ids, valid UUIDs: `de300000-0000-4000-8000-<n>`. */
const id = (n: number) =>
  `de300000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const text = {
  en: {
    dashboard: "Example Roastery",
    overview: "Overview",
    growth: "Growth",
    visitors: "Visitors · All sites",
    signups: "Sign-ups · All sites",
    revenue: "Revenue · Shop",
    visitorsTrend: "Visitors · Last 30 days",
    visitorsBySite: "Visitors by site",
    goal: "Sign-ups this month",
    goalName: "%d sign-ups a month",
    conversion: "Visitors to sign-ups",
    conversionLabel: "conversion",
    signupsName: "Sign-ups",
    visitorsName: "Visitors",
    revenueByCountry: "Revenue by country",
    country: "Country",
    revenueColumn: "Revenue",
    others: "Others",
    sources: "Sources",
    note: "## This is a demo\nThe numbers are made up. Pair this screen with **netrics** to show your own dashboard.",
    countries: ["Germany", "Austria", "Switzerland", "Netherlands", "France"],
    sourceNames: ["Shop analytics", "Payments", "Newsletter", "App Store"],
  },
  de: {
    dashboard: "Beispiel-Rösterei",
    overview: "Überblick",
    growth: "Wachstum",
    visitors: "Besucher · Alle Websites",
    signups: "Registrierungen · Alle Websites",
    revenue: "Umsatz · Shop",
    visitorsTrend: "Besucher · Letzte 30 Tage",
    visitorsBySite: "Besucher nach Website",
    goal: "Registrierungen diesen Monat",
    goalName: "%d Registrierungen pro Monat",
    conversion: "Besucher zu Registrierungen",
    conversionLabel: "Conversion",
    signupsName: "Registrierungen",
    visitorsName: "Besucher",
    revenueByCountry: "Umsatz nach Land",
    country: "Land",
    revenueColumn: "Umsatz",
    others: "Andere",
    sources: "Quellen",
    note: "## Das ist eine Demo\nDie Zahlen sind erfunden. Kopple diesen Bildschirm mit **netrics**, um dein eigenes Dashboard zu zeigen.",
    countries: [
      "Deutschland",
      "Österreich",
      "Schweiz",
      "Niederlande",
      "Frankreich",
    ],
    sourceNames: ["Shop-Analyse", "Zahlungen", "Newsletter", "App Store"],
  },
} as const;

const sites = ["shop.example.com", "blog.example.com", "app.example.com"];

/** Shared by every data widget: as the server reports a healthy daily metric. */
function dataShape(
  period: "last_7_days" | "this_month" | "last_30_days",
  unit: string | null,
  minutes: number,
) {
  return {
    period,
    aggregation: "sum" as const,
    unit,
    conversion: null,
    kind: "delta" as const,
    granularity: "day" as const,
    better: "higher" as const,
    status: "ok" as const,
    updatedAt: ago(minutes),
  };
}

function placed<T extends DeviceWidgetV3["type"]>(
  type: T,
  n: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  return {
    type,
    id: id(n),
    x,
    y,
    w,
    h,
    min: { ...STUDIO_MIN_WIDGET_SIZE[type] },
  };
}

/** The demo payload in one language; the numbers are the same in both. */
function buildDemoPayload(language: Language): DeviceDashboardV3Response {
  const t = text[language];
  // Visitors and sign-ups of the last 60 days: 30 shown, 30 before.
  const visitors = daily(416, 60, 5200, 0.25);
  const signups = visitors.map((value, index) =>
    Math.round(
      value * (0.029 + 0.0001 * index + 0.003 * random(900 + index)()),
    ),
  );
  const revenue = daily(1416, 60, 186_000, 0.18);
  const last = (values: number[], days: number) => values.slice(-days);
  const before = (values: number[], days: number) =>
    values.slice(-2 * days, -days);

  const visitors7 = last(visitors, 7);
  const signups7 = last(signups, 7);
  const visitors30 = last(visitors, 30);
  const signups30 = last(signups, 30);
  // The month so far (the payload is from 29 October).
  const dayOfMonth = new Date(today).getUTCDate();
  const revenueMonth = last(revenue, dayOfMonth);
  const revenueMonthBefore = before(revenue, dayOfMonth);
  const signupsMonth = sum(last(signups, dayOfMonth));
  // A goal the month is on its way to: 90 % or so with days to go.
  const goalTarget = Math.ceil((signupsMonth * 1.1) / 500) * 500;
  const periodEnd = Date.UTC(
    new Date(today).getUTCFullYear(),
    new Date(today).getUTCMonth() + 1,
    1,
  );

  const siteShares = [0.58, 0.27, 0.15];
  const countryShares = [0.46, 0.17, 0.14, 0.09, 0.06];
  const revenue30 = sum(last(revenue, 30));
  const revenue30Before = sum(before(revenue, 30));
  const countryNoise = random(77);

  const overview: DeviceWidgetV3[] = [
    {
      ...placed("metric", 1, 0, 0, 3, 2),
      label: t.visitors,
      options: { showSparkline: true, showChange: true },
      data: {
        ...dataShape("last_7_days", "count", 3),
        value: sum(visitors7),
        change: change(sum(visitors7), sum(before(visitors, 7))),
        spark: visitors7,
      },
    },
    {
      ...placed("metric", 2, 3, 0, 3, 2),
      label: t.signups,
      options: { showSparkline: true, showChange: true },
      data: {
        ...dataShape("last_7_days", "count", 3),
        value: sum(signups7),
        change: change(sum(signups7), sum(before(signups, 7))),
        spark: signups7,
      },
    },
    {
      ...placed("metric", 3, 6, 0, 3, 2),
      label: t.revenue,
      options: { showSparkline: true, showChange: true },
      data: {
        ...dataShape("this_month", "EUR_minor", 7),
        value: sum(revenueMonth),
        change: change(sum(revenueMonth), sum(revenueMonthBefore)),
        spark: revenueMonth,
      },
    },
    {
      ...placed("clock", 4, 9, 0, 3, 2),
      label: null,
      options: { showDate: true, hour12: false, timeZone: "UTC" },
    },
    {
      ...placed("line", 5, 0, 2, 8, 6),
      label: t.visitorsTrend,
      options: { showPrevious: true, showAxis: true },
      data: {
        ...dataShape("last_30_days", "count", 3),
        value: sum(visitors30),
        change: change(sum(visitors30), sum(before(visitors, 30))),
        buckets: visitors30.map((_, index) =>
          iso(today - (29 - index) * DAY_MS),
        ),
        values: visitors30,
        previous: before(visitors, 30),
      },
    },
    {
      ...placed("bar", 6, 8, 2, 4, 6),
      label: t.visitorsBySite,
      options: { groupBy: "resource", limit: 5 },
      data: {
        ...dataShape("last_30_days", "count", 3),
        groupBy: "resource",
        bars: sites.map((site, index) => ({
          key: site,
          label: site,
          value: Math.round(sum(visitors30) * (siteShares[index] ?? 0)),
        })),
        others: null,
      },
    },
  ];

  const growth: DeviceWidgetV3[] = [
    {
      ...placed("gauge", 11, 0, 0, 3, 4),
      label: t.goal,
      options: { showTimeLeft: true },
      data: {
        ...dataShape("this_month", "count", 3),
        goal: {
          id: id(100),
          name: t.goalName.replace(
            "%d",
            goalTarget.toLocaleString(language === "de" ? "de-DE" : "en-US"),
          ),
        },
        value: signupsMonth,
        target: goalTarget,
        progress: signupsMonth / goalTarget,
        reachedAt: null,
        periodEnd: iso(periodEnd),
      },
    },
    {
      ...placed("compare", 12, 3, 0, 5, 4),
      label: t.conversion,
      options: {
        format: "percent",
        ratioLabel: t.conversionLabel,
        showChange: true,
      },
      data: {
        ...dataShape("last_30_days", null, 3),
        numerator: {
          label: t.signupsName,
          value: sum(signups30),
          unit: "count",
        },
        denominator: {
          label: t.visitorsName,
          value: sum(visitors30),
          unit: "count",
        },
        ratio: {
          value: sum(signups30) / sum(visitors30),
          previousValue: sum(before(signups, 30)) / sum(before(visitors, 30)),
          format: "percent",
        },
      },
    },
    {
      ...placed("status", 13, 8, 0, 4, 4),
      label: t.sources,
      options: { connectionIds: null, showAge: true },
      data: {
        status: "ok",
        items: [
          // Attention first, then by name, as the server orders them.
          { name: t.sourceNames[2], status: "stale", minutes: 6 * 60 },
          { name: t.sourceNames[3], status: "ok", minutes: 41 },
          { name: t.sourceNames[1], status: "ok", minutes: 7 },
          { name: t.sourceNames[0], status: "ok", minutes: 3 },
        ].map((item, index) => ({
          connectionId: id(200 + index),
          name: item.name,
          status: item.status as "ok" | "stale",
          lastSuccessAt: ago(item.minutes),
        })),
      },
    },
    {
      ...placed("table", 14, 0, 4, 8, 4),
      label: t.revenueByCountry,
      options: {
        groupBy: "territory",
        limit: 5,
        showChange: true,
        showOthers: true,
      },
      data: {
        ...dataShape("last_30_days", "EUR_minor", 7),
        groupBy: "territory",
        columns: { label: t.country, value: t.revenueColumn },
        rows: ["DE", "AT", "CH", "NL", "FR"].map((key, index) => {
          const share = countryShares[index] ?? 0;
          const value = Math.round(revenue30 * share);
          const previousValue = Math.round(
            revenue30Before * share * (0.85 + countryNoise() * 0.25),
          );
          return {
            key,
            label: t.countries[index] ?? key,
            value,
            previousValue,
            ratio: (value - previousValue) / previousValue,
          };
        }),
        others: {
          label: t.others,
          value: Math.round(revenue30 * 0.08),
          groups: 14,
        },
      },
    },
    {
      ...placed("text", 15, 8, 4, 4, 4),
      label: null,
      text: t.note,
      options: { size: "body", align: "start" },
    },
  ];

  const theme = BUILTIN_THEMES.midnight;
  return {
    version: `demo-1-${language}`,
    schema: 3,
    refreshAfterSec: 60,
    timeZone: "UTC",
    locale: language,
    primaryFormat: "16x9",
    formats: Object.fromEntries(
      (["16x9", "21x9", "4x3", "3x4", "9x16"] as const).map((key) => {
        const spec = SCREEN_FORMATS[key];
        return [
          key,
          {
            columns: spec.columns,
            rows: spec.rows,
            reference: [spec.reference.width, spec.reference.height],
          },
        ];
      }),
    ) as DeviceDashboardV3Response["formats"],
    device: { rotation: 0, displayMode: "screen" },
    dashboard: {
      id: id(0),
      name: t.dashboard,
      showHeader: true,
      logo: null,
    },
    theme: { name: theme.name, tokens: { ...theme.tokens } },
    rotation: { autoAdvance: true, transition: "fade" },
    slides: [
      {
        id: id(10),
        name: t.overview,
        durationSec: 15,
        background: null,
        widgets: overview,
        layouts: [],
      },
      {
        id: id(20),
        name: t.growth,
        durationSec: 15,
        background: null,
        widgets: growth,
        layouts: [],
      },
    ],
    images: [],
  };
}

const LANGUAGES: Language[] = ["en", "de"];

const fileOf = (language: Language) =>
  new URL(
    `../../../apps/netrics-tv/NetricsKit/Sources/NetricsUI/Resources/demo-dashboard.${language}.json`,
    import.meta.url,
  );

/** Every ISO timestamp in a JSON value, with the key it is under. */
function timestamps(value: unknown, key = ""): Array<[string, string]> {
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? [[key, value]] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v) => timestamps(v, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => timestamps(v, k));
  }
  return [];
}

describe("netrics TV demo payload (#416)", () => {
  for (const language of LANGUAGES) {
    it(`${language}: the bundled file is the generated one (pnpm demo:tv regenerates it)`, () => {
      const text = `${JSON.stringify(buildDemoPayload(language), null, 2)}\n`;
      if (process.env.UPDATE_TV_DEMO === "1") {
        writeFileSync(fileOf(language), text);
      }
      expect(JSON.parse(readFileSync(fileOf(language), "utf8"))).toEqual(
        JSON.parse(text),
      );
    });

    it(`${language}: the bundled file is a valid schema 3 payload`, () => {
      const bundled: unknown = JSON.parse(
        readFileSync(fileOf(language), "utf8"),
      );
      const parsed = deviceDashboardV3ResponseSchema.parse(bundled);
      // Parsing kept everything: no field the contract does not know.
      expect(parsed).toEqual(bundled);
      expect(parsed.locale).toBe(language);
    });
  }

  it("has two slides, several widget types, a theme and no images", () => {
    const payload = buildDemoPayload("en");
    expect(payload.slides).toHaveLength(2);
    const types = new Set(
      payload.slides.flatMap((slide) => slide.widgets.map((w) => w.type)),
    );
    expect(types.size).toBeGreaterThanOrEqual(8);
    expect(payload.images).toEqual([]);
    expect(payload.dashboard?.logo).toBeNull();
    expect(payload.slides.every((slide) => slide.background === null)).toBe(
      true,
    );
    expect(payload.theme.tokens).toEqual(BUILTIN_THEMES.midnight.tokens);
  });

  it("has the same numbers in both languages", () => {
    const numbers = (value: unknown): unknown[] =>
      typeof value === "number"
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(numbers)
          : value !== null && typeof value === "object"
            ? Object.values(value).flatMap(numbers)
            : [];
    expect(numbers(buildDemoPayload("de"))).toEqual(
      numbers(buildDemoPayload("en")),
    );
  });

  it("is from DEMO_GENERATED_AT: no sync after it, every bucket before it", () => {
    for (const [key, value] of timestamps(buildDemoPayload("en"))) {
      if (key === "updatedAt" || key === "lastSuccessAt") {
        expect(Date.parse(value)).toBeLessThanOrEqual(generatedAt);
      }
    }
    const line = buildDemoPayload("en")
      .slides.flatMap((slide) => slide.widgets)
      .find((widget) => widget.type === "line");
    expect(line?.type === "line" && line.data.buckets.at(-1)).toBe(iso(today));
  });

  it("fits every widget in the 16x9 grid without overlaps", () => {
    for (const slide of buildDemoPayload("en").slides) {
      const cells = new Set<string>();
      for (const widget of slide.widgets) {
        expect(widget.w).toBeGreaterThanOrEqual(widget.min.w);
        expect(widget.h).toBeGreaterThanOrEqual(widget.min.h);
        expect(widget.x + widget.w).toBeLessThanOrEqual(12);
        expect(widget.y + widget.h).toBeLessThanOrEqual(8);
        for (let x = widget.x; x < widget.x + widget.w; x++) {
          for (let y = widget.y; y < widget.y + widget.h; y++) {
            expect(cells.has(`${x},${y}`)).toBe(false);
            cells.add(`${x},${y}`);
          }
        }
      }
    }
  });
});
