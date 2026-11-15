import { describe, expect, it } from "vitest";
import {
  syncResultSchema,
  validateDatasetPage,
  type ConnectionContext,
  type DatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";

import { ratingReportDataset, ratingRows } from "./datasets.js";
import { createGooglePlayConnector, googlePlayManifest } from "./index.js";
import { REPORT_READER } from "./sync.js";
import { ReportFormatError } from "./tabular.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  fixtureBytes,
  TEST_BUCKET,
  TEST_NOW,
} from "./test-helpers.js";

/** The header of a Play Console rating overview report. */
const HEADER = "Date,Package Name,Daily Average Rating,Total Average Rating";
const RATINGS_202610 = `stats/ratings/ratings_${ALPHA}_202610_overview.csv`;

const utf16 = (text: string) =>
  new Uint8Array(Buffer.from("﻿" + text, "utf16le"));
const report = (header: string, lines: string[], eol = "\r\n") =>
  utf16([header, ...lines].join(eol) + eol);
const parse = (bytes: Uint8Array, month = "2026-10-01") =>
  ratingRows(bytes, ALPHA, month, RATINGS_202610, "1").map((row) => row.values);
function reason(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    if (error instanceof ReportFormatError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("Play Console rating overview reports", () => {
  it("reads the UTF-16LE report with BOM; 0.0 is no rating, never zero stars", () => {
    const bytes = fixtureBytes("ratings-alpha-overview.csv");
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const rows = parse(bytes);
    expect(rows).toEqual([
      {
        app_id: ALPHA,
        day: "2026-10-01",
        daily_average_rating: null,
        total_average_rating: "3.8000",
        report_file: RATINGS_202610,
        object_generation: "1",
        provider_fields: {
          Date: "2026-10-01",
          "Package Name": ALPHA,
          "Daily Average Rating": "0.0",
          "Total Average Rating": "3.8000",
        },
      },
      expect.objectContaining({
        day: "2026-10-02",
        daily_average_rating: "5.0",
        total_average_rating: "3.9167",
      }),
      expect.objectContaining({
        day: "2026-10-03",
        daily_average_rating: null,
        total_average_rating: "3.9167",
      }),
      expect.objectContaining({
        day: "2026-10-04",
        daily_average_rating: "4.5",
        total_average_rating: "4.0714",
      }),
    ]);
    // No rating count is derived: the report has none.
    expect(rows.every((row) => !("rating_count" in row))).toBe(true);
    expect(ratingReportDataset.fields.map((field) => field.id)).not.toContain(
      "rating_count",
    );
  });
  it("matches header variants by name; an app without ratings has a null total", () => {
    for (const header of [
      HEADER,
      "date,package name,daily average rating,total average rating",
      "Date, Package  Name ,Daily Average Rating,TOTAL AVERAGE RATING",
      // Column order is not significant.
      "Total Average Rating,Date,Daily Average Rating,Package Name",
    ]) {
      const names = header.split(",").map((name) => name.trim().toLowerCase());
      const line = (values: Record<string, string>) =>
        names
          .map(
            (name) =>
              values[
                name.replace(/\s+/g, " ") as
                  | "date"
                  | "package name"
                  | "daily average rating"
                  | "total average rating"
              ]!,
          )
          .join(",");
      const rows = parse(
        report(header, [
          line({
            date: "2026-10-05",
            "package name": ALPHA,
            "daily average rating": "0.0",
            "total average rating": "0.0",
          }),
          line({
            date: "2026-10-06",
            "package name": ALPHA,
            "daily average rating": "",
            "total average rating": "4.25",
          }),
        ]),
      );
      expect(
        rows.map((row) => [
          row.day,
          row.daily_average_rating,
          row.total_average_rating,
        ]),
      ).toEqual([
        ["2026-10-05", null, null],
        ["2026-10-06", null, "4.25"],
      ]);
    }
    // LF line ends and UTF-8 read the same.
    expect(
      ratingRows(
        new TextEncoder().encode(`${HEADER}\n2026-10-07,${ALPHA},3.0,4.1\n`),
        ALPHA,
        "2026-10-01",
        RATINGS_202610,
        "1",
      )[0]!.values,
    ).toMatchObject({
      daily_average_rating: "3.0",
      total_average_rating: "4.1",
    });
  });
  it("refuses unreadable reports with a safe reason code", () => {
    const one = (line: string, header = HEADER) =>
      reason(() => parse(report(header, [line])));
    expect(one(`2026-10-01,${ALPHA},4.0,6.2`)).toBe("invalid_value");
    expect(one(`2026-10-01,${ALPHA},-1.0,4.2`)).toBe("invalid_value");
    expect(one(`2026-10-01,${ALPHA},four,4.2`)).toBe("invalid_value");
    expect(one(`10/01/2026,${ALPHA},4.0,4.2`)).toBe("invalid_value");
    expect(one(`2026-10-01,${BETA},4.0,4.2`)).toBe("scope_mismatch");
    expect(one(`2026-09-30,${ALPHA},4.0,4.2`)).toBe("scope_mismatch");
    expect(one(`2026-10-01,${ALPHA},4.0`)).toBe("inconsistent_columns");
    expect(one(`2026-10-01,${ALPHA},"4.0,4.2`)).toBe("malformed_csv");
    expect(
      one(
        `2026-10-01,${ALPHA},4.0,4.2`,
        "Date,Package Name,Daily Average Rating,Average Rating",
      ),
    ).toBe("missing_columns:Total Average Rating");
    expect(
      reason(() =>
        parse(
          report(HEADER, [
            `2026-10-01,${ALPHA},4.0,4.2`,
            `2026-10-01,${ALPHA},4.0,4.2`,
          ]),
        ),
      ),
    ).toBe("duplicate_days");
    expect(
      reason(() => parse(new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]))),
    ).toBe("encoding");
  });
});

