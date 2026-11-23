import {
  ConnectorError,
  type CheckResult,
  type ConnectionContext,
  type Connector,
  type ConnectorManifest,
  type ManifestTranslation,
  type Resource,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import {
  CHECK_MAX_WAIT_MS,
  HETZNER_HOST,
  HetznerApiError,
  createHetznerClient,
  type ClientOptions,
  type HetznerGet,
} from "./api.js";
import { UNATTACHED, loadBalancerResource, serverResource } from "./cost.js";
import {
  HETZNER_DATASETS,
  costItemsDataset,
  serversDataset,
} from "./datasets.js";
import {
  checkPagination,
  loadBalancersPageSchema,
  parse,
  pricingSchema,
  serversPageSchema,
} from "./schemas.js";
import {
  COST_STREAM,
  METRICS,
  METRICS_RETENTION_DAYS,
  METRICS_STREAM,
  PER_PAGE,
  SERVERS_STREAM,
  syncPage,
} from "./sync.js";

export { HetznerApiError, createHetznerClient } from "./api.js";
export { serverState, type ServerState } from "./datasets.js";
export { SERVER_STATUSES } from "./schemas.js";
export {
  COST_STREAM,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
  METRICS_STREAM,
  SERVERS_STREAM,
} from "./sync.js";

/** How far a first sync reads metrics back: as far as Hetzner keeps them. */
export const BACKFILL_DAYS = METRICS_RETENTION_DAYS;

/** Kinds of the resources discover lists. */
export const RESOURCE_KINDS = {
  server: "server",
  loadBalancer: "load_balancer",
  unattached: "unattached",
} as const;

/** Listing pages discover reads per kind (2,000 servers). */
const MAX_DISCOVER_PAGES = 40;

// ─── Reason codes of a failed check (#795) ─────────────────────────────────

export const TOKEN_REJECTED_CODE = "hetzner_cloud.token_rejected";
export const TOKEN_REJECTED_MESSAGE =
  "Hetzner Cloud did not accept the API token: it is wrong or was deleted. Create a token in the Hetzner Console (your project → Security → API tokens) with Read permission and enter it again.";
export const TOKEN_FORBIDDEN_CODE = "hetzner_cloud.token_forbidden";
export const TOKEN_FORBIDDEN_MESSAGE =
  "Hetzner Cloud accepted the API token but refused to let it read the project's servers or prices. Create a new token in the Hetzner Console (your project → Security → API tokens) with Read permission.";

export function tokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.token;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

/** Token failures in discover and sync carry the check's reason code. */
function rethrow(error: unknown): never {
  if (error instanceof HetznerApiError && error.kind === "auth") {
    throw new ConnectorError(TOKEN_REJECTED_MESSAGE, TOKEN_REJECTED_CODE);
  }
  if (error instanceof HetznerApiError && error.kind === "forbidden") {
    throw new ConnectorError(TOKEN_FORBIDDEN_MESSAGE, TOKEN_FORBIDDEN_CODE);
  }
  throw error;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; Hetzner's own labels stay as they appear there.
 */
const hetznerDe: ManifestTranslation = {
  name: "Hetzner Cloud",
  description:
    "Der Zustand jedes Servers, CPU, Netzwerk und Festplatte pro Stunde und eine Schätzung der monatlichen Kosten aus einem Hetzner-Cloud-Projekt.",
  resourceNoun: { singular: "Server", plural: "Server" },
  credentials: {
    token: {
      title: "API-Token",
      description:
        "Ein API-Token des Hetzner-Projekts mit Leserechten (Read). netrics liest damit nur Server, Volumes, IPs, Load Balancer, Preise und Metriken und ändert nichts. Das Token wird verschlüsselt gespeichert und nie wieder angezeigt.",
    },
  },
  setupSteps: [
    "Öffne in der Hetzner Console (console.hetzner.com) das Projekt, das netrics lesen soll.",
    "Geh zu Security → API tokens und klicke auf Generate API token.",
    "Gib dem Token einen Namen (zum Beispiel „netrics“), wähle Read (netrics ändert nichts) und kopiere es. Hetzner zeigt es nur einmal an.",
    "Füge das Token unten ein. Ein Token liest nur sein eigenes Projekt: Für ein weiteres Projekt legst du eine weitere Verbindung an.",
  ],
  metrics: {
    [METRICS.cpu]: {
      name: "CPU-Auslastung (pro vCPU)",
      description:
        "Durchschnittliche CPU-Auslastung eines Servers pro Stunde, wie Hetzner sie meldet: in Prozent einer vCPU (100 % = eine vCPU voll ausgelastet, ein Server mit 4 vCPUs erreicht 400 %).",
    },
    [METRICS.diskRead]: {
      name: "Festplatte gelesen",
      description:
        "Durchschnittlich von der Festplatte des Servers gelesene Bytes pro Sekunde, pro Stunde.",
    },
    [METRICS.diskWrite]: {
      name: "Festplatte geschrieben",
      description:
        "Durchschnittlich auf die Festplatte des Servers geschriebene Bytes pro Sekunde, pro Stunde.",
    },
    [METRICS.networkIn]: {
      name: "Netzwerk eingehend",
      description:
        "Durchschnittlich über die öffentliche Schnittstelle empfangene Bytes pro Sekunde, pro Stunde.",
    },
    [METRICS.networkOut]: {
      name: "Netzwerk ausgehend",
      description:
        "Durchschnittlich über die öffentliche Schnittstelle gesendete Bytes pro Sekunde, pro Stunde.",
    },
    [METRICS.monthlyCost]: {
      name: "Geschätzte Kosten pro Monat",
      description:
        "Eine Schätzung: der Monatspreis laut Hetzners Preisliste (netto, ohne MwSt.) für das, was das Projekt gerade hat, pro Server oder Load Balancer, mit zugeordneten Volumes, IPs, Backups und Snapshots. Ohne zusätzlichen Traffic und alles, was nur einen Teil des Monats bestand. Hetzners API hat keine Rechnungen.",
    },
  },
  dimensions: {
    resource: "Server",
    currency: "Währung",
  },
  freshnessStreams: {
    [SERVERS_STREAM]: "Server",
    [METRICS_STREAM]: "Metriken",
    [COST_STREAM]: "Kostenschätzung",
  },
};

const hourlyGauge = {
  kind: "gauge",
  granularity: "hour",
  dimensions: ["resource"],
  aggregations: ["avg", "min", "max", "last"],
} as const;

export const hetznerCloudManifest: ConnectorManifest = {
  id: "hetzner-cloud",
  version: "0.1.0",
  sdkVersion: "^0.2.19",
  category: "other",
  brandColor: "#d50c2d",
  name: "Hetzner Cloud",
  description:
    "The state of every server, CPU, network and disk per hour, and an estimate of the monthly cost from a Hetzner Cloud project.",
  url: "https://www.hetzner.com/cloud",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/hetzner-cloud.md",
  authStrategies: [
    {
      strategy: "token",
      credentialsSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "API token",
            description:
              "An API token of the Hetzner project with Read permission. netrics only reads servers, volumes, IPs, load balancers, prices and metrics with it and changes nothing. It is stored encrypted and never shown again.",
          },
        },
        required: ["token"],
        additionalProperties: false,
      },
      setup: {
        steps: [
          "In the Hetzner Console (console.hetzner.com), open the project netrics should read.",
          "Go to Security → API tokens and click Generate API token.",
          "Name the token (for example “netrics”), choose Read (netrics changes nothing) and copy it. Hetzner shows it only once.",
          "Paste the token below. A token reads only its own project: add another connection for another project.",
        ],
        url: "https://console.hetzner.com/projects",
      },
    },
  ],
  configSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  datasets: [...HETZNER_DATASETS],
  metrics: [
    {
      ...hourlyGauge,
      key: METRICS.cpu,
      name: "CPU usage (per vCPU)",
      description:
        "A server's average CPU usage per hour as Hetzner reports it: in percent of one vCPU (100 % = one vCPU fully used; a server with 4 vCPUs reaches 400 %).",
      unit: "percent",
      aggregations: [...hourlyGauge.aggregations],
      dimensions: [...hourlyGauge.dimensions],
      better: "lower",
    },
    {
      ...hourlyGauge,
      key: METRICS.diskRead,
      name: "Disk read",
      description:
        "Average bytes per second read from the server's disk, per hour.",
      unit: "bytes/s",
      aggregations: [...hourlyGauge.aggregations],
      dimensions: [...hourlyGauge.dimensions],
    },
    {
      ...hourlyGauge,
      key: METRICS.diskWrite,
      name: "Disk written",
      description:
        "Average bytes per second written to the server's disk, per hour.",
      unit: "bytes/s",
      aggregations: [...hourlyGauge.aggregations],
      dimensions: [...hourlyGauge.dimensions],
    },
    {
      ...hourlyGauge,
      key: METRICS.networkIn,
      name: "Network in",
      description:
        "Average bytes per second received on the public interface, per hour.",
      unit: "bytes/s",
      aggregations: [...hourlyGauge.aggregations],
      dimensions: [...hourlyGauge.dimensions],
    },
    {
      ...hourlyGauge,
      key: METRICS.networkOut,
      name: "Network out",
      description:
        "Average bytes per second sent on the public interface, per hour.",
      unit: "bytes/s",
      aggregations: [...hourlyGauge.aggregations],
      dimensions: [...hourlyGauge.dimensions],
    },
    {
      key: METRICS.monthlyCost,
      name: "Estimated monthly cost",
      description:
        "An estimate: the monthly price on Hetzner's price list (net, without VAT) of what the project holds now, per server or load balancer, with the volumes, IPs, backups and snapshots attached to it. Without extra traffic and anything that existed for part of the month only. Hetzner's API has no invoices.",
      kind: "gauge",
      unit: "currency_minor",
      granularity: "day",
      dimensions: ["resource", "currency"],
      aggregations: ["last", "min", "max"],
      better: "lower",
    },
  ],
  minRefreshIntervalSeconds: 300,
  supportsBackfill: true,
  backfillDays: BACKFILL_DAYS,
  outboundDomains: [HETZNER_HOST],
  resourceNoun: { singular: "server", plural: "servers" },
  // Discovery is the server and load balancer lists: a few cheap requests.
  discoversBeforeFirstSync: true,
  translations: { de: hetznerDe },
  // Hetzner's default: 3,600 requests an hour per project.
  rateLimit: { maxRequests: 3600, windowSeconds: 3600 },
  freshnessStreams: [
    {
      key: SERVERS_STREAM,
      name: "Servers",
      kind: "continuous",
      datasets: [serversDataset.key],
    },
    {
      key: METRICS_STREAM,
      name: "Metrics",
      kind: "continuous",
      metrics: [
        METRICS.cpu,
        METRICS.diskRead,
        METRICS.diskWrite,
        METRICS.networkIn,
        METRICS.networkOut,
      ],
    },
    {
      key: COST_STREAM,
      name: "Cost estimate",
      kind: "continuous",
      metrics: [METRICS.monthlyCost],
      datasets: [costItemsDataset.key],
    },
  ],
};

