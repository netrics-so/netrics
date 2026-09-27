import { describe, expect, it } from "vitest";

import type { Connector } from "../connector.js";
import { connectorManifestSchema } from "../manifest.js";
import type {
  ConnectionContext,
  Observation,
  SyncMode,
  SyncRequest,
} from "../transport.js";
import {
  checkResultSchema,
  resourceSchema,
  syncResultSchema,
} from "../transport.js";
import { assertManifestCompatible } from "../version.js";

export interface ContractTestOptions {
  /** Display name used in the describe block. Defaults to the manifest id. */
  name?: string;
  /** Overrides for the connection context sent to every connector call. */
  context?: Partial<ConnectionContext>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_FROM = Date.UTC(2024, 0, 1);
const WINDOW_DAYS = 10;
const MAX_CURSOR_PAGES = 32;

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function makeRequest(
  mode: SyncMode,
  fromMs: number,
  toMs: number,
  cursor?: string,
): SyncRequest {
  return {
    mode,
    from: iso(fromMs),
    to: iso(toMs),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function indexByIdentity(observations: Observation[]) {
  return new Map(
    observations.map((observation) => [
      observation.sourceIdentity,
      observation,
    ]),
  );
}

/**
 * Registers a reusable vitest suite that asserts a connector honours the
 * transport contract. Runs entirely offline; any connector that needs network
 * access for these fixtures violates the contract.
 */
export function runConnectorContractTests(
  connector: Connector,
  options: ContractTestOptions = {},
): void {
  const context: ConnectionContext = {
    connectionId: "contract-test-connection",
    config: {},
    credentials: {},
    ...options.context,
  };
  const fromMs = WINDOW_FROM;
  const toMs = WINDOW_FROM + WINDOW_DAYS * DAY_MS;
  const midMs = WINDOW_FROM + (WINDOW_DAYS / 2) * DAY_MS;

  describe(`connector contract: ${options.name ?? connector.manifest.id}`, () => {
    it("declares a schema-valid, SDK-compatible manifest", () => {
      expect(
        connectorManifestSchema.safeParse(connector.manifest).success,
      ).toBe(true);
      expect(() => assertManifestCompatible(connector.manifest)).not.toThrow();
    });

    it("check returns a valid CheckResult", async () => {
      const result = await connector.check(context);
      expect(checkResultSchema.safeParse(result).success).toBe(true);
    });

    it("discover returns valid resources with unique ids", async () => {
      const resources = await connector.discover(context);
      for (const resource of resources) {
        expect(resourceSchema.safeParse(resource).success).toBe(true);
      }
      const ids = resources.map((resource) => resource.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("sync returns observations consistent with the manifest", async () => {
      const result = syncResultSchema.parse(
        await connector.sync(context, makeRequest("backfill", fromMs, toMs)),
      );
      expect(result.observations.length).toBeGreaterThan(0);
      const metricsByKey = new Map(
        connector.manifest.metrics.map((metric) => [metric.key, metric]),
      );
      const identities = new Set<string>();
      for (const observation of result.observations) {
        const metric = metricsByKey.get(observation.metricKey);
        expect(
          metric,
          `observation references undeclared metric "${observation.metricKey}"`,
        ).toBeDefined();
        for (const dimension of Object.keys(observation.dimensions)) {
          expect(metric?.dimensions).toContain(dimension);
        }
        expect(
          identities.has(observation.sourceIdentity),
          `duplicate sourceIdentity "${observation.sourceIdentity}" in one result`,
        ).toBe(false);
        identities.add(observation.sourceIdentity);
      }
    });

    it("sync is deterministic across identical calls", async () => {
      const request = makeRequest("backfill", fromMs, toMs);
      const first = await connector.sync(context, request);
      const second = await connector.sync(context, request);
      expect(second).toEqual(first);
    });

    it("keeps identity and value stable across overlapping windows", async () => {
      const full = await connector.sync(
        context,
        makeRequest("backfill", fromMs, toMs),
      );
      const tail = await connector.sync(
        context,
        makeRequest("backfill", midMs, toMs),
      );
      const byIdentity = indexByIdentity(full.observations);
      expect(tail.observations.length).toBeGreaterThan(0);
      for (const observation of tail.observations) {
        const earlier = byIdentity.get(observation.sourceIdentity);
        expect(
          earlier,
          `overlapping window changed identity "${observation.sourceIdentity}"`,
        ).toBeDefined();
        expect(observation.value).toBe(earlier?.value);
        expect(observation.sourceTimestamp).toBe(earlier?.sourceTimestamp);
        expect(observation.dimensions).toEqual(earlier?.dimensions);
      }
    });

    it("advances the cursor and terminates with done", async () => {
      let cursor: string | undefined;
      let result = syncResultSchema.parse(
        await connector.sync(context, makeRequest("backfill", fromMs, toMs)),
      );
      let pages = 1;
      while (!result.done) {
        expect(
          result.nextCursor,
          "a non-final page must carry nextCursor",
        ).toBeDefined();
        expect(
          (result.nextCursor as string) > (cursor ?? ""),
          "nextCursor must advance between pages",
        ).toBe(true);
        cursor = result.nextCursor;
        result = syncResultSchema.parse(
          await connector.sync(
            context,
            makeRequest("backfill", fromMs, toMs, cursor),
          ),
        );
        pages += 1;
        expect(pages).toBeLessThanOrEqual(MAX_CURSOR_PAGES);
      }
      expect(result.done).toBe(true);
      if (result.observations.length > 0) {
        expect(result.nextCursor).toBeDefined();
      }
    });

    it("produces consistent overlap between backfill and incremental sync", async () => {
      const backfill = await connector.sync(
        context,
        makeRequest("backfill", fromMs, toMs),
      );
      const incremental = await connector.sync(
        context,
        makeRequest("incremental", midMs, toMs),
      );
      const byIdentity = indexByIdentity(backfill.observations);
      expect(incremental.observations.length).toBeGreaterThan(0);
      for (const observation of incremental.observations) {
        const earlier = byIdentity.get(observation.sourceIdentity);
        expect(earlier).toBeDefined();
        expect(observation.value).toBe(earlier?.value);
      }
    });
  });
}
