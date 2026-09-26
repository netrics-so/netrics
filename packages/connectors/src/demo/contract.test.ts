import { runConnectorContractTests } from "@netrics/connector-sdk/testing";
import type { ConnectionContext, SyncRequest } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { createDemoConnector, demoManifest } from "./index.js";

runConnectorContractTests(createDemoConnector());

const baseContext: ConnectionContext = {
  connectionId: "demo-test",
  config: {},
  credentials: {},
};

function window(from: string, to: string): SyncRequest {
  return { mode: "backfill", from, to };
}

describe("demo connector", () => {
  it("is stable across fresh instances (simulated processes)", async () => {
    const request = window(
      "2024-01-01T00:00:00.000Z",
      "2024-01-11T00:00:00.000Z",
    );
    const first = await createDemoConnector().sync(baseContext, request);
    const second = await createDemoConnector().sync(baseContext, request);
    expect(second).toEqual(first);
    expect(first.observations.length).toBeGreaterThan(0);
  });

  it("emits one observation per metric, resource, and day at UTC day boundaries", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      config: { seed: 7, resources: 2 },
    };
    const result = await createDemoConnector().sync(
      context,
      window("2024-03-01T00:00:00.000Z", "2024-03-04T00:00:00.000Z"),
    );
    expect(result.observations).toHaveLength(3 * 2 * 2);
    for (const observation of result.observations) {
      expect(observation.sourceTimestamp.endsWith("T00:00:00.000Z")).toBe(true);
      expect(observation.sourceIdentity).toBe(
        `${observation.metricKey}:${observation.dimensions.resource}:${observation.sourceTimestamp.slice(0, 10)}`,
      );
    }
    expect(result.nextCursor).toBe("2024-03-03T00:00:00.000Z");
    expect(result.done).toBe(true);
  });

  it("changes the series with the seed but stays deterministic per seed", async () => {
    const request = window(
      "2024-01-01T00:00:00.000Z",
      "2024-01-03T00:00:00.000Z",
    );
    const seedA: ConnectionContext = { ...baseContext, config: { seed: 1 } };
    const seedB: ConnectionContext = { ...baseContext, config: { seed: 2 } };
    const a1 = await createDemoConnector().sync(seedA, request);
    const a2 = await createDemoConnector().sync(seedA, request);
    const b = await createDemoConnector().sync(seedB, request);
    expect(a2).toEqual(a1);
    expect(b.observations.map((o) => o.value)).not.toEqual(
      a1.observations.map((o) => o.value),
    );
  });

  it("honours the resources subset in the sync request", async () => {
    const result = await createDemoConnector().sync(baseContext, {
      ...window("2024-01-01T00:00:00.000Z", "2024-01-03T00:00:00.000Z"),
      resources: ["demo-site-2"],
    });
    expect(
      new Set(result.observations.map((o) => o.dimensions.resource)),
    ).toEqual(new Set(["demo-site-2"]));
  });

  it("fails check with an actionable message on simulated bad credentials", async () => {
    const result = await createDemoConnector().check({
      ...baseContext,
      config: { simulate: "bad-credentials" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credentials/i);
  });

  it("throws a distinguishable error on simulated outage", async () => {
    const connector = createDemoConnector();
    const context: ConnectionContext = {
      ...baseContext,
      config: { simulate: "outage" },
    };
    await expect(connector.discover(context)).rejects.toThrow(/outage/);
    await expect(connector.check(context)).resolves.toEqual({ ok: true });
  });

  it("exposes a manifest wired to the demo metrics", () => {
    expect(demoManifest.id).toBe("demo");
    expect(demoManifest.outboundDomains).toEqual([]);
    expect(demoManifest.metrics.map((metric) => metric.key)).toEqual([
      "demo.visitors",
      "demo.signups",
    ]);
  });
});
