import { executeSync } from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { createPostHogConnector } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

// Whole PostHog syncs through the host's own result validation
// (executeSync → validateSyncResult, ADR 0026 §7), which the connectors
// package cannot import (the lesson of #881). The connector talks to a
// small offline stand-in for PostHog's API.

const NOW = "2024-01-10T12:00:00.000Z";
const KEY = "phx_posthog_server_test_key";
const ORG = "0190b4c2-7d1e-7000-8000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

function answer(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

function days(from: string, to: string): string[] {
  const list: string[] = [];
  for (
    let ms = Date.parse(`${from}T00:00:00Z`);
    ms <= Date.parse(`${to}T00:00:00Z`);
    ms += DAY_MS
  ) {
    list.push(new Date(ms).toISOString().slice(0, 10));
  }
  return list;
}

/** PostHog with `projects` projects and one saved insight of `rows` rows. */
function fakePostHog(projects: number, insightRows: number): ConnectorRuntime {
  const page = (results: unknown[]) => ({
    count: results.length,
    next: null,
    results,
  });
  const insightDays = days("2014-01-01", "2024-01-10").slice(-insightRows);
  return {
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === "/api/organizations/") {
        return answer(200, page([{ id: ORG, name: "Acme" }]));
      }
      if (pathname === `/api/organizations/${ORG}/projects/`) {
        const offset = Number(searchParams.get("offset") ?? 0);
        const all = Array.from({ length: projects }, (_, index) => ({
          id: 1000 + index,
          name: `Project ${index}`,
        }));
        const results = all.slice(offset, offset + 100);
        return answer(200, {
          count: all.length,
          next:
            offset + 100 < all.length
              ? `https://us.posthog.com${pathname}?limit=100&offset=${offset + 100}`
              : null,
          results,
        });
      }
      if (/^\/api\/projects\/\d+\/query\/$/.test(pathname)) {
        const query = (
          JSON.parse(init!.body!) as { query: Record<string, unknown> }
        ).query;
        if (query.kind === "TrendsQuery") {
          const range = query.dateRange as {
            date_from: string;
            date_to: string;
          };
          const span = days(range.date_from, range.date_to);
          return answer(200, {
            results: (query.series as unknown[]).map((_, order) => ({
              action: { order },
              data: span.map(() => 5),
              days: span,
            })),
          });
        }
        const [from, to] = [
          ...String(query.query).matchAll(/toDateTime\('(\d{4}-\d{2}-\d{2})/g),
        ].map((match) => match[1]!);
        return answer(200, {
          results: days(from!, to!).flatMap((day) =>
            Array.from({ length: 10 }, (_, rank) => [
              day,
              `event_${rank}`,
              10 - rank,
            ]),
          ),
          hasMore: false,
        });
      }
      if (/^\/api\/projects\/1000\/insights\/$/.test(pathname)) {
        return answer(
          200,
          page([
            {
              id: 1,
              short_id: searchParams.get("short_id"),
              name: "Daily signups",
              last_refresh: NOW,
              query: {
                kind: "InsightVizNode",
                source: { kind: "TrendsQuery", interval: "day" },
              },
              result: [
                {
                  action: { order: 0 },
                  label: "signed_up",
                  data: insightDays.map(() => 1),
                  days: insightDays,
                },
              ],
            },
          ]),
        );
      }
      return answer(404, { detail: "Not found." });
    },
  };
}

/** The connector, reading PostHog through the offline stand-in. */
function posthogWith(projects: number, insightRows = 7): Connector {
  const connector = createPostHogConnector({
    now: () => Date.parse(NOW),
    sleep: async () => {},
  });
  const runtime = fakePostHog(projects, insightRows);
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
): Promise<SyncResult[]> {
  const context: ConnectionContext = {
    connectionId: "posthog-host-test",
    config: { region: "us", insights: "1000/Signup1" },
    credentials: { apiKey: KEY },
  };
  const results: SyncResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const result = await executeSync(connector, context, {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    results.push(result);
    if (result.done) return results;
    cursor = result.nextCursor;
  }
  throw new Error("the sync did not finish");
}

const rows = (results: SyncResult[], key: string) =>
  results
    .flatMap((result) => result.datasetPages ?? [])
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records);

describe("PostHog syncs through the host's validation (#873)", () => {
  it("accepts a one-project incremental sync", async () => {
    const results = await syncThroughHost(posthogWith(1), {
      mode: "incremental",
      from: "2024-01-08T00:00:00.000Z",
      to: NOW,
    });
    const last = results.at(-1)!;
    expect(last.receivedDatasets).toEqual([
      "top_events",
      "insights",
      "insight_results",
    ]);
    expect(rows(results, "top_events")).toHaveLength(30);
    expect(rows(results, "insight_results")).toHaveLength(7);
    expect(rows(results, "insights")).toHaveLength(1);
    expect(last.freshness).toEqual([
      expect.objectContaining({ stream: "analytics", resource: "1000" }),
      { stream: "insights" },
    ]);
    expect(
      results.flatMap((result) => result.observations).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a backfill of many projects and an insight larger than a result", async () => {
    const results = await syncThroughHost(posthogWith(120, 3_650), {
      mode: "backfill",
      from: "2023-10-12T00:00:00.000Z",
      to: NOW,
    });
    expect(rows(results, "insight_results")).toHaveLength(3_650);
    expect(rows(results, "top_events")).toHaveLength(120 * 91 * 10);
    expect(results.at(-1)!.freshness).toHaveLength(121);
  });
});
