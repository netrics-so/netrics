import { createHash, randomUUID } from "node:crypto";

import {
  DATASET_LIMITS,
  type DatasetRecord,
  type SourceDatasetDefinition,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import type { SalesRow } from "./sales-report.js";

export const salesDataset: SourceDatasetDefinition = {
  key: "sales_rows",
  name: "App Store sales report rows",
  version: 1,
  grain:
    "One original report row per app and Pacific reporting day; duplicate rows remain distinct",
  mode: "replace_window",
  keyFields: ["app_id", "day", "row_id"],
  reportingField: "day",
  reportingTimeZone: "America/Los_Angeles",
  retentionDays: null,
  fields: [
    {
      id: "app_id",
      name: "Apple app ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "day",
      name: "Reporting day (Pacific)",
      type: "date",
      nullable: false,
      classification: "internal",
    },
    {
      id: "row_id",
      name: "Report row identity",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "sku",
      name: "SKU",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "product_type",
      name: "Product type identifier",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "units",
      name: "Units",
      type: "decimal",
      nullable: false,
      classification: "internal",
    },
    {
      id: "developer_proceeds_per_unit",
      name: "Developer proceeds per unit",
      type: "decimal",
      unit: "currency",
      currencyField: "currency",
      nullable: false,
      classification: "internal",
    },
    {
      id: "currency",
      name: "Currency of proceeds",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "country",
      name: "Country code",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "device",
      name: "Device",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "provider_fields",
      name: "Original provider columns",
      type: "json",
      nullable: false,
      classification: "internal",
    },
  ],
};

export interface SalesDatasetScope {
  from: string;
  toExclusive: string;
  appIds: string[];
  records: Map<string, DatasetRecord[]>;
}
const UNMAPPED_APP = "__unmapped";
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function decimalValue(raw: string): string {
  const value = raw.trim() || "0";
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value))
    throw new Error("App Store sales row has an invalid decimal value");
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = value.replace(/^[+-]/, "").split(".");
  const digits =
    whole.replace(/^0+(?=\d)/, "") +
    (fraction === undefined ? "" : `.${fraction}`);
  return negative && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

/** Keep source facts before product classification and aggregation. */
export function retainSalesRows(
  published: Map<number, SalesRow[]>,
  from: number,
  toExclusive: number,
  appBySku: Map<string, string>,
  appIds: string[],
  selected: Set<string> | undefined,
): SalesDatasetScope | undefined {
  if (from >= toExclusive) return undefined;
  const records = new Map(appIds.map((id) => [id, [] as DatasetRecord[]]));
  for (const [dayMs, rows] of published) {
    if (dayMs < from || dayMs >= toExclusive) continue;
    const day = new Date(dayMs).toISOString().slice(0, 10);
    const duplicates = new Map<string, number>();
    for (const row of rows) {
      const appId = row.parentId
        ? appBySku.get(row.parentId)
        : row.appleId || undefined;
      if (selected && (!appId || !selected.has(appId))) continue;
      const id = appId ?? UNMAPPED_APP;
      const original = Object.fromEntries(
        Object.entries(row.providerFields).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
      const rowHash = hash(original);
      const duplicateKey = `${id}:${rowHash}`;
      const ordinal = duplicates.get(duplicateKey) ?? 0;
      duplicates.set(duplicateKey, ordinal + 1);
      const currency = row.currency || "XXX";
      if (!/^[A-Z]{3}$/.test(currency))
        throw new Error("App Store sales row has an invalid currency code");
      const values = {
        app_id: id,
        day,
        row_id: `${rowHash}-${ordinal}`,
        sku: row.sku,
        product_type: row.productType,
        units: decimalValue(row.rawUnits),
        developer_proceeds_per_unit: decimalValue(row.proceeds),
        currency,
        country: row.countryCode,
        device: row.device,
        provider_fields: original,
      };
      const list = records.get(id) ?? [];
      list.push({ values });
      records.set(id, list);
    }
  }
  // Retain the unmapped partition even when empty so a correction can remove
  // earlier unmapped rows. Never import unidentifiable rows for a selection.
  if (!selected && !records.has(UNMAPPED_APP)) records.set(UNMAPPED_APP, []);
  for (const list of records.values())
    list.sort(
      (a, b) =>
        String(a.values.day).localeCompare(String(b.values.day)) ||
        String(a.values.row_id).localeCompare(String(b.values.row_id)),
    );
  return {
    from: new Date(from).toISOString().slice(0, 10),
    toExclusive: new Date(toExclusive).toISOString().slice(0, 10),
    appIds: [...records.keys()].sort(),
    records,
  };
}

const PREFIX = "sales-data:";
const stateSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  cursor: z.string().optional(),
  signature: z.string(),
  app: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  previous: z.string().nullable(),
  refresh: z.uuid(),
  digest: z.string().nullable(),
});
type State = z.infer<typeof stateSchema>;
function checkpoint(state: State): string {
  return PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}
