import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  findConnectionMetric,
  listWorkspaceMetrics,
  queryMetricBuckets,
  queryMetricCurrencyTotals,
  type MetricBucketQuery,
  type MetricCurrencyQuery,
} from "./metrics.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

async function observe(
  workspaceId: string,
  connectionId: string,
  metricKey: string,
  at: string,
  value: number,
  dimensions: Record<string, string> = {},
) {
  await admin`
    insert into observations (workspace_id, connection_id, metric_definition_id,
      dimensions, source_timestamp, value)
    select ${workspaceId}, ${connectionId}, m.id, ${admin.json(dimensions)},
           ${at}::timestamptz, ${value}
    from metric_definitions m where m.connector_id = 'demo' and m.key = ${metricKey}`;
}

function query(workspaceId: string, overrides: Partial<MetricBucketQuery>) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    queryMetricBuckets(tx, {
      workspaceId,
      connectionId: connectionA,
      metricKey: "visits",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-08T00:00:00Z"),
      unit: "day",
      timeZone: "UTC",
      combination: "sum",
      ...overrides,
    }),
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });

  await admin`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  await admin`
    insert into metric_definitions (connector_id, key, name, description, kind,
      unit, granularity, dimensions, aggregations)
    values
      ('demo', 'visits', 'Visits', 'Visits per day', 'delta', 'count', 'day',
       '["country"]', '["sum","avg","min","max"]'),
      ('demo', 'active', 'Active users', 'Active right now', 'gauge', 'count',
       'instant', '["country"]', '["last","avg","min","max"]'),
      ('demo', 'proceeds', 'Proceeds', 'Proceeds per currency', 'delta',
       'currency_minor', 'day', '["app","currency"]', '["sum"]')`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
  const [ca] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceA}, 'demo', 'Demo A') returning id`;
  const [cb] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceB}, 'demo', 'Demo B') returning id`;
  connectionA = ca!.id as string;
  connectionB = cb!.id as string;

  // Daily deltas (reporting dates), two countries.
  await observe(workspaceA, connectionA, "visits", "2026-09-01T00:00:00Z", 10, {
    country: "de",
  });
  await observe(workspaceA, connectionA, "visits", "2026-09-01T00:00:00Z", 5, {
    country: "fr",
  });
  await observe(workspaceA, connectionA, "visits", "2026-09-02T00:00:00Z", 7, {
    country: "de",
  });
  // Workspace B's data must never appear in A's results.
  await observe(workspaceB, connectionB, "visits", "2026-09-01T00:00:00Z", 999);

  // Gauge readings: several per hour and series.
  for (const [at, value, country] of [
    ["2026-09-01T10:05:00Z", 3, "de"],
    ["2026-09-01T10:50:00Z", 4, "de"],
    ["2026-09-01T10:20:00Z", 2, "fr"],
    ["2026-09-01T11:10:00Z", 6, "de"],
  ] as const) {
    await observe(workspaceA, connectionA, "active", at, value, { country });
  }

  // Proceeds in minor units per app and currency (ADR 0014).
  for (const [at, value, app, currency] of [
    ["2026-09-01T00:00:00Z", 1_000, "a", "EUR"],
    ["2026-09-01T00:00:00Z", 2_000, "b", "EUR"],
    ["2026-09-02T00:00:00Z", 500, "a", "EUR"],
    ["2026-09-01T00:00:00Z", 4_000, "a", "USD"],
    ["2026-09-01T00:00:00Z", 90_000, "a", "JPY"],
    // Before the window: listed, with a total of 0.
    ["2026-08-01T00:00:00Z", 7_000, "a", "CHF"],
  ] as const) {
    await observe(workspaceA, connectionA, "proceeds", at, value, {
      app,
      currency,
    });
  }
  await observe(
    workspaceB,
    connectionB,
    "proceeds",
    "2026-09-01T00:00:00Z",
    1,
    {
      app: "a",
      currency: "GBP",
    },
  );
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("queryMetricBuckets", () => {
  it("adds up deltas per bucket across series", async () => {
    expect(await query(workspaceA, {})).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", value: 15 },
      { bucket: "2026-09-02T00:00:00.000Z", value: 7 },
    ]);
  });

  it("filters by dimension", async () => {
    expect(await query(workspaceA, { dimensions: { country: "fr" } })).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", value: 5 },
    ]);
  });

  it("adds each series' latest reading for gauges", async () => {
    const buckets = await query(workspaceA, {
      metricKey: "active",
      unit: "hour",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-02T00:00:00Z"),
      combination: "sum_of_last",
    });
    // 10:00 → de's last 4 + fr's 2; 11:00 → de's 6.
    expect(buckets).toEqual([
      { bucket: "2026-09-01T10:00:00.000Z", value: 6 },
      { bucket: "2026-09-01T11:00:00.000Z", value: 6 },
    ]);
  });

  it("starts buckets in the workspace's time zone", async () => {
    const buckets = await query(workspaceA, {
      metricKey: "active",
      unit: "hour",
      timeZone: "Asia/Kolkata",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-02T00:00:00Z"),
      combination: "sum_of_last",
    });
    // Kolkata hours start at :30 UTC: 10:05 and 10:20 fall in 09:30–10:30,
    // 10:50 and 11:10 in 10:30–11:30.
    expect(buckets.map((bucket) => bucket.bucket)).toEqual([
      "2026-09-01T09:30:00.000Z",
      "2026-09-01T10:30:00.000Z",
    ]);
  });

  it("buckets local days across a DST change", async () => {
    const days = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx.execute<{ day: Date }>(
        // The same expression queryMetricBuckets uses.
        // 2026-10-25 is 25 hours long in Berlin.
        sql`
          select date_trunc('day', t, 'Europe/Berlin') as day
          from (values ('2026-10-24T23:30:00Z'::timestamptz),
                       ('2026-10-25T22:30:00Z'::timestamptz)) v(t)`,
      ),
    );
    expect(days.map((row) => new Date(row.day).toISOString())).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-24T22:00:00.000Z",
    ]);
  });

  it("never returns another workspace's data", async () => {
    // A's connection id with B's workspace: nothing.
    expect(await query(workspaceB, { connectionId: connectionA })).toEqual([]);
    // B's own data under B.
    expect(await query(workspaceB, { connectionId: connectionB })).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", value: 999 },
    ]);
    // B's connection named under A's context: RLS and the explicit
    // workspace predicate both exclude it.
    expect(await query(workspaceA, { connectionId: connectionB })).toEqual([]);
  });

  it.each([
    [{ to: new Date("2026-09-01T00:00:00Z") }, /positive/],
    [
      {
        from: new Date("2025-08-28T00:00:00Z"),
        to: new Date("2026-09-01T00:00:00Z"),
      },
      /at most 368 days/,
    ],
    [{ unit: "hour" as const }, /two days/],
    [
      {
        dimensions: Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]),
        ),
      },
      /10 dimension filters/,
    ],
  ])("rejects an unbounded request %#", async (overrides, message) => {
    await expect(query(workspaceA, overrides)).rejects.toThrow(message);
  });
});

describe("metric lookup", () => {
  it("lists the workspace's metrics per connection", async () => {
    const metrics = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      listWorkspaceMetrics(tx, workspaceA),
    );
    expect(metrics.map((m) => [m.connectionId, m.key])).toEqual([
      [connectionA, "active"],
      [connectionA, "proceeds"],
      [connectionA, "visits"],
    ]);
    expect(metrics[2]).toMatchObject({
      kind: "delta",
      granularity: "day",
      aggregations: ["sum", "avg", "min", "max"],
    });
  });

  it("finds one metric only within the workspace", async () => {
    const found = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      findConnectionMetric(tx, workspaceA, connectionA, "visits"),
    );
    expect(found?.name).toBe("Visits");
    const foreign = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      findConnectionMetric(tx, workspaceA, connectionB, "visits"),
    );
    expect(foreign).toBeNull();
  });
});

function currencies(
  workspaceId: string,
  overrides: Partial<MetricCurrencyQuery> = {},
) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    queryMetricCurrencyTotals(tx, {
      workspaceId,
      connectionId: connectionA,
      metricKey: "proceeds",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-08T00:00:00Z"),
      combination: "sum",
      ...overrides,
    }),
  );
}

describe("currency_minor amounts", () => {
  it("are stored and summed per currency, never across", async () => {
    expect(await currencies(workspaceA)).toEqual([
      { currency: "JPY", total: 90_000 },
      { currency: "USD", total: 4_000 },
      { currency: "EUR", total: 3_500 },
      { currency: "CHF", total: 0 },
    ]);
  });

  it("bucket one currency when filtered to it", async () => {
    expect(
      await query(workspaceA, {
        metricKey: "proceeds",
        dimensions: { currency: "EUR" },
      }),
    ).toEqual([
      { bucket: "2026-09-01T00:00:00.000Z", value: 3_000 },
      { bucket: "2026-09-02T00:00:00.000Z", value: 500 },
    ]);
  });

  it("combine with other dimension filters", async () => {
    expect(await currencies(workspaceA, { dimensions: { app: "b" } })).toEqual([
      { currency: "EUR", total: 2_000 },
    ]);
  });

  it("never list another workspace's currencies", async () => {
    expect(await currencies(workspaceB, { connectionId: connectionA })).toEqual(
      [],
    );
    expect(await currencies(workspaceA, { connectionId: connectionB })).toEqual(
      [],
    );
    expect(await currencies(workspaceB, { connectionId: connectionB })).toEqual(
      [{ currency: "GBP", total: 1 }],
    );
  });

  it("rejects an unbounded window", async () => {
    await expect(
      currencies(workspaceA, { from: new Date("2025-09-01T00:00:00Z") }),
    ).rejects.toThrow(/at most 368 days/);
  });
});