const context: ConnectionContext = {
  connectionId: "play-test",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: `gs://${TEST_BUCKET}/` },
};
async function sync(
  fake: ReturnType<typeof fakePlay>,
  request: Omit<SyncRequest, "to" | "resources">,
  resources: string[] = [ALPHA],
) {
  const connector = createGooglePlayConnector({ now: () => TEST_NOW });
  const pages: DatasetPage[] = [];
  let cursor = request.cursor;
  for (let turn = 0; turn < 300; turn++) {
    const result = syncResultSchema.parse(
      await connector.sync(
        context,
        { ...request, to: new Date(TEST_NOW).toISOString(), resources, cursor },
        fake.runtime,
      ),
    );
    for (const page of result.datasetPages ?? []) {
      validateDatasetPage(
        googlePlayManifest.datasets!.find(
          (definition) => definition.key === page.datasetKey,
        )!,
        page,
      );
      pages.push(page);
    }
    if (result.done) return { pages, cursor: result.nextCursor };
    cursor = result.nextCursor;
  }
  throw new Error("Sync did not finish");
}
const ratingStatus = (pages: DatasetPage[], app = ALPHA) =>
  pages
    .filter((page) => page.datasetKey === "report_status")
    .map((page) => page.records[0]!.values)
    .filter((row) => row.report_type === "ratings" && row.app_id === app)
    .map((row) => [row.report_month, row.availability, row.reason]);
const ratingPages = (pages: DatasetPage[]) =>
  pages.filter((page) => page.datasetKey === "rating_rows");

