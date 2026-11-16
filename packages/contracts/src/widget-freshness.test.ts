import { describe, expect, it } from "vitest";

import {
  compareMeasureReadingSchema,
  dashboardWidgetDataSchema,
  deviceStatusDataSchema,
  deviceStatusStreamSchema,
  goalReadResponseSchema,
  metricBreakdownResponseSchema,
  metricQueryResponseSchema,
  deviceMetricDataSchema,
  deviceReviewDataSchema,
  latestReviewResponseSchema,
  deviceTileSchema,
  widgetFreshnessSchema,
} from "./index.js";

// Freshness in widget data (ADR 0025 section 7, #704): an optional object
// on every data widget's data, absent on schema 1 tiles.

const metricData = {
  period: "last_7_days",
  aggregation: "sum",
  value: 12,
  unit: "count",
  conversion: null,
  change: { previousValue: null, delta: null, ratio: null },
  spark: [1, 2],
  kind: "delta",
  granularity: "day",
  better: "higher",
  status: "ok",
  updatedAt: "2026-11-16T11:55:00.000Z",
} as const;

const periodic = {
  kind: "periodic",
  stream: "Sales",
  fetchedAt: "2026-11-16T11:55:00.000Z",
  dataThrough: "2026-11-14",
  nextExpectedAt: "2026-11-16T20:00:00.000Z",
  late: true,
  nextCheckAt: "2026-11-16T14:00:00.000Z",
} as const;

describe("widget freshness", () => {
  it("is optional on device data: payloads without it parse as before", () => {
    const parsed = deviceMetricDataSchema.parse(metricData);
    expect(parsed).not.toHaveProperty("freshness");
    expect(
      deviceMetricDataSchema.parse({ ...metricData, freshness: periodic })
        .freshness,
    ).toEqual(periodic);
  });

  it("is on measure widgets' data", () => {
    const data = {
      widgetId: "11111111-1111-4111-8111-111111111111",
      metadata: null,
      result: null,
      error: null,
      exclusions: [],
    };
    expect(dashboardWidgetDataSchema.parse(data)).not.toHaveProperty(
      "freshness",
    );
    expect(
      dashboardWidgetDataSchema.parse({
        ...data,
        freshness: {
          kind: "continuous",
          stream: "Reviews",
          fetchedAt: periodic.fetchedAt,
        },
      }).freshness,
    ).toEqual({
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: periodic.fetchedAt,
    });
  });

  it("is on latest-review data, screens' and the Studio's", () => {
    const checked = {
      kind: "continuous",
      stream: "Reviews",
      fetchedAt: periodic.fetchedAt,
    } as const;
    const data = { status: "ok", updatedAt: null, review: null } as const;
    expect(deviceReviewDataSchema.parse(data)).not.toHaveProperty("freshness");
    expect(
      deviceReviewDataSchema.parse({ ...data, freshness: checked }).freshness,
    ).toEqual(checked);
    expect(
      latestReviewResponseSchema.parse({ ...data, freshness: checked })
        .freshness,
    ).toEqual(checked);
  });

  it("never reaches schema 1 tiles", () => {
    expect(deviceTileSchema.shape).not.toHaveProperty("freshness");
  });

  it("takes a day, `month` as the only period and `late` only as true", () => {
    const ok = (value: object) =>
      widgetFreshnessSchema.safeParse({ ...periodic, ...value }).success;
    expect(ok({ period: "month", dataThrough: "2026-10-31" })).toBe(true);
    expect(ok({ period: "day" })).toBe(false);
    expect(ok({ late: false })).toBe(false);
    expect(ok({ dataThrough: "2026-11-14T00:00:00Z" })).toBe(false);
    expect(ok({ nextExpectedAt: "21:00" })).toBe(false);
    expect(ok({ kind: "weekly" })).toBe(false);
  });
});

// Signed-in live queries and the status board (#727): additive optional
// fields only.
describe("live query and status board freshness", () => {
  it("is optional on metric queries, breakdowns and goal reads", () => {
    for (const schema of [
      metricQueryResponseSchema,
      metricBreakdownResponseSchema,
      goalReadResponseSchema,
    ]) {
      expect(schema.shape.freshness.safeParse(undefined).success).toBe(true);
      expect(schema.shape.status.safeParse(undefined).success).toBe(true);
      expect(schema.shape.freshness.parse(periodic)).toEqual(periodic);
      // Only the overdue rule's "stale" is sent; never "ok".
      expect(schema.shape.status.safeParse("stale").success).toBe(true);
      expect(schema.shape.status.safeParse("ok").success).toBe(false);
    }
    expect(
      compareMeasureReadingSchema.shape.freshness.safeParse(undefined).success,
    ).toBe(true);
  });

  it("lists a source's streams on the status board", () => {
    const item = {
      connectionId: "11111111-1111-4111-8111-111111111111",
      name: "Apps",
      status: "ok",
      lastSuccessAt: null,
    } as const;
    const data = { status: "ok", items: [item] } as const;
    expect(deviceStatusDataSchema.parse(data).items[0]).not.toHaveProperty(
      "streams",
    );
    const stream = { key: "sales", ...periodic, overdue: true } as const;
    expect(
      deviceStatusDataSchema.parse({
        ...data,
        items: [{ ...item, streams: [stream] }],
      }).items[0]!.streams,
    ).toEqual([stream]);
    // Without next times (credentials failed): still a stream.
    const { nextExpectedAt: _n, nextCheckAt: _c, ...skipped } = stream;
    expect(deviceStatusStreamSchema.safeParse(skipped).success).toBe(true);
    expect(deviceStatusStreamSchema.safeParse(periodic).success).toBe(false);
    expect(
      deviceStatusStreamSchema.safeParse({ ...stream, overdue: false }).success,
    ).toBe(false);
  });
});
