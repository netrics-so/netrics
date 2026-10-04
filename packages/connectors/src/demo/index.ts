import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  Observation,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

const DEFAULT_SEED = 1;
const DEFAULT_RESOURCE_COUNT = 3;
const MAX_RESOURCE_COUNT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The earliest civil time zone, UTC+14 (Pacific/Kiritimati). A reporting date
 * has begun somewhere on Earth once `to` is at most this far before its UTC
 * midnight (#148).
 */
const EARLIEST_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; product names and stored values stay as they are.
 */
const demoDe: ManifestTranslation = {
  name: "Demo-Connector",
  description:
    "Deterministischer Demo-Connector für das Onboarding und für Tests. Erzeugt plausible Tageswerte lokal, ohne Netzwerkzugriff.",
  resourceNoun: { singular: "Website", plural: "Websites" },
  metrics: {
    "demo.visitors": {
      name: "Besucher",
      description: "Eindeutige Besucher pro Tag und Demo-Website.",
    },
    "demo.signups": {
      name: "Registrierungen",
      description: "Neue Registrierungen pro Tag und Demo-Website.",
    },
  },
  dimensions: { resource: "Website" },
};

export const demoManifest: ConnectorManifest = {
  id: "demo",
  version: "0.1.1",
  sdkVersion: "^0.2.6",
  name: "Demo Connector",
  description:
    "Deterministic demo connector for onboarding and tests. Generates plausible daily metrics locally without network access.",
  authStrategies: [{ strategy: "none" }],
  configSchema: {
    type: "object",
    properties: {
      seed: { type: "integer", default: DEFAULT_SEED },
      resources: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESOURCE_COUNT,
        default: DEFAULT_RESOURCE_COUNT,
      },
      simulate: { type: "string", enum: ["outage", "bad-credentials"] },
    },
    additionalProperties: false,
  },
  metrics: [
    {
      key: "demo.visitors",
      name: "Visitors",
      description: "Daily unique visitors per demo site.",
      kind: "gauge",
      unit: "visitors",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max", "last"],
    },
    {
      key: "demo.signups",
      name: "Signups",
      description: "New signups per day per demo site.",
      kind: "delta",
      unit: "signups",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum"],
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: 90,
  outboundDomains: [],
  resourceNoun: { singular: "site", plural: "sites" },
  translations: { de: demoDe },
};

type Simulation = "outage" | "bad-credentials";

interface DemoConfig {
  seed: number;
  resourceCount: number;
  simulate?: Simulation;
}

function resolveConfig(config: Record<string, unknown>): DemoConfig {
  const seed =
    typeof config.seed === "number" && Number.isInteger(config.seed)
      ? config.seed
      : DEFAULT_SEED;
  const resourceCount =
    typeof config.resources === "number" && Number.isInteger(config.resources)
      ? Math.min(Math.max(config.resources, 1), MAX_RESOURCE_COUNT)
      : DEFAULT_RESOURCE_COUNT;
  const simulate =
    config.simulate === "outage" || config.simulate === "bad-credentials"
      ? config.simulate
      : undefined;
  return { seed, resourceCount, ...(simulate ? { simulate } : {}) };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function resourceIds(config: DemoConfig): string[] {
  return Array.from(
    { length: config.resourceCount },
    (_, index) => `demo-site-${index + 1}`,
  );
}

function dayStartUtc(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Reporting dates (as their UTC midnight) from the day containing `fromMs`
 * up to the latest date that has begun anywhere at `toMs`. Daily values stay
 * keyed to their reporting date (ADR 0008); going up to UTC+14 means the
 * workspace-local "today" has data in every time zone at any hour (#148).
 */
function* daysInWindow(fromMs: number, toMs: number): Generator<number> {
  const end = toMs + EARLIEST_ZONE_OFFSET_MS;
  for (let day = dayStartUtc(fromMs); day <= end; day += DAY_MS) {
    yield day;
  }
}

function isoOf(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function metricValue(
  config: DemoConfig,
  metricKey: string,
  resourceId: string,
  dayMs: number,
): number {
  const noise = mulberry32(
    fnv1a(`${config.seed}:${resourceId}:${metricKey}:${isoOf(dayMs)}`),
  )();
  const weekday = new Date(dayMs).getUTCDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.7 : 1;
  if (metricKey === "demo.visitors") {
    return Math.round((500 + noise * 1000) * weekendFactor);
  }
  return Math.round((10 + noise * 40) * weekendFactor);
}

/**
 * Deterministic demo connector. Every value derives only from
 * (seed, resource, metric, day), so results are stable across processes and
 * overlapping syncs are idempotent by construction.
 */
export function createDemoConnector(): Connector {
  return {
    manifest: demoManifest,

    async check(context: ConnectionContext): Promise<CheckResult> {
      const config = resolveConfig(context.config);
      if (config.simulate === "bad-credentials") {
        return {
          ok: false,
          message:
            "Demo connector credentials rejected (simulate=bad-credentials). Remove the simulate flag or fix the connection configuration.",
        };
      }
      return { ok: true };
    },

    async discover(context: ConnectionContext): Promise<Resource[]> {
      const config = resolveConfig(context.config);
      // Convention: a thrown error marks a retryable provider failure, while
      // check's `ok: false` marks a terminal condition needing user action.
      if (config.simulate === "outage") {
        throw new Error(
          "Demo connector simulated provider outage (simulate=outage)",
        );
      }
      return resourceIds(config).map((id, index) => ({
        id,
        name: `Demo Site ${index + 1}`,
        kind: "site",
      }));
    },

    async sync(
      context: ConnectionContext,
      request: SyncRequest,
    ): Promise<SyncResult> {
      const config = resolveConfig(context.config);
      if (config.simulate === "outage") {
        throw new Error(
          "Demo connector simulated provider outage (simulate=outage)",
        );
      }
      const selected = resourceIds(config).filter(
        (id) => !request.resources || request.resources.includes(id),
      );
      const fromMs = Date.parse(request.from);
      const toMs = Date.parse(request.to);
      const observations: Observation[] = [];
      for (const day of daysInWindow(fromMs, toMs)) {
        const dayIso = isoOf(day);
        for (const resourceId of selected) {
          for (const metric of demoManifest.metrics) {
            observations.push({
              metricKey: metric.key,
              sourceTimestamp: dayIso,
              value: metricValue(config, metric.key, resourceId, day),
              dimensions: { resource: resourceId },
            });
          }
        }
      }
      // The cursor never passes the UTC day containing `to`: the next
      // incremental window starts there and re-emits the dates ahead of UTC
      // (identical values, so the upsert writes nothing).
      const last = observations[observations.length - 1];
      const cursorMs = last
        ? Math.min(Date.parse(last.sourceTimestamp), dayStartUtc(toMs))
        : undefined;
      return {
        observations,
        ...(cursorMs !== undefined ? { nextCursor: isoOf(cursorMs) } : {}),
        done: true,
      };
    },
  };
}
