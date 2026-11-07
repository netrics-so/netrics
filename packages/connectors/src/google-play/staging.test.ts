import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  DATASET_LIMITS,
  syncResultSchema,
  type ConnectionContext,
  type ConnectorDatasetStaging,
  type DatasetPage,
  type DatasetRecord,
  type DatasetStageWriter,
  type SyncRequest,
} from "@netrics/connector-sdk";

import { earningsDataset } from "./datasets.js";
import { createGooglePlayConnector } from "./index.js";
import {
  PENDING_STAGE_BYTES,
  StageBuilder,
  UNSTAGED_TURN_PAGES,
} from "./partitions.js";
import { rowsDigest } from "./sync.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  TEST_BUCKET,
  TEST_NOW,
  zipArchive,
} from "./test-helpers.js";

// Streaming Google Play staging (#519): rows go to the stage while the report
// is read, in parse order per app, with bounded memory; without a stage a
// turn carries several pages instead of reading the report for every page.

const MIB = 1024 * 1024;
const context: ConnectionContext = {
  connectionId: "play-streaming",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: TEST_BUCKET },
};
const request: SyncRequest = {
  mode: "backfill",
  from: "2026-10-01T00:00:00.000Z",
  to: new Date(TEST_NOW).toISOString(),
  resources: [ALPHA, BETA],
};
const HEADER =
  "Description,Transaction Date,Transaction Type,Package ID,Buyer Country,Merchant Currency,Amount (Merchant Currency),Product Title";
function line(i: number, app: string): string {
  return `GPA.${String(i).padStart(8, "0")},"Oct ${String(1 + (i % 28)).padStart(2, "0")}, 2026",Charge,${app},US,USD,${((i % 997) / 100).toFixed(2)},Synthetic subscription ${"x".repeat(i % 40)}`;
}
/**
 * An earnings archive above the fetch limit: every 12th line belongs to ALPHA
 * or BETA (in alternation), the rest to apps a selected sync drops.
 */
function largeArchive(lines: number, store = true) {
  const rows: string[] = [];
  const selected: Record<string, string[]> = { [ALPHA]: [], [BETA]: [] };
  for (let i = 0; i < lines; i++) {
    const app =
      i % 12 === 0
        ? i % 24 === 0
          ? ALPHA
          : BETA
        : `com.example.other${i % 7}`;
    rows.push(line(i, app));
    if (app in selected)
      selected[app]!.push(`GPA.${String(i).padStart(8, "0")}`);
  }
  const csv = Buffer.from(HEADER + "\r\n" + rows.join("\r\n") + "\r\n", "utf8");
  return {
    archive: zipArchive([{ name: "earnings.csv", bytes: csv, store }]),
    selected,
  };
}

/** Host staging in memory, with the SDK 0.2.11 writer. */
function memoryStaging(options: { refuseAppend?: number } = {}) {
  const stages = new Map<
    string,
    {
      id: string;
      key: string;
      metadata: unknown;
      pages: Map<string, DatasetPage>;
    }
  >();
  const events: string[] = [];
  const writers = { begun: 0, appends: 0, commits: 0, aborts: 0 };
  const store: ConnectorDatasetStaging = {
    get: async (key) => {
      const stage = stages.get(key);
      return stage
        ? { id: stage.id, key: stage.key, metadata: stage.metadata }
        : null;
    },
    getPage: async (id, pageKey) => {
      for (const stage of stages.values())
        if (stage.id === id) {
          const page = stage.pages.get(pageKey);
          if (page) return structuredClone(page);
        }
      throw new Error("dataset_stage_reference_invalid");
    },
    put: async () => {
      throw new Error("Not used: the connector stages through begin");
    },
    begin: async ({ key, datasetKey }) => {
      // Counted for the earnings report only; install reports stage too.
      const counted = datasetKey === "earning_rows";
      if (counted) writers.begun++;
      const pages = new Map<string, DatasetPage>();
      const writer: DatasetStageWriter = {
        append: async (batch) => {
          if (counted) writers.appends++;
          if (
            counted &&
            options.refuseAppend !== undefined &&
            writers.appends > options.refuseAppend
          )
            throw new Error("dataset_stage_quota");
          if (counted) events.push("append");
          for (const page of batch) {
            if (pages.has(page.pageKey))
              throw new Error("dataset_stage_invalid");
            pages.set(page.pageKey, structuredClone(page));
          }
        },
        commit: async ({ metadata }) => {
          if (counted) writers.commits++;
          const stage = { id: randomUUID(), key, metadata, pages };
          stages.set(key, stage);
          return { id: stage.id, key, metadata };
        },
        abort: async () => {
          if (counted) writers.aborts++;
        },
      };
      return writer;
    },
  };
  return { store, stages, events, writers };
}