describe("rating report sync", () => {
  it("imports each app's monthly overview report and records its availability", async () => {
    const fake = fakePlay();
    fake.put(RATINGS_202610, fixtureBytes("ratings-alpha-overview.csv"));
    // Other dimensions of the rating report are not read.
    fake.put(
      `stats/ratings/ratings_${ALPHA}_202610_country.csv`,
      report("Date,Package Name,Country,Daily Average Rating", []),
    );
    // A gzip-encoded report reads the same (#609).
    fake.putGzip(
      `stats/ratings/ratings_${BETA}_202610_overview.csv`,
      report(HEADER, [`2026-10-01,${BETA},0.0,0.0`]),
    );
    const { pages, cursor } = await sync(
      fake,
      { mode: "backfill", from: "2026-10-01T00:00:00.000Z" },
      [ALPHA, BETA],
    );
    const rows = ratingPages(pages);
    expect(
      rows.map((page) => [page.window, page.complete, page.records.length]),
    ).toEqual([
      [
        {
          from: "2026-10-01",
          toExclusive: "2026-11-01",
          partition: { app_id: ALPHA },
        },
        true,
        4,
      ],
      [
        {
          from: "2026-10-01",
          toExclusive: "2026-11-01",
          partition: { app_id: BETA },
        },
        true,
        1,
      ],
    ]);
    expect(rows[0]!.records.at(-1)!.values).toMatchObject({
      day: "2026-10-04",
      total_average_rating: "4.0714",
    });
    expect(rows[1]!.records[0]!.values).toMatchObject({
      total_average_rating: null,
    });
    // November is expected but not published yet: a fact, not a zero rating.
    expect(ratingStatus(pages)).toEqual([
      ["2026-11-01", "not_published", null],
      ["2026-10-01", "available", null],
    ]);
    expect(
      fake.calls.some((call) =>
        decodeURIComponent(call.url.pathname).includes(
          `ratings_${ALPHA}_202610_country.csv`,
        ),
      ),
    ).toBe(false);
    expect(cursor).toBe(
      `google-play-done:${REPORT_READER}:${new Date(TEST_NOW).toISOString()}`,
    );
  });
  it("records an unreadable rating report with its reason and no rows", async () => {
    const fake = fakePlay();
    fake.put(
      RATINGS_202610,
      report("Date,Package Name,Daily Average Rating", [
        `2026-10-01,${ALPHA},4.0`,
      ]),
    );
    const { pages } = await sync(fake, {
      mode: "backfill",
      from: "2026-10-01T00:00:00.000Z",
    });
    expect(ratingPages(pages).flatMap((page) => page.records)).toEqual([]);
    expect(ratingStatus(pages)).toContainEqual([
      "2026-10-01",
      "invalid_report",
      "missing_columns:Total Average Rating",
    ]);
  });
  it("records missing permission for rating reports separately", async () => {
    const fake = fakePlay();
    fake.put(RATINGS_202610, fixtureBytes("ratings-alpha-overview.csv"));
    fake.privateStatus.set("stats/ratings/", 403);
    const { pages } = await sync(fake, {
      mode: "backfill",
      from: "2026-10-01T00:00:00.000Z",
    });
    expect(ratingPages(pages)).toEqual([]);
    expect(ratingStatus(pages)).toEqual([
      ["2026-11-01", "permission_missing", null],
      ["2026-10-01", "permission_missing", null],
    ]);
  });
  it("reads a year of rating reports once after the reader upgrade, then recent months", async () => {
    const fake = fakePlay();
    // An old month: unchanged for months, so an ordinary incremental sync
    // would not revisit it.
    fake.put(
      `stats/ratings/ratings_${ALPHA}_202603_overview.csv`,
      report(HEADER, [`2026-03-31,${ALPHA},5.0,4.5`]),
      "1",
      "2026-04-02T00:00:00.000Z",
    );
    fake.put(RATINGS_202610, fixtureBytes("ratings-alpha-overview.csv"));
    const lastSync = "2026-11-04T12:00:00.000Z";
    const months = (pages: DatasetPage[]) =>
      ratingPages(pages).map((page) => page.window!.from);
    // The previous reader's finished cursor: catch up over the import window.
    const upgraded = await sync(fake, {
      mode: "incremental",
      from: lastSync,
      cursor: `google-play-done:${REPORT_READER - 1}:${lastSync}`,
    });
    expect(months(upgraded.pages)).toEqual(["2026-10-01", "2026-03-01"]);
    // Afterwards only recent months are read again.
    const next = await sync(fake, {
      mode: "incremental",
      from: lastSync,
      cursor: upgraded.cursor,
    });
    expect(months(next.pages)).toEqual(["2026-10-01"]);
  });
});
