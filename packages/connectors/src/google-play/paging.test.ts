import { describe, expect, it, vi } from "vitest";
import type {
  ConnectionContext,
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import { accessibleApps, createPlayReportsClient } from "./api.js";
import { createGooglePlayConnector } from "./index.js";
import {
  ALPHA,
  BETA,
  fakePlay,
  jsonResponse,
  TEST_BUCKET,
  TEST_NOW,
} from "./test-helpers.js";

const context: ConnectionContext = {
  connectionId: "play-paging",
  credentials: { accessToken: "synthetic-access-token" },
  config: { reportBucket: TEST_BUCKET },
};
const request: SyncRequest = {
  mode: "backfill",
  from: "2026-10-01T00:00:00.000Z",
  to: new Date(TEST_NOW).toISOString(),
  resources: [ALPHA],
};
function installFile(count: number, correction = false): Uint8Array {
  const rows = Array.from(
    { length: count },
    (_, index) =>
      `2026-10-01,${ALPHA},US,${correction && index === 0 ? "2" : "1"},1,${index}`,
  );
  return new Uint8Array(
    Buffer.from(
      "\uFEFFDate,Package Name,Country,Daily User Installs,Daily Device Installs,Future metric\r\n" +
        rows.join("\r\n") +
        "\r\n",
      "utf16le",
    ),
  );
}
async function firstRaw(
  fake: ReturnType<typeof fakePlay>,
  connector = createGooglePlayConnector({ now: () => TEST_NOW }),
) {
  let cursor: string | undefined;
  for (let i = 0; i < 30; i++) {
    const page = await connector.sync(
      context,
      { ...request, cursor },
      fake.runtime,
    );
    if (
      page.datasetPages?.some(
        (dataset) => dataset.datasetKey === "install_rows",
      )
    )
      return { page, connector };
    if (page.done) throw new Error("No raw page in fixture");
    cursor = page.nextCursor;
  }
  throw new Error("Fixture did not reach raw rows");
}

describe("Google Play checkpoint consistency", () => {
  it("restarts a changed pending object, pins the reporting window and never puts provider records in checkpoints", async () => {
    const fake = fakePlay(),
      name = `stats/installs/installs_${ALPHA}_202610_country.csv`;
    fake.put(name, installFile(1001), "1");
    const { page: first, connector } = await firstRaw(fake);
    expect(first.datasetPages?.[0]).toMatchObject({
      records: expect.any(Array),
      complete: false,
      pageKey: "0",
      previousPageKey: null,
    });
    expect(first.datasetPages?.[0]?.records).toHaveLength(1000);
    const state = JSON.parse(
      Buffer.from(first.nextCursor!.split(":")[1]!, "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(state.offset).toBe(1000);
    expect(state.to).toBe(request.to);
    expect(JSON.stringify(state)).not.toContain("provider_fields");
    fake.put(name, installFile(1001, true), "2");
    const reset = await connector.sync(
      context,
      { ...request, cursor: first.nextCursor, to: "2027-01-01T00:00:00.000Z" },
      fake.runtime,
    );
    expect(reset.datasetPages?.[0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: false,
      window: {
        from: "2026-10-01",
        toExclusive: "2026-11-01",
        partition: { app_id: ALPHA },
      },
    });
    expect(reset.datasetPages?.[0]?.refreshKey).not.toBe(
      first.datasetPages?.[0]?.refreshKey,
    );
    const complete = await connector.sync(
      context,
      { ...request, cursor: reset.nextCursor },
      fake.runtime,
    );
    expect(complete.datasetPages?.[0]).toMatchObject({
      pageKey: "1000",
      previousPageKey: "0",
      complete: true,
      refreshKey: reset.datasetPages?.[0]?.refreshKey,
    });
    expect(complete.datasetPages?.[0]?.records).toHaveLength(1);
    expect(complete.datasetPages?.[1]?.datasetKey).toBe("report_status");
    expect(
      fake.calls
        .filter(
          (call) =>
            call.url.searchParams.get("alt") === "media" &&
            call.url.pathname.includes(encodeURIComponent(name)),
        )
        .map((call) => call.url.searchParams.get("generation")),
    ).toEqual(["1", "2", "2"]);
  });
  it("does not publish a partial replacement when a report becomes unreadable or forbidden", async () => {
    const fake = fakePlay(),
      name = `stats/installs/installs_${ALPHA}_202610_country.csv`;
    fake.put(name, installFile(1001), "1");
    const { page, connector } = await firstRaw(fake);
    fake.privateStatus.set(name, 403);
    const next = await connector.sync(
      context,
      { ...request, cursor: page.nextCursor },
      fake.runtime,
    );
    expect(next.datasetPages?.map((dataset) => dataset.datasetKey)).toEqual([
      "report_status",
    ]);
    expect(next.datasetPages?.[0]?.records[0]?.values.availability).toBe(
      "permission_missing",
    );
  });
  it("propagates transient download failures for the durable worker retry policy", async () => {
    const fake = fakePlay(),
      name = `stats/installs/installs_${ALPHA}_202610_country.csv`;
    fake.privateStatus.set(name, 503);
    const connector = createGooglePlayConnector({ now: () => TEST_NOW });
    let cursor: string | undefined;
    let failure: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        const result: SyncResult = await connector.sync(
          context,
          { ...request, cursor },
          fake.runtime,
        );
        cursor = result.nextCursor;
        if (result.done) break;
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(String(failure)).toContain("temporarily unavailable");
    expect(String(failure)).not.toContain("private provider diagnostic");
  });
});

describe("provider pagination and identity", () => {
  it("discovers more than 50 named app pages without a fixed account ceiling", async () => {
    const fake = fakePlay({ pageSize: 1 });
    for (let i = 0; i < 51; i++)
      fake.apps.set(`com.example.extra${i}`, `Extra ${i}`);
    const apps = await accessibleApps(context, fake.runtime);
    expect(apps).toHaveLength(53);
    expect(
      apps.some((app) => app.id === ALPHA && app.name === "Alpha Notes"),
    ).toBe(true);
    expect(
      apps.some((app) => app.id === BETA && app.name === "Beta Tracker"),
    ).toBe(true);
  });
  it("rejects repeated app/object pagination tokens instead of looping", async () => {
    const fetch = vi
      .fn<ConnectorRuntime["fetch"]>()
      .mockResolvedValue(
        jsonResponse(200, { apps: [], items: [], nextPageToken: "same-page" }),
      );
    const runtime: ConnectorRuntime = {
      signal: new AbortController().signal,
      fetch,
    };
    await expect(accessibleApps(context, runtime)).rejects.toThrow(
      "repeated a page",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    await expect(
      createPlayReportsClient(context, runtime).list("earnings/"),
    ).rejects.toThrow("repeated a page");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