async function syncAll(
  fake: ReturnType<typeof fakePlay>,
  onTurn?: (pages: DatasetPage[]) => void,
) {
  const connector = createGooglePlayConnector({ now: () => TEST_NOW });
  const pages: DatasetPage[] = [];
  let cursor: string | undefined;
  for (let turn = 0; turn < 500; turn++) {
    const result = syncResultSchema.parse(
      await connector.sync(context, { ...request, cursor }, fake.runtime),
    );
    onTurn?.(result.datasetPages ?? []);
    pages.push(...(result.datasetPages ?? []));
    if (result.done) return pages;
    cursor = result.nextCursor;
  }
  throw new Error("Sync did not finish");
}
const earningRows = (pages: DatasetPage[], app: string) =>
  pages
    .filter(
      (page) =>
        page.datasetKey === "earning_rows" &&
        page.window?.partition.app_id === app,
    )
    .flatMap((page) => page.records);
function earningsFake(archive: Uint8Array) {
  const fake = fakePlay({ maxResponseBytes: 10 * MIB });
  fake.objects.delete("earnings/earnings_202610_adjustment.zip");
  fake.put("earnings/earnings_202610.zip", archive, "9");
  return fake;
}
const earningsMedia = (fake: ReturnType<typeof fakePlay>) =>
  fake.calls.filter(
    (call) =>
      call.url.searchParams.get("alt") === "media" &&
      call.url.pathname.includes("earnings_202610.zip"),
  ).length;

