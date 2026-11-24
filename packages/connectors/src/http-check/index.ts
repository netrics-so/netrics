import type {
  CheckResult,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import {
  DEFAULT_EXPECTED_STATUS,
  HttpCheckConfigError,
  MAX_CHECKS,
  MAX_HEADERS,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_URL_LENGTH,
  readChecks,
} from "./checks.js";
import { HTTP_CHECK_DATASETS, checksDataset } from "./datasets.js";
import { CHECKS_STREAM, METRICS, syncPage } from "./sync.js";

export {
  DEFAULT_EXPECTED_STATUS,
  HEADERS_INVALID_CODE,
  HEADERS_INVALID_MESSAGE,
  HttpCheckConfigError,
  MAX_BODY_BYTES,
  MAX_CHECKS,
  MAX_TIMEOUT_SECONDS,
  NAME_DUPLICATE_CODE,
  NAME_DUPLICATE_MESSAGE,
  NO_CHECKS_CODE,
  NO_CHECKS_MESSAGE,
  STATUS_INVALID_CODE,
  STATUS_INVALID_MESSAGE,
  TEXT_INVALID_CODE,
  TEXT_INVALID_MESSAGE,
  URL_INVALID_CODE,
  URL_INVALID_MESSAGE,
  URL_SECRET_CODE,
  URL_SECRET_MESSAGE,
  checkId,
  readChecks,
  type HttpCheck,
} from "./checks.js";
export { checksDataset } from "./datasets.js";
export { DOWN_REASONS, USER_AGENT, type DownReason } from "./probe.js";
export {
  CHECKS_STREAM,
  CONCURRENCY,
  METRICS,
  MIN_ROUND_GAP_MS,
  RUN_MAX_AGE_MS,
} from "./sync.js";

export const HTTP_CHECK_CONNECTOR_ID = "http-check";

/**
 * How often a connection runs its checks, and the floor of any interval:
 * once a minute. A connection holds at most MAX_CHECKS checks, so it sends
 * at most 20 requests a minute.
 */
export const INTERVAL_SECONDS = 60;

// ─── Manifest ───────────────────────────────────────────────────────────────

/** German texts of the manifest (ADR 0016): "du" where it addresses the reader. */
const httpCheckDe: ManifestTranslation = {
  name: "HTTP-Checks",
  description:
    "Ruft deine URLs jede Minute auf und hält fest, ob sie erreichbar sind, mit Statuscode und Antwortzeit.",
  resourceNoun: { singular: "Check", plural: "Checks" },
  config: {
    checks: {
      title: "Checks",
      description: `Bis zu ${MAX_CHECKS} URLs, die netrics jede Minute einmal aufruft. Ein Check ist „up“, wenn der Status passt und (falls angegeben) der erwartete Text im Inhalt steht.`,
      items: {
        name: {
          title: "Name",
          description:
            "Benennt den Check auf Dashboards. Ein umbenannter Check ist ein neuer Check (seine Projektzuordnung beginnt neu).",
        },
        url: {
          title: "URL",
          description:
            "Eine https-URL, zum Beispiel https://example.com/health. Auf dem gehosteten Dienst nur öffentliche Adressen.",
        },
        method: {
          title: "Methode",
          description:
            "GET liest die Antwort, HEAD nur Status und Header (schneller, aber ohne erwarteten Text).",
        },
        expectedStatus: {
          title: "Erwarteter Status",
          description: `Ein Code (200), ein Bereich (200-299), eine Klasse (2xx) oder mehrere durch Kommas getrennt. Ohne Angabe ${DEFAULT_EXPECTED_STATUS}.`,
        },
        expectedText: {
          title: "Erwarteter Text",
          description: `Nur bei GET: Text, der im Inhalt stehen muss (höchstens ${MAX_TEXT_LENGTH} Zeichen). netrics liest dafür höchstens 1 MiB und speichert den Inhalt nie.`,
        },
        timeoutSeconds: {
          title: "Zeitlimit (Sekunden)",
          description: `Wie lange netrics auf die Antwort wartet, 1 bis ${MAX_TIMEOUT_SECONDS} Sekunden.`,
        },
        headers: {
          title: "Request-Header",
          description: `Optional, ein „Name: Wert“ pro Zeile, höchstens ${MAX_HEADERS}. Keine Geheimnisse: Authorization, Cookie und Namen mit key, token, secret oder auth werden abgelehnt, denn die Konfiguration wird nicht verschlüsselt.`,
        },
      },
    },
  },
  metrics: {
    [METRICS.up]: {
      name: "Erreichbar",
      description:
        "1, wenn der Check bei einem Aufruf up war, 0, wenn er down war; ein Wert pro Aufruf. Der Durchschnitt über einen Zeitraum ist die Verfügbarkeit (0,999 = 99,9 %).",
    },
    [METRICS.responseMs]: {
      name: "Antwortzeit",
      description:
        "Millisekunden bis zur Antwort (bei GET mit erwartetem Text bis zum gelesenen Inhalt), pro Aufruf mit Antwort.",
    },
  },
  dimensions: { resource: "Check" },
  freshnessStreams: { [CHECKS_STREAM]: "Checks" },
};

const checkItem = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Name",
      description:
        "Names the check on dashboards. A renamed check is a new check (its project link starts again).",
      minLength: 1,
      maxLength: MAX_NAME_LENGTH,
    },
    url: {
      type: "string",
      title: "URL",
      description:
        "An https URL, such as https://example.com/health. Public addresses only on the hosted service.",
      minLength: 1,
      maxLength: MAX_URL_LENGTH,
    },
    method: {
      type: "string",
      title: "Method",
      description:
        "GET reads the answer; HEAD only its status and headers (faster, but without expected text).",
      enum: ["GET", "HEAD"],
      default: "GET",
    },
    expectedStatus: {
      type: "string",
      title: "Expected status",
      description: `A code (200), a range (200-299), a class (2xx), or several separated by commas. ${DEFAULT_EXPECTED_STATUS} when empty.`,
      maxLength: 100,
    },
    expectedText: {
      type: "string",
      title: "Expected text",
      description: `GET only: text the body must contain (at most ${MAX_TEXT_LENGTH} characters). netrics reads at most 1 MiB for it and never stores the body.`,
      maxLength: MAX_TEXT_LENGTH,
    },
    timeoutSeconds: {
      type: "integer",
      title: "Time limit (seconds)",
      description: `How long netrics waits for the answer, 1 to ${MAX_TIMEOUT_SECONDS} seconds.`,
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
      default: MAX_TIMEOUT_SECONDS,
    },
    headers: {
      type: "string",
      title: "Request headers",
      description: `Optional, one “Name: value” per line, at most ${MAX_HEADERS}. No secrets: Authorization, Cookie and names with key, token, secret or auth are refused, because the configuration is not encrypted.`,
      format: "multiline",
      maxLength: 6000,
    },
  },
  required: ["name", "url"],
  additionalProperties: false,
};

