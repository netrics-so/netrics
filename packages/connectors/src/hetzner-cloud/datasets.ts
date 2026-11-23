import {
  DATASET_LIMITS,
  type DatasetField,
  type DatasetRecord,
  type SourceDatasetDefinition,
} from "@netrics/connector-sdk";

import { decimalOf, type CostItem } from "./cost.js";
import type { HetznerServer } from "./schemas.js";

function field(
  id: string,
  name: string,
  type: DatasetField["type"],
  extra: Partial<DatasetField> = {},
): DatasetField {
  return {
    id,
    name,
    type,
    nullable: false,
    classification: "internal",
    ...extra,
  };
}

/**
 * Every server of the project as of the last sync, replaced as a whole by
 * every sync that read the whole list (snapshot): the status widget's
 * source for "is it up".
 */
export const serversDataset: SourceDatasetDefinition = {
  key: "servers",
  name: "Hetzner Cloud servers",
  version: 1,
  mode: "snapshot",
  keyFields: ["server_id"],
  grain: "One Hetzner Cloud server, as of the last sync",
  retentionDays: 30,
  fields: [
    field("server_id", "Server ID", "string"),
    field("name", "Server", "string"),
    field("status", "Status", "string"),
    field("state", "State", "string"),
    field("server_type", "Server type", "string"),
    field("cores", "vCPUs", "integer"),
    field("memory_gb", "Memory", "number", { unit: "GB" }),
    field("disk_gb", "Disk", "number", { unit: "GB" }),
    field("location", "Location", "string"),
    field("city", "City", "string", { nullable: true }),
    field("country", "Country", "string", { nullable: true }),
    field("network_zone", "Network zone", "string", { nullable: true }),
    field("labels", "Labels", "json", { nullable: true }),
    field("backups", "Backups on", "boolean"),
    field("created_at", "Created", "timestamp"),
    field("outgoing_traffic_bytes", "Outgoing traffic", "integer", {
      nullable: true,
      unit: "bytes",
    }),
    field("ingoing_traffic_bytes", "Incoming traffic", "integer", {
      nullable: true,
      unit: "bytes",
    }),
    field("included_traffic_bytes", "Included traffic", "integer", {
      nullable: true,
      unit: "bytes",
    }),
    field("checked_at", "Checked", "timestamp"),
  ],
};

/**
 * What the project holds that costs money, each at its monthly list price
 * (snapshot): the inputs of the cost estimate, one row per item.
 */
export const costItemsDataset: SourceDatasetDefinition = {
  key: "cost_items",
  name: "Hetzner Cloud cost estimate",
  version: 1,
  mode: "snapshot",
  keyFields: ["item_kind", "item_id"],
  grain:
    "One billable Hetzner Cloud item (server, backups, volume, snapshot, IP, load balancer) at its monthly list price",
  retentionDays: 30,
  fields: [
    field("item_kind", "Kind", "string"),
    field("item_id", "Item ID", "string"),
    field("name", "Name", "string"),
    field("resource_id", "Server or load balancer", "string"),
    field("location", "Location", "string"),
    field("basis", "Priced as", "string"),
    field("monthly_net", "Monthly price (net)", "decimal", {
      nullable: true,
      scale: 6,
      currencyField: "currency",
    }),
    field("monthly_gross", "Monthly price (gross)", "decimal", {
      nullable: true,
      scale: 6,
      currencyField: "currency",
    }),
    field("currency", "Currency", "string"),
    field("as_of", "As of", "timestamp"),
  ],
};

export const HETZNER_DATASETS = [serversDataset, costItemsDataset] as const;

// ─── States ─────────────────────────────────────────────────────────────────

/**
 * The state of a server for status widgets (#875):
 *
 * - "up": running;
 * - "building": initializing, starting, rebuilding or migrating;
 * - "down": stopping, off or deleting;
 * - "unknown": Hetzner says unknown, or a status it adds later.
 *
 * Hetzner has no failed status: a server that does not answer is still
 * "running" to the API (a health check sees it).
 */
export type ServerState = "up" | "building" | "down" | "unknown";

export function serverState(status: string): ServerState {
  switch (status) {
    case "running":
      return "up";
    case "initializing":
    case "starting":
    case "rebuilding":
    case "migrating":
      return "building";
    case "stopping":
    case "off":
    case "deleting":
      return "down";
    default:
      return "unknown";
  }
}

/** An instant as the dataset contract wants it (UTC, `Z`). */
export function utc(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("not an instant");
  return new Date(ms).toISOString();
}

function wholeBytes(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isSafeInteger(value)
    ? null
    : value;
}

/** Room left for the rest of a row next to its labels. */
const ROW_BYTES = DATASET_LIMITS.rowBytes - 1_024;

export function serverRecord(
  server: HetznerServer,
  checkedAt: string,
): DatasetRecord {
  const values = {
    server_id: String(server.id),
    name: server.name,
    status: server.status,
    state: serverState(server.status),
    server_type: server.server_type.name,
    cores: server.server_type.cores,
    memory_gb: server.server_type.memory,
    disk_gb: server.primary_disk_size ?? server.server_type.disk,
    location: server.location.name,
    city: server.location.city ?? null,
    country: server.location.country ?? null,
    network_zone: server.location.network_zone ?? null,
    labels: server.labels as Record<string, string> | null,
    backups: Boolean(server.backup_window),
    created_at: utc(server.created),
    outgoing_traffic_bytes: wholeBytes(server.outgoing_traffic),
    ingoing_traffic_bytes: wholeBytes(server.ingoing_traffic),
    included_traffic_bytes: wholeBytes(server.included_traffic),
    checked_at: checkedAt,
  };
  // A row stays within the 64 KiB a record may have (ADR 0026 §7): labels
  // that would not fit are left out rather than the server.
  if (Buffer.byteLength(JSON.stringify(values)) > ROW_BYTES) {
    values.labels = null;
  }
  if (Buffer.byteLength(JSON.stringify(values)) > ROW_BYTES) {
    values.name = values.name.slice(0, 200);
  }
  return { values };
}

export function costRecord(
  item: CostItem,
  currency: string,
  asOf: string,
): DatasetRecord {
  return {
    values: {
      item_kind: item.kind,
      item_id: item.id,
      name: item.name.slice(0, 500),
      resource_id: item.resource,
      location: item.location,
      basis: item.basis.slice(0, 200),
      monthly_net: item.monthly ? decimalOf(item.monthly[0]) : null,
      monthly_gross: item.monthly ? decimalOf(item.monthly[1]) : null,
      currency,
      as_of: asOf,
    },
  };
}
