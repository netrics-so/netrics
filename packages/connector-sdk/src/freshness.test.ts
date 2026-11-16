import { describe, expect, it } from "vitest";

import {
  freshnessEntrySchema,
  freshnessProblem,
  isCalendarDate,
  type FreshnessStream,
} from "./freshness.js";
import { connectorManifestSchema } from "./manifest.js";
import { syncResultSchema } from "./transport.js";
import { SDK_VERSION, assertManifestCompatible } from "./version.js";

const metric = (key: string) => ({
  key,
  name: key,
  description: `${key} per day.`,
  kind: "delta",
  unit: "count",
  granularity: "day",
  dimensions: ["resource"],
  aggregations: ["sum"],
});

const dataset = (key: string, reportingTimeZone?: string) => ({
  key,
  name: key,
  version: 1,
  fields: [
    {
      id: "day",
      name: "Day",
      type: "date",
      nullable: false,
      classification: "public",
    },
  ],
  keyFields: ["day"],
  grain: "one row per day",
  mode: "upsert",
  reportingField: "day",
  ...(reportingTimeZone ? { reportingTimeZone } : {}),
});

function manifest(freshnessStreams?: unknown, extra: object = {}) {
  return {
    id: "acme-store",
    version: "1.0.0",
    sdkVersion: `^${SDK_VERSION}`,
    name: "Acme Store",
    description: "Fixture manifest for freshness tests.",
    authStrategies: [{ strategy: "token" }],
    configSchema: { type: "object" },
    metrics: [metric("sales"), metric("units"), metric("reviews")],
    datasets: [
      dataset("sales_rows", "America/Los_Angeles"),
      dataset("ratings", "UTC"),
    ],
    minRefreshIntervalSeconds: 21_600,
    supportsBackfill: false,
    outboundDomains: ["api.acme.test"],
    ...(freshnessStreams === undefined ? {} : { freshnessStreams }),
    ...extra,
  };
}

const SALES = {
  key: "sales",
  name: "Sales",
  kind: "periodic",
  timeZone: "America/Los_Angeles",
  metrics: ["sales", "units"],
  datasets: ["sales_rows"],
};
const REVIEWS = { key: "reviews", name: "Reviews", kind: "continuous" };

