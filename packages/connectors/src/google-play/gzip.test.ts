import { describe, expect, it } from "vitest";
import {
  syncResultSchema,
  type ConnectionContext,
  type DatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";

import { createPlayReportsClient, REPORT_RANGE_BYTES } from "./api.js";
import { createGooglePlayConnector } from "./index.js";
import { ReportTooLargeError } from "./tabular.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  fixtureBytes,
  TEST_BUCKET,
  TEST_NOW,
} from "./test-helpers.js";

// Play Console stores report objects with Content-Encoding: gzip. Cloud
// Storage then serves them whole (Range ignored), and runtime.fetch hands the
// body over decompressed, so it never matches the listed (compressed) size.

const context: ConnectionContext = {
  connectionId: "play-gzip",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: `gs://${TEST_BUCKET}/stats/installs/` },
};
const request: SyncRequest = {
  mode: "backfill",
  from: "2026-10-01T00:00:00.000Z",
  to: new Date(TEST_NOW).toISOString(),
  resources: [ALPHA, BETA],
};
const FETCH_LIMIT = 10 * 1024 * 1024;
const INSTALLS = [ALPHA, BETA].map(
  (app) => `stats/installs/installs_${app}_202610_country.csv`,
);

/** The fake with every install report stored gzip-encoded. */
function gzipPlay(options: Parameters<typeof fakePlay>[0] = {}) {
  const fake = fakePlay(options);
  fake.putGzip(INSTALLS[0]!, fixtureBytes("installs-alpha.csv"));
  fake.putGzip(INSTALLS[1]!, fixtureBytes("installs-beta.csv"));
  return fake;
}
async function syncAll(fake: ReturnType<typeof fakePlay>) {
  const connector = createGooglePlayConnector({ now: () => TEST_NOW });
  const pages: DatasetPage[] = [];
  let cursor: string | undefined;
  for (let turn = 0; turn < 100; turn++) {
    const result = syncResultSchema.parse(
      await connector.sync(context, { ...request, cursor }, fake.runtime),
    );
    pages.push(...(result.datasetPages ?? []));
    if (result.done) return pages;
    cursor = result.nextCursor;
  }
  throw new Error("Sync did not finish");
}
const rows = (pages: DatasetPage[], key: string) =>
  pages
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records.map((row) => row.values));
const media = (fake: ReturnType<typeof fakePlay>) =>
  fake.calls.filter((call) => call.url.searchParams.get("alt") === "media");

describe("gzip-encoded report objects", () => {
  it("lists, samples and validates the content encoding and reads the decompressed body whole", async () => {
    const fake = gzipPlay();
    const object = fake.objects.get(INSTALLS[0]!)!;
    const raw = fixtureBytes("installs-alpha.csv");
    expect(Number(object.size)).not.toBe(raw.byteLength);
    const client = createPlayReportsClient(context, fake.runtime);
    const sampled = await client.sample("stats/installs/");
    expect(sampled).toMatchObject({
      name: INSTALLS[0],
      contentEncoding: "gzip",
      size: object.size,
    });
    const listed = await client.list("stats/installs/");
    expect(listed.map((item) => item.contentEncoding)).toEqual([
      "gzip",
      "gzip",
    ]);
    await expect(client.validate(listed[0]!)).resolves.toBeUndefined();
    expect(Buffer.from(await client.bytes(listed[0]!)).equals(raw)).toBe(true);
    const source = await client.source(listed[0]!);
    expect(source.size).toBe(raw.byteLength);
    expect(
      Buffer.from(await source.read(3, 10)).equals(raw.subarray(3, 13)),
    ).toBe(true);
    await expect(source.read(raw.byteLength, 1)).rejects.toThrow(
      "outside the object",
    );
    // One whole, generation-pinned read per call; never a byte range.
    expect(media(fake)).toHaveLength(2);
    expect(
      media(fake).every(
        (call) =>
          call.init?.headers?.range === undefined &&
          call.url.searchParams.get("generation") === object.generation,
      ),
    ).toBe(true);
  });

  it("keeps the generation pin and the stored length check", async () => {
    const fake = gzipPlay();
    const object = (
      await createPlayReportsClient(context, fake.runtime).list(
        "stats/installs/",
      )
    )[0]!;
    for (const [header, value] of [
      ["x-goog-generation", "2"],
      ["x-goog-stored-content-length", String(Number(object.size) + 1)],
    ] as const) {
      const altered = createPlayReportsClient(context, {
        ...fake.runtime,
        fetch: async (url, init) => {
          const response = await fake.fetch(url, init);
          return {
            ...response,
            headers: { ...response.headers, [header]: value },
          };
        },
      });
      await expect(altered.source(object)).rejects.toThrow("while it was read");
    }
    // Served as stored (identity) despite the listing: the length must match.
    const identity = createPlayReportsClient(context, {
      ...fake.runtime,
      fetch: async (url, init) => {
        const response = await fake.fetch(url, init);
        return {
          ...response,
          headers: {
            ...response.headers,
            "x-goog-stored-content-encoding": "identity",
          },
        };
      },
    });
    await expect(identity.bytes(object)).rejects.toThrow("size changed");
  });

  it("refuses a report whose decompressed body exceeds the fetch limit with a clear error", async () => {
    const fake = fakePlay({ maxResponseBytes: FETCH_LIMIT });
    const body = new TextEncoder().encode(
      "Date,Package Name\n" + "2026-10-01,x\n".repeat(FETCH_LIMIT / 13 + 1),
    );
    fake.putGzip(INSTALLS[0]!, body);
    const object = fake.objects.get(INSTALLS[0]!)!;
    expect(Number(object.size)).toBeLessThan(REPORT_RANGE_BYTES);
    const client = createPlayReportsClient(context, fake.runtime);
    const listed = (await client.list("stats/installs/"))[0]!;
    const refused = client.source(listed);
    await expect(refused).rejects.toBeInstanceOf(ReportTooLargeError);
    await expect(client.source(listed)).rejects.toThrow("once decompressed");
    const pages = await syncAll(fake);
    expect(
      rows(pages, "report_status").find(
        (row) =>
          row.report_type === "installs" &&
          row.app_id === ALPHA &&
          row.report_month === "2026-10-01",
      ),
    ).toMatchObject({ availability: "invalid_report" });
  });

  it("checks access and syncs install rows identical to identity-encoded reports", async () => {
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    const gzip = gzipPlay();
    expect(await connector.check(context, gzip.runtime)).toEqual({ ok: true });
    const plain = await syncAll(fakePlay());
    const compressed = await syncAll(gzipPlay());
    const installs = rows(plain, "install_rows");
    expect(installs.length).toBeGreaterThan(0);
    expect(rows(compressed, "install_rows")).toEqual(installs);
    expect(
      rows(compressed, "report_status").filter(
        (row) => row.report_type === "installs",
      ),
    ).toEqual(
      rows(plain, "report_status").filter(
        (row) => row.report_type === "installs",
      ),
    );
  });
});
