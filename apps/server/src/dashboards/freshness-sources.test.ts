import { describe, expect, it } from "vitest";

import type { ConnectorManifest } from "@netrics/connector-sdk";
import type { ConnectionFreshnessRow } from "@netrics/database";

import { summarizeFreshness, type UsedRow } from "./freshness.js";

// Freshness per source (#784, ADR 0025 section 7): a widget whose rows
// come from several connectors lists each one's summary, so the least
// fresh source no longer hides the others' day and next time.

const NOW = new Date("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;
const at = (offset: number) => new Date(NOW.getTime() + offset);

const appStore = {
  id: "app-store-connect",
  name: "App Store Connect",
  freshnessStreams: [
    {
      key: "sales",
      name: "Sales",
      kind: "periodic",
      timeZone: "America/Los_Angeles",
    },
    { key: "listing_ratings", name: "Listing ratings", kind: "continuous" },
  ],
} as unknown as ConnectorManifest;
const play = {
  id: "google-play",
  name: "Google Play",
  translations: { de: { freshnessStreams: { installs: "Installationen" } } },
  freshnessStreams: [
    {
      key: "installs",
      name: "Installs",
      kind: "periodic",
      timeZone: "America/Los_Angeles",
    },
  ],
} as unknown as ConnectorManifest;
const other = {
  id: "vercel",
  name: "Vercel",
  translations: { de: { name: "Vercel DE" } },
  freshnessStreams: [{ key: "traffic", name: "Traffic", kind: "continuous" }],
} as unknown as ConnectorManifest;

function used(
  manifest: ConnectorManifest,
  connectionId: string,
  stream: string,
  fields: Partial<ConnectionFreshnessRow> = {},
): UsedRow {
  const declared = manifest.freshnessStreams!.find((s) => s.key === stream)!;
  return {
    connectionId,
    manifest,
    stream: declared,
    row: {
      workspaceId: "w",
      connectionId,
      stream,
      resource: "",
      dataThrough: null,
      timeZone: null,
      expectedFrom: null,
      nextExpectedAt: null,
      checkedAt: at(-10 * 60_000),
      advancedAt: null,
      ...fields,
    },
  };
}

const ASC = "11111111-1111-4111-8111-111111111111",
  ASC2 = "22222222-2222-4222-8222-222222222222",
  GP = "33333333-3333-4333-8333-333333333333",
  VC = "44444444-4444-4444-8444-444444444444";
const due = new Map<string, Date | null>([
  [ASC, at(2 * HOUR)],
  [ASC2, at(3 * HOUR)],
  [GP, at(4 * HOUR)],
  [VC, at(HOUR / 4)],
]);

describe("freshness per source (#784)", () => {
  const sales = used(appStore, ASC, "sales", {
    dataThrough: "2026-11-17",
    nextExpectedAt: at(9 * HOUR),
  });
  const installs = used(play, GP, "installs", { dataThrough: "2026-11-11" });

  it("lists each connector's day and next time, by name", () => {
    const { freshness } = summarizeFreshness([installs, sales], due);
    // The summary stays the least fresh, for clients without `sources`.
    expect(freshness).toMatchObject({
      kind: "periodic",
      stream: "Installs",
      dataThrough: "2026-11-11",
    });
    expect(freshness).not.toHaveProperty("nextExpectedAt");
    expect(freshness?.sources).toEqual([
      {
        source: "App Store",
        kind: "periodic",
        stream: "Sales",
        fetchedAt: at(-10 * 60_000).toISOString(),
        dataThrough: "2026-11-17",
        nextExpectedAt: at(9 * HOUR).toISOString(),
        nextCheckAt: at(2 * HOUR).toISOString(),
      },
      {
        source: "Google Play",
        kind: "periodic",
        stream: "Installs",
        fetchedAt: at(-10 * 60_000).toISOString(),
        dataThrough: "2026-11-11",
        nextCheckAt: at(4 * HOUR).toISOString(),
      },
    ]);
  });

  it("summarizes the connections of one connector as one source", () => {
    const older = used(appStore, ASC2, "sales", {
      dataThrough: "2026-11-16",
      nextExpectedAt: at(8 * HOUR),
    });
    const { freshness } = summarizeFreshness([sales, older, installs], due);
    expect(freshness?.sources?.map((s) => [s.source, s.dataThrough])).toEqual([
      ["App Store", "2026-11-16"],
      ["Google Play", "2026-11-11"],
    ]);
    expect(freshness?.sources?.[0]?.nextCheckAt).toBe(
      at(2 * HOUR).toISOString(),
    );
  });

  it("keeps a periodic source's day over its continuous rows", () => {
    const listing = used(appStore, ASC, "listing_ratings");
    const { freshness } = summarizeFreshness([listing, sales, installs], due);
    expect(freshness?.sources?.[0]).toMatchObject({
      source: "App Store",
      kind: "periodic",
      dataThrough: "2026-11-17",
    });
  });

  it("names a continuous-only source by its check", () => {
    const traffic = used(other, VC, "traffic");
    const { freshness } = summarizeFreshness([traffic, sales], due, "de");
    expect(freshness?.sources).toEqual([
      expect.objectContaining({ source: "App Store", kind: "periodic" }),
      expect.objectContaining({
        source: "Vercel DE",
        kind: "continuous",
        stream: "Traffic",
        nextCheckAt: at(HOUR / 4).toISOString(),
      }),
    ]);
  });

  it("has no sources for one connector's rows", () => {
    const older = used(appStore, ASC2, "sales", { dataThrough: "2026-11-16" });
    expect(
      summarizeFreshness([sales, older], due).freshness,
    ).not.toHaveProperty("sources");
    expect(summarizeFreshness([installs], due).freshness).not.toHaveProperty(
      "sources",
    );
  });

  it("marks a late source late on its own", () => {
    const late = used(play, GP, "installs", {
      dataThrough: "2026-11-11",
      nextExpectedAt: at(-6 * HOUR),
      checkedAt: at(-HOUR),
    });
    const { freshness } = summarizeFreshness([sales, late], due);
    expect(freshness?.sources?.map((s) => s.late ?? false)).toEqual([
      false,
      true,
    ]);
  });
});