// ─── Connector ──────────────────────────────────────────────────────────────

export interface HetznerCloudConnectorOptions extends ClientOptions {
  /** The clock of the sync windows and snapshots; replaced in tests. */
  now?: () => number;
}

/** Every page of a listing for discovery, within MAX_DISCOVER_PAGES. */
async function listAll<T>(
  get: HetznerGet,
  path: "/servers" | "/load_balancers",
  items: (json: unknown) => {
    list: T[];
    pagination: Parameters<typeof checkPagination>[0];
  },
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1, request = 0; request < MAX_DISCOVER_PAGES; request += 1) {
    const answer = items(
      await get(path, { page, per_page: PER_PAGE, sort: "id:asc" }),
    );
    all.push(...answer.list);
    const next = checkPagination(
      answer.pagination,
      page,
      answer.list.length,
      path,
    );
    if (next === null) break;
    page = next;
  }
  return all;
}

/**
 * Hetzner Cloud (#872), over the Cloud API with a project's API token.
 * Read only: every request is a GET of a listing (see api.ts).
 *
 * A connection is one Hetzner project (a token reads its own project
 * only). Resources are the project's servers, so each can be linked to a
 * workspace project; load balancers are resources too, for their cost,
 * and items attached to neither are the `unattached` resource.
 *
 * A sync is a resumable run of single-request steps (sync.ts): the price
 * list, every listing page (servers into the `servers` snapshot, every
 * billable item into `cost_items`), then each server's metrics.
 */
