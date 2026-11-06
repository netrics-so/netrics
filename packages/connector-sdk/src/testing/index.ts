import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type {
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
} from "../connector.js";
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
import { observationKey } from "../transport.js";
import { assertManifestCompatible } from "../version.js";

export interface ContractTestOptions {
  /** Display name used in the describe block. Defaults to the manifest id. */
  name?: string;
  /** Overrides for the connection context sent to every connector call. */
  context?: Partial<ConnectionContext>;
  /**
   * Runtime for every call. Defaults to offlineRuntime; connectors that talk
   * to a provider pass a fixture-backed runtime (still no network).
   */
  runtime?: ConnectorRuntime;
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

/**
 * Runtime for offline contract tests: any network access fails the test.
 * Connectors under contract test must work from fixtures alone.
 */
export const offlineRuntime: ConnectorRuntime = {
  fetch: async (url) => {
    throw new Error(`contract tests run offline; connector fetched ${url}`);
  },
  signal: new AbortController().signal,
};

/**
 * A buffered ConnectorResponse for fixture-backed runtimes, shaped like the
 * host's: text() decodes the body as UTF-8, json() parses it, and bytes()
 * returns a copy of the exact body bytes.
 */
export function fixtureResponse(
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : new Uint8Array(body);
  const text = new TextDecoder().decode(bytes);
  return {
    status,
    headers: { ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new Uint8Array(bytes),
  };
}

/**
 * A fixture response whose body is a gzip file of `content` (a report as a
 * provider such as App Store Connect serves it, `application/a-gzip`). The
 * connector reads it with bytes() and inflates it itself, with a bound.
 */
export function gzipFixtureResponse(
  status: number,
  content: string | Uint8Array,
  headers: Record<string, string> = {},
): ConnectorResponse {
  return fixtureResponse(status, gzipSync(content), {
    "content-type": "application/a-gzip",
    ...headers,
  });
}

function indexByIdentity(observations: Observation[]) {
  return new Map(
    observations.map((observation) => [
      observationKey(observation),
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
  const runtime = options.runtime ?? offlineRuntime;
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
      const result = await connector.check(context, runtime);
      expect(checkResultSchema.safeParse(result).success).toBe(true);
    });

    it("discover returns valid resources with unique ids", async () => {
      const resources = await connector.discover(context, runtime);
      for (const resource of resources) {
        expect(resourceSchema.safeParse(resource).success).toBe(true);
      }
      const ids = resources.map((resource) => resource.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("sync returns observations consistent with the manifest", async () => {
      const result = syncResultSchema.parse(
        await connector.sync(
          context,
          makeRequest("backfill", fromMs, toMs),
          runtime,
        ),
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
        const key = observationKey(observation);
        expect(
          identities.has(key),
          `duplicate observation ${key} in one result`,
        ).toBe(false);
        identities.add(key);
      }
    });

    it("sync is deterministic across identical calls", async () => {
      const request = makeRequest("backfill", fromMs, toMs);
      const first = await connector.sync(context, request, runtime);
      const second = await connector.sync(context, request, runtime);
      expect(second).toEqual(first);
    });

    it("keeps identity and value stable across overlapping windows", async () => {
      const full = await connector.sync(
        context,
        makeRequest("backfill", fromMs, toMs),
        runtime,
      );
      const tail = await connector.sync(
        context,
        makeRequest("backfill", midMs, toMs),
        runtime,
      );
      const byIdentity = indexByIdentity(full.observations);
      expect(tail.observations.length).toBeGreaterThan(0);
      for (const observation of tail.observations) {
        const earlier = byIdentity.get(observationKey(observation));
        expect(
          earlier,
          `overlapping window changed identity ${observationKey(observation)}`,
        ).toBeDefined();
        expect(observation.value).toBe(earlier?.value);
        expect(observation.sourceTimestamp).toBe(earlier?.sourceTimestamp);
        expect(observation.dimensions).toEqual(earlier?.dimensions);
      }
    });

    it("advances the cursor and terminates with done", async () => {
      let cursor: string | undefined;
      let result = syncResultSchema.parse(
        await connector.sync(
          context,
          makeRequest("backfill", fromMs, toMs),
          runtime,
        ),
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
            runtime,
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
        runtime,
      );
      const incremental = await connector.sync(
        context,
        makeRequest("incremental", midMs, toMs),
        runtime,
      );
      const byIdentity = indexByIdentity(backfill.observations);
      expect(incremental.observations.length).toBeGreaterThan(0);
      for (const observation of incremental.observations) {
        const earlier = byIdentity.get(observationKey(observation));
        expect(earlier).toBeDefined();
        expect(observation.value).toBe(earlier?.value);
      }
    });
  });
}
