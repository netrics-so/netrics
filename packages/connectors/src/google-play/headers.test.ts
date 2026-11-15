import { describe, expect, it } from "vitest";
import {
  syncResultSchema,
  validateDatasetPage,
  type ConnectionContext,
  type DatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";

import {
  earningsRows,
  headerKey,
  installRows,
  resolveColumns,
} from "./datasets.js";
import { createGooglePlayConnector, googlePlayManifest } from "./index.js";
import { REPORT_READER } from "./sync.js";
import { ReportFormatError } from "./tabular.js";
import {
  ALPHA,
  fakePlay,
  fixtureBytes,
  TEST_BUCKET,
  TEST_NOW,
  zipArchive,
} from "./test-helpers.js";

/** The header line of a current Play Console country install report (#611). */
const PLAY_CONSOLE_HEADER =
  "Date,Package name,Country,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events";

const utf16 = (text: string) =>
  new Uint8Array(Buffer.from("\uFEFF" + text, "utf16le"));
const rows = (header: string, eol: string, month = "2026-10") =>
  [
    header,
    `${month}-01,${ALPHA},US,12,1,3,4200,10,1,3900,13,4,1`,
    `${month}-02,${ALPHA},DE,5,0,1,800,,0,760,5,1,0`,
  ].join(eol) + eol;

function reason(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    if (error instanceof ReportFormatError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("Play report header matching (#611)", () => {
  it("reads the delivered Play Console install header, UTF-16LE with BOM, CRLF", () => {
    const bytes = fixtureBytes("installs-play-console-2026.csv");
    // The fixture is the provider's encoding and header, byte for byte.
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(bytes).toString("utf16le").slice(1)).toMatch(
      new RegExp(`^${PLAY_CONSOLE_HEADER.replace(/[()]/g, "\\$&")}\r\n`),
    );
    const parsed = installRows(bytes, ALPHA, "2026-10-01", "report", "1");
    expect(parsed.map((row) => row.values)).toMatchObject([
      {
        app_id: ALPHA,
        day: "2026-10-01",
        country: "US",
        daily_user_installs: "10",
        daily_device_installs: "12",
      },
      { day: "2026-10-01", country: "DE", daily_user_installs: "4" },
      { day: "2026-10-02", daily_user_installs: "0" },
    ]);
    // Original columns stay exactly as delivered.
    const original = parsed[0]!.values.provider_fields as Record<
      string,
      string
    >;
    expect(Object.keys(original)).toEqual(PLAY_CONSOLE_HEADER.split(","));
    expect(original["Package name"]).toBe(ALPHA);
    expect(original).not.toHaveProperty("Package Name");
  });
  it("reads the current and the earlier capitalisation, with CRLF or LF", () => {
    for (const header of [
      PLAY_CONSOLE_HEADER,
      PLAY_CONSOLE_HEADER.replace("Package name", "Package Name"),
      PLAY_CONSOLE_HEADER.toUpperCase(),
      PLAY_CONSOLE_HEADER.replace(
        "Daily User Installs",
        " daily  user\tinstalls ",
      ),
    ])
      for (const eol of ["\r\n", "\n"]) {
        const parsed = installRows(
          utf16(rows(header, eol)),
          ALPHA,
          "2026-10-01",
          "report",
          "1",
        );
        expect(parsed.map((row) => row.values.daily_user_installs)).toEqual([
          "10",
          null,
        ]);
        expect(parsed.map((row) => row.values.country)).toEqual(["US", "DE"]);
      }
  });
  it("matches earnings headers the same way and keeps their delivered names", () => {
    const csv =
      "transaction date,Transaction type,PACKAGE ID,Merchant  Currency,amount (merchant currency),buyer country\n" +
      `2026-10-03,Charge,${ALPHA},EUR,1.25,de\n`;
    const parsed = earningsRows(
      zipArchive([{ name: "earnings.csv", bytes: utf16(csv) }]),
      "2026-10-01",
      "earnings/earnings_202610.zip",
      "1",
    );
    const row = parsed.records.get(ALPHA)![0]!.values;
    expect(row).toMatchObject({
      transaction_day: "2026-10-03",
      transaction_type: "Charge",
      currency: "EUR",
      merchant_amount: "1.25",
      country: "DE",
    });
    expect(Object.keys(row.provider_fields as object)).toContain(
      "Merchant  Currency",
    );
  });
  it("names only canonical columns when a report cannot be read", () => {
    expect(headerKey(" Package\u00a0 name ")).toBe("package name");
    const header = PLAY_CONSOLE_HEADER.replace("Package name,", "").replace(
      "Daily User Installs,",
      "",
    );
    expect(
      reason(() =>
        installRows(
          utf16(`${header}\n2026-10-01,US,1,1,1,1,1,1,1,1,1\n`),
          ALPHA,
          "2026-10-01",
          "report",
          "1",
        ),
      ),
    ).toBe("missing_columns:Package Name,Daily User Installs");
    expect(
      reason(() =>
        resolveColumns(["Package name", "package  Name"], ["Package Name"]),
      ),
    ).toBe("ambiguous_columns:Package Name");
    expect(
      reason(() =>
        installRows(
          utf16(rows(PLAY_CONSOLE_HEADER, "\n", "2026-09")),
          ALPHA,
          "2026-10-01",
          "report",
          "1",
        ),
      ),
    ).toBe("scope_mismatch");
    expect(
      reason(() =>
        installRows(
          new Uint8Array([0xc3, 0x28, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]),
          ALPHA,
          "2026-10-01",
          "report",
          "1",
        ),
      ),
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
) {
  const connector = createGooglePlayConnector({ now: () => TEST_NOW });
  const pages: DatasetPage[] = [];
  let cursor = request.cursor;
  for (let turn = 0; turn < 200; turn++) {
    const result = syncResultSchema.parse(
      await connector.sync(
        context,
        {
          ...request,
          to: new Date(TEST_NOW).toISOString(),
          resources: [ALPHA],
          cursor,
        },
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
const status = (pages: DatasetPage[], month: string) =>
  pages
    .filter((page) => page.datasetKey === "report_status")
    .map((page) => page.records[0]!.values)
    .filter(
      (row) => row.report_type === "installs" && row.report_month === month,
    );
const installMonths = (pages: DatasetPage[]) => [
  ...new Set(
    pages
      .filter((page) => page.datasetKey === "install_rows")
      .map((page) => page.window!.from),
  ),
];
const INSTALLS_202610 = `stats/installs/installs_${ALPHA}_202610_country.csv`;

describe("Play report availability reasons and re-reading (#611)", () => {
  it("imports the delivered header and records why a report is invalid", async () => {
    const fake = fakePlay();
    fake.put(INSTALLS_202610, fixtureBytes("installs-play-console-2026.csv"));
    const read = await sync(fake, {
      mode: "backfill",
      from: "2026-10-01T00:00:00.000Z",
    });
    expect(status(read.pages, "2026-10-01")).toMatchObject([
      { availability: "available", reason: null },
    ]);
    expect(
      read.pages
        .filter((page) => page.datasetKey === "install_rows")
        .flatMap((page) => page.records),
    ).toHaveLength(3);

    const broken = fakePlay();
    broken.put(
      INSTALLS_202610,
      utf16(
        rows(PLAY_CONSOLE_HEADER.replace("Package name", "Package"), "\r\n"),
      ),
    );
    const refused = await sync(broken, {
      mode: "backfill",
      from: "2026-10-01T00:00:00.000Z",
    });
    const [row] = status(refused.pages, "2026-10-01");
    expect(row).toMatchObject({
      availability: "invalid_report",
      reason: "missing_columns:Package Name",
    });
    // The status row carries no report values or object identity beyond names.
    expect(JSON.stringify(row)).not.toContain("4200");
    expect(JSON.stringify(row)).not.toContain(TEST_BUCKET);
  });
  it("reads every month again after a reader upgrade, then only recent months", async () => {
    const fake = fakePlay();
    // An old month the previous reader refused; its object is long unchanged.
    fake.put(
      `stats/installs/installs_${ALPHA}_202603_country.csv`,
      utf16(rows(PLAY_CONSOLE_HEADER, "\r\n", "2026-03")),
      "1",
      "2026-04-02T00:00:00.000Z",
    );
    const lastSync = "2026-11-04T12:00:00.000Z";
    const incremental = (cursor: string) =>
      sync(fake, { mode: "incremental", from: lastSync, cursor });

    // Reader 1 finished with the bare sync end: catch up over the window.
    const upgraded = await incremental(lastSync);
    expect(installMonths(upgraded.pages)).toContain("2026-03-01");
    expect(status(upgraded.pages, "2026-03-01")).toMatchObject([
      { availability: "available", reason: null },
    ]);
    expect(upgraded.cursor).toBe(
      `google-play-done:${REPORT_READER}:${new Date(TEST_NOW).toISOString()}`,
    );

    // A finished sync of this reader revisits recent months only.
    const next = await incremental(upgraded.cursor!);
    expect(installMonths(next.pages)).toEqual(["2026-10-01"]);
    expect(status(next.pages, "2026-03-01")).toEqual([]);

    // An older reader's finished cursor, or its unfinished checkpoint, catches up.
    expect(
      installMonths(
        (await incremental(`google-play-done:1:${lastSync}`)).pages,
      ),
    ).toContain("2026-03-01");
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    const first = await connector.sync(
      context,
      {
        mode: "incremental",
        from: lastSync,
        to: new Date(TEST_NOW).toISOString(),
        resources: [ALPHA],
        cursor: upgraded.cursor!,
      },
      fake.runtime,
    );
    const checkpoint = JSON.parse(
      Buffer.from(
        first.nextCursor!.slice("google-play-data:".length),
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(checkpoint.reader).toBe(REPORT_READER);
    delete checkpoint.reader;
    const readerOne =
      "google-play-data:" +
      Buffer.from(JSON.stringify(checkpoint)).toString("base64url");
    expect(installMonths((await incremental(readerOne)).pages)).toContain(
      "2026-03-01",
    );
  });
});