function issues(input: unknown): string[] {
  const parsed = connectorManifestSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("manifest freshnessStreams (SDK 0.2.13, ADR 0025 §1)", () => {
  it("is optional: manifests without streams stay valid", () => {
    expect(assertManifestCompatible(manifest()).freshnessStreams).toBe(
      undefined,
    );
  });

  it("accepts periodic and continuous streams with their members", () => {
    const parsed = assertManifestCompatible(
      manifest([
        SALES,
        { ...REVIEWS, metrics: ["reviews"] },
        {
          key: "earnings",
          name: "Earnings",
          kind: "periodic",
          period: "month",
          timeZone: "America/Los_Angeles",
        },
      ]),
    );
    expect(parsed.freshnessStreams?.map((s) => s.key)).toEqual([
      "sales",
      "reviews",
      "earnings",
    ]);
  });

  it("rejects duplicate keys", () => {
    expect(issues(manifest([SALES, { ...REVIEWS, key: "sales" }]))).toEqual([
      expect.stringContaining("unique"),
    ]);
  });

  it("rejects unknown metrics and datasets", () => {
    expect(issues(manifest([{ ...SALES, metrics: ["nope"] }]))).toEqual([
      expect.stringContaining('unknown metric "nope"'),
    ]);
    expect(issues(manifest([{ ...SALES, datasets: ["nope"] }]))).toEqual([
      expect.stringContaining('unknown dataset "nope"'),
    ]);
  });

  it("rejects a metric or dataset in two streams", () => {
    expect(
      issues(manifest([SALES, { ...REVIEWS, metrics: ["units"] }])),
    ).toEqual([expect.stringContaining('metric "units" belongs to')]);
    expect(
      issues(manifest([SALES, { ...REVIEWS, datasets: ["sales_rows"] }])),
    ).toEqual([expect.stringContaining('dataset "sales_rows" belongs to')]);
  });

  it("requires a valid zone on periodic streams and none on continuous ones", () => {
    expect(issues(manifest([{ ...SALES, timeZone: undefined }]))).toEqual([
      expect.stringContaining("needs a timeZone"),
    ]);
    expect(
      issues(manifest([{ ...SALES, timeZone: "Mars/Olympus" }])),
    ).toContainEqual(expect.stringContaining("invalid"));
    expect(
      issues(manifest([{ ...REVIEWS, timeZone: "UTC", period: "day" }])),
    ).toHaveLength(2);
  });

  it("requires a periodic stream's datasets to report in its zone", () => {
    expect(
      issues(manifest([{ ...SALES, datasets: ["sales_rows", "ratings"] }])),
    ).toEqual([expect.stringContaining('dataset "ratings" reports in UTC')]);
    // A continuous stream has no zone to match.
    expect(issues(manifest([{ ...REVIEWS, datasets: ["ratings"] }]))).toEqual(
      [],
    );
  });

  it("translates stream names, and only declared ones", () => {
    const de = { freshnessStreams: { sales: "Verkäufe" } };
    expect(
      assertManifestCompatible(manifest([SALES], { translations: { de } }))
        .translations?.de?.freshnessStreams,
    ).toEqual({ sales: "Verkäufe" });
    expect(
      issues(
        manifest([SALES], {
          translations: { de: { freshnessStreams: { nope: "X" } } },
        }),
      ),
    ).toEqual([expect.stringContaining('unknown freshness stream "nope"')]);
  });
});

describe("SyncResult freshness (ADR 0025 §2)", () => {
  const streams = [SALES, REVIEWS] as FreshnessStream[];

  it("is optional on a sync result", () => {
    expect(
      syncResultSchema.parse({ observations: [], done: true }).freshness,
    ).toBe(undefined);
  });

  it("accepts periodic and continuous entries", () => {
    const entries = [
      {
        stream: "sales",
        dataThrough: "2026-11-15",
        expectedFrom: "2026-11-17T18:00:00.000Z",
        nextExpectedAt: "2026-11-17T20:00:00.000Z",
      },
      { stream: "sales", resource: "app-1", dataThrough: "2026-11-14" },
      { stream: "reviews" },
    ];
    const result = syncResultSchema.parse({
      observations: [],
      freshness: entries,
      done: true,
    });
    expect(freshnessProblem(streams, result.freshness)).toBeNull();
  });

  it("rejects malformed dates, instants, zones and expected order", () => {
    const bad = [
      { stream: "sales", dataThrough: "2026-02-30" },
      { stream: "sales", dataThrough: "2026-11-15T00:00:00Z" },
      { stream: "sales", timeZone: "Nowhere/City" },
      { stream: "sales", nextExpectedAt: "tomorrow" },
      { stream: "sales", nextExpectedAt: "2026-11-17T20:00:00+01:00" },
      { stream: "sales", expectedFrom: "2026-11-17T20:00:00.000Z" },
      {
        stream: "sales",
        expectedFrom: "2026-11-17T21:00:00.000Z",
        nextExpectedAt: "2026-11-17T20:00:00.000Z",
      },
      { stream: "Sales" },
      { stream: "sales", extra: true },
    ];
    for (const entry of bad)
      expect(
        freshnessEntrySchema.safeParse(entry).success,
        JSON.stringify(entry),
      ).toBe(false);
  });

  it("refuses undeclared streams, duplicates and dates on continuous streams", () => {
    expect(freshnessProblem(streams, [{ stream: "traffic" }])).toMatch(
      /undeclared freshness stream "traffic"/,
    );
    expect(freshnessProblem(undefined, [{ stream: "sales" }])).toMatch(
      /undeclared/,
    );
    expect(
      freshnessProblem(streams, [{ stream: "sales" }, { stream: "sales" }]),
    ).toMatch(/duplicate/);
    expect(
      freshnessProblem(streams, [
        { stream: "sales", resource: "a" },
        { stream: "sales", resource: "b" },
        { stream: "sales" },
      ]),
    ).toBeNull();
    expect(
      freshnessProblem(streams, [
        { stream: "reviews", dataThrough: "2026-11-15" },
      ]),
    ).toMatch(/continuous/);
    expect(
      freshnessProblem(streams, [
        { stream: "reviews", nextExpectedAt: "2026-11-17T20:00:00.000Z" },
      ]),
    ).toMatch(/continuous/);
  });

  it("checks calendar dates strictly", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2025-02-29")).toBe(false);
    expect(isCalendarDate("2025-13-01")).toBe(false);
    expect(isCalendarDate("25-01-01")).toBe(false);
  });
});
