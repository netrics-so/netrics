import { arch, cpus, platform, release, totalmem } from "node:os";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import type { ConnectorRuntime, SyncRequest } from "@netrics/connector-sdk";
import { createGooglePlayConnector } from "@netrics/connectors";
import { createTestDatabase } from "../test-db.js";
import { createDatasetStaging } from "./staging.js";
import {
  ALPHA,
  fakePlay,
  TEST_BUCKET,
  TEST_NOW,
  zipArchive,
} from "../../../../packages/connectors/src/google-play/test-helpers.js";

// Google Play first-read memory (#501). The connector parses a report
// incrementally, but collects the typed rows of one report task before it
// sorts and stages them (datasetStaging.put takes a complete page set). This
// measures that buffer on synthetic earnings archives through the real host
// staging adapter. One size per process, so peak RSS belongs to that size:
// scripts/scale/run.mjs runs each size and scope in a fresh process.
const inflatedMiB = Number(process.env.NETRICS_SCALE_PLAY_MIB ?? 0);
const scope = process.env.NETRICS_SCALE_PLAY_SCOPE ?? "all";
const enabled = inflatedMiB > 0;
const MIB = 1024 * 1024;
const APPS = 100;

// The columns of a Play Console earnings report.
const HEADER = [
  "Description",
  "Transaction Date",
  "Transaction Time",
  "Tax Type",
  "Transaction Type",
  "Refund Type",
  "Product Title",
  "Package ID",
  "Product Type",
  "Sku Id",
  "Hardware",
  "Buyer Country",
  "Buyer State",
  "Buyer Postal Code",
  "Buyer Currency",
  "Amount (Buyer Currency)",
  "Currency Conversion Rate",
  "Merchant Currency",
  "Amount (Merchant Currency)",
  "Base Plan ID",
  "Offer ID",
  "Group ID",
  "First USD 1M Eligible",
  "Service Model",
  "Fee Description",
  "Promotion ID",
].join(",");
const COUNTRIES = ["US", "DE", "GB", "FR", "JP", "BR", "IN", "CA"];
/** Every tenth line belongs to ALPHA, the app a selected sync asks for. */
function line(i: number): string {
  const app = i % 10 === 0 ? ALPHA : "com.example.app" + (i % APPS);
  const day = 1 + (i % 28);
  const type = i % 3 === 2 ? "Google fee" : "Charge";
  const amount = ((i % 997) / 100 + 0.99).toFixed(2);
  return [
    "GPA.3381-" +
      String(i)
        .padStart(4 * 4, "0")
        .replace(/(\d{4})(?=\d)/g, "$1-"),
    `"Oct ${String(day).padStart(2, "0")}, 2026"`,
    `${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00 PDT`,
    "",
    type,
    "",
    "Synthetic Pro Monthly",
    app,
    "subscription",
    "pro_monthly",
    "",
    COUNTRIES[i % COUNTRIES.length],
    "",
    "",
    "EUR",
    type === "Charge" ? amount : "-" + (Number(amount) * 0.15).toFixed(2),
    "1.000000",
    "EUR",
    type === "Charge" ? amount : "-" + (Number(amount) * 0.15).toFixed(2),
    "monthly",
    i % 5 === 0 ? "intro" : "",
    "",
    "true",
    "Subscription",
    type === "Charge" ? "" : "APPS_GAMES_PROGRAM",
    "",
  ].join(",");
}
function earningsArchive(bytes: number) {
  const parts: string[] = [HEADER];
  let size = HEADER.length + 2,
    lines = 0;
  while (size < bytes) {
    const next = line(lines++);
    parts.push(next);
    size += next.length + 2;
  }
  const csv = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  return {
    lines,
    csvBytes: csv.byteLength,
    archive: zipArchive([{ name: "earnings.csv", bytes: csv }]),
  };
}

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
let db: Database, owner: Sql;
let workspaceId: string, connectionId: string;
const result: Record<string, unknown> = {};

