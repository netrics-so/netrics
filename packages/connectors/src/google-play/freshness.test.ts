import { describe, expect, it } from "vitest";
import {
  syncResultSchema,
  type ConnectionContext,
  type SyncResult,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
} from "@netrics/connector-sdk/testing";

import { createGooglePlayConnector, googlePlayManifest } from "./index.js";
import { PLAY_STREAMS } from "./sync.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  fixtureBytes,
  TEST_BUCKET,
  TEST_NOW,
} from "./test-helpers.js";

// Freshness of Google Play (ADR 0025, #703): what a run confirmed from the
// report files themselves, offline with fixed clocks.

const context: ConnectionContext = {
  connectionId: "play-freshness",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: `gs://${TEST_BUCKET}/stats/installs/` },
};

/** Every page of one run; the done result. */
async function run(
  fake: ReturnType<typeof fakePlay>,
  now = TEST_NOW,
  from = "2026-10-01T00:00:00.000Z",
): Promise<SyncResult> {
  const connector = createGooglePlayConnector({ now: () => now });
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const result = syncResultSchema.parse(
      await connector.sync(
        context,
        {
          mode: "backfill",
          from,
          to: new Date(now).toISOString(),
          resources: [ALPHA, BETA],
          cursor,
        },
        fake.runtime,
      ),
    );
    if (result.done) {
      expectValidFreshness(googlePlayManifest, result);
      return result;
    }
    expect(result.freshness).toBeUndefined();
    cursor = result.nextCursor;
  }
  throw new Error("Sync did not finish");
}

describe("Google Play freshness", () => {
  it("reports the newest day of each app's reports, the last complete earnings month and the listing", async () => {
    const fake = fakePlay();
    fake.put(
      `stats/ratings/ratings_${ALPHA}_202610_overview.csv`,
      fixtureBytes("ratings-alpha-overview.csv"),
    );
    // 5 November: November's reports are not published yet.
    const result = await run(fake);
    expect(result.freshness).toEqual([
      { stream: "installs", resource: ALPHA, dataThrough: "2026-10-03" },
      { stream: "installs", resource: BETA, dataThrough: "2026-10-01" },
      { stream: "ratings", resource: ALPHA, dataThrough: "2026-10-04" },
      { stream: "earnings", dataThrough: "2026-10-31" },
      { stream: "listing_ratings" },
    ]);
    // No rating report for Beta: no entry. Google documents no publication
    // time: no entry has expected times.
    expect(freshnessEntry(result, PLAY_STREAMS.ratings, BETA)).toBeUndefined();
    expect(
      result.freshness?.some(
        (entry) => entry.nextExpectedAt ?? entry.expectedFrom,
      ),
    ).toBe(false);
  });

  it("counts an earnings month only once it is over in Pacific Time", async () => {
    // 1 November 06:59 UTC is 31 October 23:59 PDT: October is still running.
    const october = await run(
      fakePlay(),
      Date.parse("2026-11-01T06:59:00.000Z"),
    );
    expect(freshnessEntry(october, PLAY_STREAMS.earnings)).toBeUndefined();
    // One minute later it is 1 November in Los Angeles.
    const november = await run(
      fakePlay(),
      Date.parse("2026-11-01T07:00:00.000Z"),
    );
    expect(freshnessEntry(november, PLAY_STREAMS.earnings)).toEqual({
      stream: PLAY_STREAMS.earnings,
      dataThrough: "2026-10-31",
    });
  });

  it("reports no earnings without access to them, and installs go on", async () => {
    const fake = fakePlay();
    fake.privateStatus.set("earnings/", 403);
    const result = await run(fake);
    expect(freshnessEntry(result, PLAY_STREAMS.earnings)).toBeUndefined();
    expect(
      freshnessEntry(result, PLAY_STREAMS.installs, ALPHA)?.dataThrough,
    ).toBe("2026-10-03");
  });

  it("reports no earnings for an unreadable earnings report", async () => {
    const fake = fakePlay();
    fake.put(
      "earnings/earnings_202610.zip",
      new TextEncoder().encode("invalid zip"),
    );
    const result = await run(fake);
    expect(freshnessEntry(result, PLAY_STREAMS.earnings)).toBeUndefined();
  });

  it("reports no listing when an app's listing could not be read", async () => {
    const fake = fakePlay();
    fake.publicStatus.set(BETA, 429);
    const result = await run(fake);
    expect(freshnessEntry(result, PLAY_STREAMS.listingRatings)).toBeUndefined();
    expect(freshnessEntry(result, PLAY_STREAMS.installs, BETA)).toBeDefined();
  });

  it("declares the streams of ADR 0025, report status in none", () => {
    expect(
      googlePlayManifest.freshnessStreams?.map((stream) => [
        stream.key,
        stream.kind,
        stream.period,
        stream.datasets,
      ]),
    ).toEqual([
      ["installs", "periodic", undefined, ["install_rows"]],
      ["earnings", "periodic", "month", ["earning_rows"]],
      ["ratings", "periodic", undefined, ["rating_rows"]],
      ["listing_ratings", "continuous", undefined, ["store_ratings"]],
    ]);
  });
});