const instantGauge = {
  kind: "gauge",
  granularity: "instant",
  dimensions: ["resource"],
  aggregations: ["avg", "min", "max", "last"],
} as const;

export const httpCheckManifest: ConnectorManifest = {
  id: HTTP_CHECK_CONNECTOR_ID,
  version: "0.1.0",
  sdkVersion: "^0.2.21",
  category: "web",
  brandColor: "#0f766e",
  name: "HTTP checks",
  description:
    "Requests your URLs every minute and records whether they are up, with status code and response time.",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/http-check.md",
  authStrategies: [{ strategy: "none" }],
  configSchema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        title: "Checks",
        description: `Up to ${MAX_CHECKS} URLs netrics requests once a minute. A check is up when the status matches and (if given) the expected text is in the body.`,
        minItems: 1,
        maxItems: MAX_CHECKS,
        items: checkItem,
      },
    },
    required: ["checks"],
    additionalProperties: false,
  },
  // The hosts of the checks' URLs, for this connection only (SDK 0.2.21);
  // their redirects stay on the same host.
  configuredHosts: ["checks[].url"],
  datasets: [...HTTP_CHECK_DATASETS],
  metrics: [
    {
      ...instantGauge,
      key: METRICS.up,
      name: "Up",
      description:
        "1 when the check was up at a run, 0 when it was down; one value per run. Its average over a period is the uptime (0.999 = 99.9 %).",
      unit: "ratio",
      dimensions: [...instantGauge.dimensions],
      aggregations: [...instantGauge.aggregations],
    },
    {
      ...instantGauge,
      key: METRICS.responseMs,
      name: "Response time",
      description:
        "Milliseconds until the answer (with GET and expected text, until the body was read), per run that got an answer.",
      unit: "ms",
      dimensions: [...instantGauge.dimensions],
      aggregations: [...instantGauge.aggregations],
      better: "lower",
    },
  ],
  minRefreshIntervalSeconds: INTERVAL_SECONDS,
  supportsBackfill: false,
  outboundDomains: [],
  resourceNoun: { singular: "check", plural: "checks" },
  // Discovery reads the configuration only: no request at all.
  discoversBeforeFirstSync: true,
  translations: { de: httpCheckDe },
  freshnessStreams: [
    {
      key: CHECKS_STREAM,
      name: "Checks",
      kind: "continuous",
      metrics: [METRICS.up, METRICS.responseMs],
      datasets: [checksDataset.key],
    },
  ],
};

// ─── Connector ──────────────────────────────────────────────────────────────

export interface HttpCheckConnectorOptions {
  /** The clock of checked-at times and runs; replaced in tests. */
  now?: () => number;
  /** A monotonic clock for response times (ms); replaced in tests. */
  clock?: () => number;
}

/**
 * HTTP health checks (#874): a connection holds up to MAX_CHECKS URLs and
 * requests each once a minute (GET or HEAD), recording up or down with a
 * reason, the status code and the response time. A check that is down is
 * data, never a failed sync: only a configuration the checks cannot run
 * with, or the host ending the call, fails it.
 *
 * Each check is a resource (linkable to workspace projects) named by a hash
 * of its name. The URLs' hosts reach the egress allowlist through
 * `configuredHosts` (SDK 0.2.21), and the server applies the HTTP check
 * egress limits (time, size, the self-host private hosts).
 */
export function createHttpCheckConnector(
  options: HttpCheckConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => performance.now());

  return {
    manifest: httpCheckManifest,

    // Validates the checks without requesting them: a site that is down
    // is what a check is for, not a reason to refuse the connection.
    async check(context): Promise<CheckResult> {
      try {
        readChecks(context.config);
      } catch (error) {
        if (error instanceof HttpCheckConfigError) {
          return { ok: false, message: error.message, code: error.code };
        }
        throw error;
      }
      return { ok: true };
    },

    async discover(context): Promise<Resource[]> {
      return readChecks(context.config).map((check) => ({
        id: check.id,
        name: check.name,
        kind: "check",
        metadata: { host: check.host, method: check.method },
      }));
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      return syncPage(readChecks(context.config), context, request, runtime, {
        now,
        clock,
        ...(runtime.log ? { log: runtime.log } : {}),
      });
    },
  };
}