beforeAll(async () => {
  if (!enabled) return;
  const test = await createTestDatabase();
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const [w] =
    await owner`insert into workspaces(name) values ('Play memory') returning id`;
  workspaceId = w!.id as string;
  const [c] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'google-play','Play') returning id`;
  connectionId = c!.id as string;
  db = createDatabase(test.appUrl, { max: 2 });
}, 120_000);
afterAll(async () => {
  if (!enabled) return;
  const [server] =
    await owner`select current_setting('server_version') as version`;
  console.log(
    "NETRICS_SCALE_PLAY_RESULT " +
      JSON.stringify({
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          memoryGiB: Math.round(totalmem() / 1073741824),
          postgres: server!.version,
        },
        ...result,
      }),
  );
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

describe.runIf(enabled)("Google Play first-read memory (#501)", () => {
  it("measures peak memory of one buffered report task before staging", async () => {
    const fake = fakePlay({ maxResponseBytes: 10 * MIB });
    const report = earningsArchive(inflatedMiB * MIB);
    fake.objects.delete("earnings/earnings_202610_adjustment.zip");
    fake.put("earnings/earnings_202610.zip", report.archive, "7");
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    const runtime: ConnectorRuntime = {
      ...fake.runtime,
      datasetStaging: createDatasetStaging({
        db,
        manifest: connector.manifest,
        clock: () => new Date(TEST_NOW),
        signal: new AbortController().signal,
        workspaceId,
        connectionId,
      }),
    };
    const request: SyncRequest = {
      mode: "backfill",
      from: "2026-10-01T00:00:00.000Z",
      to: new Date(TEST_NOW).toISOString(),
      ...(scope === "selected" ? { resources: [ALPHA] } : {}),
    };
    const context = {
      connectionId,
      credentials: { accessToken: "synthetic-access-token" },
      config: { reportBucket: TEST_BUCKET },
    };
    gc();
    const baseline = process.memoryUsage();
    const maxRssBefore = process.resourceUsage().maxRSS * 1024;
    const turns: Array<Record<string, number | boolean>> = [];
    let cursor: string | undefined,
      earningsTurns = 0;
    for (let turn = 0; turn < 40 && earningsTurns < 4; turn++) {
      gc();
      const before = process.memoryUsage();
      const media = fake.mediaBytes.length;
      let peakRss = before.rss,
        peakHeap = before.heapUsed + before.arrayBuffers;
      const sampler = setInterval(() => {
        const now = process.memoryUsage();
        peakRss = Math.max(peakRss, now.rss);
        peakHeap = Math.max(peakHeap, now.heapUsed + now.arrayBuffers);
      }, 5);
      const start = performance.now();
      const page = await connector.sync(
        context,
        { ...request, cursor },
        runtime,
      );
      const elapsed = performance.now() - start;
      clearInterval(sampler);
      const after = process.memoryUsage();
      peakRss = Math.max(peakRss, after.rss);
      peakHeap = Math.max(peakHeap, after.heapUsed + after.arrayBuffers);
      const earnings = (page.datasetPages ?? []).filter(
        (p) => p.datasetKey === "earning_rows",
      );
      if (earnings.length) earningsTurns++;
      if (earnings.length || turns.length === 0)
        turns.push({
          turn,
          earningsPage: earnings.length > 0,
          ms: Math.round(elapsed),
          records: earnings.reduce((n, p) => n + p.records.length, 0),
          staged: earnings.some((p) => p.stagingId !== undefined),
          mediaDownloads: fake.mediaBytes.length - media,
          mediaMiB:
            Math.round(
              (fake.mediaBytes.slice(media).reduce((a, b) => a + b, 0) / MIB) *
                10,
            ) / 10,
          peakRssMiB: Math.round(peakRss / MIB),
          peakHeapAndBuffersMiB: Math.round(peakHeap / MIB),
          rssAboveBaselineMiB: Math.round((peakRss - baseline.rss) / MIB),
          heapAboveBaselineMiB: Math.round(
            (peakHeap - baseline.heapUsed - baseline.arrayBuffers) / MIB,
          ),
        });
      if (page.done) break;
      cursor = page.nextCursor;
    }
    expect(earningsTurns).toBeGreaterThan(0);
    const [stages] =
      await owner`select count(distinct s.id)::int as stages, coalesce(sum(octet_length(p.payload::text)), 0)::bigint as staged_bytes, count(p.*)::int as staged_pages from data_connector_stages s left join data_connector_stage_pages p on p.stage_id = s.id where s.workspace_id = ${workspaceId}`;
    Object.assign(result, {
      scope,
      apps: scope === "selected" ? 1 : APPS + 2,
      report: {
        inflatedCsvMiB: Math.round((report.csvBytes / MIB) * 10) / 10,
        archiveMiB: Math.round((report.archive.byteLength / MIB) * 10) / 10,
        lines: report.lines,
        selectedLines:
          scope === "selected" ? Math.ceil(report.lines / 10) : report.lines,
      },
      baseline: {
        rssMiB: Math.round(baseline.rss / MIB),
        heapAndBuffersMiB: Math.round(
          (baseline.heapUsed + baseline.arrayBuffers) / MIB,
        ),
      },
      processMaxRssMiB: {
        before: Math.round(maxRssBefore / MIB),
        after: Math.round((process.resourceUsage().maxRSS * 1024) / MIB),
      },
      stage: {
        stages: stages!.stages,
        pages: stages!.staged_pages,
        jsonMiB: Math.round((Number(stages!.staged_bytes) / MIB) * 10) / 10,
      },
      turns,
    });
  }, 1_800_000);
});