function parseCheckpoint(cursor: string): State {
  try {
    return stateSchema.parse(
      JSON.parse(
        Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8"),
      ),
    );
  } catch {
    throw new Error("Invalid App Store sales-data checkpoint");
  }
}

/**
 * One app/window is authoritative only after its last transport page. Reports
 * are reread to resume; a content change restarts that app's pending refresh.
 * This deliberately trades repeated reads for safe restart without placing
 * provider records in the cursor. A retained object reader can replace this
 * strategy without changing the dataset or saved model contract.
 */
export async function syncSalesDataset(
  request: SyncRequest,
  read: (
    request: SyncRequest,
  ) => Promise<{ result: SyncResult; scope?: SalesDatasetScope }>,
): Promise<SyncResult> {
  let state = request.cursor?.startsWith(PREFIX)
    ? parseCheckpoint(request.cursor)
    : undefined;
  const pinned = state
    ? { ...request, from: state.from, to: state.to, cursor: state.cursor }
    : request;
  const { result, scope } = await read(pinned);
  if (!scope || scope.appIds.length === 0) return result;
  const signature = hash([
    scope.from,
    scope.toExclusive,
    scope.appIds,
    request.resources ? [...new Set(request.resources)].sort() : null,
  ]);
  if (!state || state.signature !== signature) {
    state = {
      from: pinned.from,
      to: pinned.to,
      cursor: pinned.cursor,
      signature,
      app: 0,
      offset: 0,
      previous: null,
      refresh: randomUUID(),
      digest: null,
    };
  }
  const appId = scope.appIds[state.app];
  if (!appId) throw new Error("Invalid App Store sales-data checkpoint");
  const rows = scope.records.get(appId)!;
  const digest = hash(rows);
  if (state.digest !== null && state.digest !== digest) {
    state = { ...state, offset: 0, previous: null, refresh: randomUUID() };
  }
  if (state.offset > rows.length)
    throw new Error("Invalid App Store sales-data checkpoint");
  const records: DatasetRecord[] = [];
  let bytes = 4096;
  for (const row of rows.slice(
    state.offset,
    state.offset + DATASET_LIMITS.pageRows,
  )) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (rowBytes > DATASET_LIMITS.rowBytes)
      throw new Error(
        "App Store sales row exceeds the transport record budget",
      );
    if (bytes + rowBytes + 1 > DATASET_LIMITS.pageBytes) break;
    records.push(row);
    bytes += rowBytes + 1;
  }
  const end = state.offset + records.length;
  const complete = end === rows.length;
  const lastApp = state.app === scope.appIds.length - 1;
  const finished = complete && lastApp;
  const nextState = complete
    ? {
        ...state,
        app: state.app + 1,
        offset: 0,
        previous: null,
        digest: null,
        refresh: randomUUID(),
      }
    : { ...state, offset: end, previous: String(state.offset), digest };
  return {
    observations: finished ? result.observations : [],
    datasetPages: [
      {
        datasetKey: salesDataset.key,
        schemaVersion: 1,
        refreshKey: state.refresh,
        pageKey: String(state.offset),
        previousPageKey: state.previous,
        records,
        complete,
        window: {
          from: scope.from,
          toExclusive: scope.toExclusive,
          partition: { app_id: appId },
        },
      },
    ],
    nextCursor: finished ? result.nextCursor : checkpoint(nextState),
    done: finished && result.done,
  };
}