export function createHetznerCloudConnector(
  options: HetznerCloudConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;

  function client(
    context: ConnectionContext,
    runtime: Parameters<Connector["check"]>[1],
    maxWaitMs?: number,
  ): { get: HetznerGet; token: string } {
    const token = tokenOf(context);
    if (!token) {
      throw new Error("Hetzner Cloud connection has no API token");
    }
    return {
      get: createHetznerClient(runtime, token, {
        ...options,
        ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
      }),
      token,
    };
  }

  return {
    manifest: hetznerCloudManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!tokenOf(context)) {
        return {
          ok: false,
          message: "Add a Hetzner Cloud API token to this connection.",
        };
      }
      try {
        // Waits for the rate limit must fit the host's check deadline.
        const { get } = client(context, runtime, CHECK_MAX_WAIT_MS);
        // The cheapest reads of what a sync needs: one server, the prices.
        parse(
          serversPageSchema,
          await get("/servers", { page: 1, per_page: 1 }),
          "the server list",
        );
        parse(pricingSchema, await get("/pricing"), "the price list");
      } catch (error) {
        if (error instanceof HetznerApiError && error.kind === "auth") {
          return {
            ok: false,
            message: TOKEN_REJECTED_MESSAGE,
            code: TOKEN_REJECTED_CODE,
          };
        }
        if (error instanceof HetznerApiError && error.kind === "forbidden") {
          return {
            ok: false,
            message: TOKEN_FORBIDDEN_MESSAGE,
            code: TOKEN_FORBIDDEN_CODE,
          };
        }
        throw error;
      }
      return { ok: true };
    },

    async discover(context, runtime): Promise<Resource[]> {
      const { get } = client(context, runtime);
      try {
        const servers = await listAll(get, "/servers", (json) => {
          const answer = parse(serversPageSchema, json, "the server list");
          return { list: answer.servers, pagination: answer.meta.pagination };
        });
        const balancers = await listAll(get, "/load_balancers", (json) => {
          const answer = parse(
            loadBalancersPageSchema,
            json,
            "the load balancers",
          );
          return {
            list: answer.load_balancers,
            pagination: answer.meta.pagination,
          };
        });
        const seen = new Set<string>();
        const resources: Resource[] = [];
        const add = (resource: Resource) => {
          if (seen.has(resource.id)) return;
          seen.add(resource.id);
          resources.push(resource);
        };
        for (const server of servers) {
          add({
            id: serverResource(server.id),
            name: server.name,
            kind: RESOURCE_KINDS.server,
            metadata: { location: server.location.name },
          });
        }
        for (const balancer of balancers) {
          add({
            id: loadBalancerResource(balancer.id),
            name: balancer.name,
            kind: RESOURCE_KINDS.loadBalancer,
            metadata: { location: balancer.location.name },
          });
        }
        add({
          id: UNATTACHED,
          name: "Not attached to a server",
          kind: RESOURCE_KINDS.unattached,
        });
        return resources;
      } catch (error) {
        rethrow(error);
      }
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      const { get, token } = client(context, runtime);
      try {
        return await syncPage(get, context, token, request, {
          now,
          ...(runtime.log ? { log: runtime.log } : {}),
        });
      } catch (error) {
        rethrow(error);
      }
    },
  };
}