describe("streaming Google Play staging (#519)", () => {
  it("writes rows to the stage while the report is still being read, in parse order", async () => {
    const { archive, selected } = largeArchive(170_000);
    expect(archive.byteLength).toBeGreaterThan(8 * MIB);
    const fake = earningsFake(archive);
    const staging = memoryStaging();
    fake.runtime.datasetStaging = staging.store;
    const fetch = fake.runtime.fetch;
    fake.runtime.fetch = vi.fn(async (url, init) => {
      if (url.includes("alt=media") && url.includes("earnings_202610"))
        staging.events.push("read");
      return fetch(url, init);
    });
    const staged = await syncAll(fake);
    // Pages reached the host before the last range of the report was read.
    expect(staging.events.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(staging.events.indexOf("append")).toBeLessThan(
      staging.events.lastIndexOf("read"),
    );
    expect(staging.writers).toMatchObject({ commits: 1, aborts: 0 });
    // One read of the report; every later page came from the stage.
    expect(earningsMedia(fake)).toBe(
      staging.events.filter((event) => event === "read").length,
    );
    expect(
      staged
        .filter((page) => page.datasetKey === "earning_rows")
        .every((page) => page.stagingId),
    ).toBe(true);
    // Rows keep the report's order within each app: no global sort.
    for (const app of [ALPHA, BETA])
      expect(
        earningRows(staged, app).map(
          (row) =>
            (row.values.provider_fields as Record<string, string>).Description,
        ),
      ).toEqual(selected[app]);

    // Without staging, the same rows arrive in the same pages' order, and a
    // turn carries up to UNSTAGED_TURN_PAGES pages of its app.
    const unstagedFake = earningsFake(archive);
    let most = 0;
    const unstaged = await syncAll(unstagedFake, (pages) => {
      most = Math.max(
        most,
        pages.filter((page) => page.datasetKey === "earning_rows").length,
      );
    });
    for (const app of [ALPHA, BETA])
      expect(earningRows(unstaged, app)).toEqual(earningRows(staged, app));
    expect(most).toBe(UNSTAGED_TURN_PAGES);
    const pagesOf = (pages: DatasetPage[]) =>
      pages.filter((page) => page.datasetKey === "earning_rows").length;
    // Each unstaged turn reads the report once: far fewer reads than pages.
    expect(earningsMedia(unstagedFake)).toBeLessThan(
      (pagesOf(unstaged) / UNSTAGED_TURN_PAGES + 2) *
        Math.ceil(archive.byteLength / (8 * MIB)),
    );
  }, 120_000);

  it("stages identical pages from the same report", async () => {
    const { archive } = largeArchive(30_000, false);
    const first = memoryStaging(),
      second = memoryStaging();
    for (const staging of [first, second]) {
      const fake = earningsFake(archive);
      fake.runtime.datasetStaging = staging.store;
      await syncAll(fake);
    }
    const pages = (staging: ReturnType<typeof memoryStaging>) =>
      [...staging.stages.values()].map((stage) => ({
        key: stage.key,
        metadata: stage.metadata,
        pages: [...stage.pages.values()],
      }));
    expect(pages(first)).toEqual(pages(second));
    expect(pages(first).length).toBeGreaterThan(0);
  }, 60_000);

  it("reads the report again for several pages per turn when an append is refused", async () => {
    const { archive, selected } = largeArchive(170_000);
    const fake = earningsFake(archive);
    const staging = memoryStaging({ refuseAppend: 1 });
    fake.runtime.datasetStaging = staging.store;
    const pages = await syncAll(fake);
    expect(staging.writers).toMatchObject({ commits: 0, aborts: 1 });
    for (const app of [ALPHA, BETA])
      expect(
        earningRows(pages, app).map(
          (row) =>
            (row.values.provider_fields as Record<string, string>).Description,
        ),
      ).toEqual(selected[app]);
    expect(
      pages
        .filter((page) => page.datasetKey === "earning_rows")
        .some((page) => page.stagingId),
    ).toBe(false);
  }, 120_000);

  it("aborts the draft and stages nothing when the archive fails its checks after rows were written", async () => {
    const { archive } = largeArchive(60_000, false);
    // Corrupt the member CRC in the central directory: every row is read
    // (and partly staged) before the check at the end of the member fails.
    const damaged = Buffer.from(archive);
    const directory = damaged.lastIndexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    damaged.writeUInt32LE(
      (damaged.readUInt32LE(directory + 16) ^ 1) >>> 0,
      directory + 16,
    );
    const local = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    damaged.writeUInt32LE(
      (damaged.readUInt32LE(local + 14) ^ 1) >>> 0,
      local + 14,
    );
    const fake = earningsFake(new Uint8Array(damaged));
    const staging = memoryStaging();
    fake.runtime.datasetStaging = staging.store;
    const pages = await syncAll(fake);
    expect(staging.writers.appends).toBeGreaterThan(0);
    expect(staging.writers).toMatchObject({ commits: 0, aborts: 1 });
    expect(
      [...staging.stages.values()].filter(
        (stage) => [...stage.pages.values()][0]?.datasetKey === "earning_rows",
      ),
    ).toHaveLength(0);
    expect(pages.some((page) => page.datasetKey === "earning_rows")).toBe(
      false,
    );
    expect(
      pages
        .filter((page) => page.datasetKey === "report_status")
        .map((page) => page.records[0]!.values)
        .filter(
          (row) =>
            row.report_type === "earnings" && row.report_month === "2026-10-01",
        ),
    ).toMatchObject([
      { app_id: ALPHA, availability: "invalid_report" },
      { app_id: BETA, availability: "invalid_report" },
    ]);
  }, 60_000);
});

describe("stage page building", () => {
  it("holds a bounded number of pending rows however many apps a report has", async () => {
    const appended: DatasetPage[] = [];
    const writer: DatasetStageWriter = {
      append: async (pages) => {
        appended.push(...pages);
      },
      commit: async () => {
        throw new Error("not used");
      },
      abort: async () => {},
    };
    const builder = new StageBuilder(writer, earningsDataset, {
      from: "2026-10-01",
      toExclusive: "2026-11-01",
    });
    const apps = Array.from({ length: 2000 }, (_, i) => `com.example.a${i}`);
    const rows = new Map<string, DatasetRecord[]>(apps.map((app) => [app, []]));
    let most = 0;
    for (let i = 0; i < 40_000; i++) {
      const app = apps[(i * 7919) % apps.length]!;
      const row: DatasetRecord = {
        values: { app_id: app, n: i, text: "y".repeat(200 + (i % 300)) },
      };
      rows.get(app)!.push(row);
      builder.add(app, row);
      most = Math.max(most, builder.pendingBytes);
      if (i % 500 === 0) await builder.drain();
    }
    expect(most).toBeLessThanOrEqual(PENDING_STAGE_BYTES);
    const parts = await builder.finish([...apps].sort(), []);
    const byKey = new Map(appended.map((page) => [page.pageKey, page]));
    expect(byKey.size).toBe(appended.length);
    for (const part of parts) {
      const pages = part.pages.map((page) => byKey.get(page.key)!);
      // Every row once, in the order it was read, at consecutive offsets.
      expect(pages.flatMap((page) => page.records)).toEqual(rows.get(part.app));
      expect(part.totalRows).toBe(rows.get(part.app)!.length);
      expect(part.digest).toBe(rowsDigest(rows.get(part.app)!, []));
      let offset = 0;
      part.pages.forEach((entry, index) => {
        expect(entry.offset).toBe(offset);
        offset += entry.count;
        const page = pages[index]!;
        expect(page.window?.partition.app_id).toBe(part.app);
        // Only the final page of an app is complete.
        expect(page.complete).toBe(index === part.pages.length - 1);
        expect(page.records.length).toBeLessThanOrEqual(
          DATASET_LIMITS.pageRows,
        );
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          DATASET_LIMITS.pageBytes,
        );
      });
    }
  });
});
