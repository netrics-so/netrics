import { createHash, randomUUID } from "node:crypto";

import {
  DATASET_LIMITS,
  type ConnectorRuntime,
  type DatasetPage,
  type DatasetRecord,
  type SourceDatasetDefinition,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  PlayReportError,
  type PlayReportsClient,
  type ReportObject,
} from "./api.js";
import {
  earningsDataset,
  earningsRows,
  installDataset,
  installRows,
  listingRatingDataset,
  reportStatusDataset,
} from "./datasets.js";
import { listingSnapshot, type ListingSnapshot } from "./ratings.js";

const PREFIX = "google-play-data:";
const taskSchema = z.object({
  key: z.string(),
  kind: z.enum(["installs", "earnings"]),
  month: z.iso.date(),
  appId: z.string().optional(),
});
type Task = z.infer<typeof taskSchema>;
const stateSchema = z.object({
  version: z.literal(1),
  signature: z.string(),
  phase: z.enum(["ratings", "reports"]),
  mode: z.enum(["backfill", "incremental"]),
  historyFloor: z.iso.date().optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  since: z.iso.datetime(),
  ratingAfter: z.string().optional(),
  afterTask: z.string().optional(),
  task: taskSchema.optional(),
  app: z.string().optional(),
  roster: z.string().optional(),
  offset: z.number().int().nonnegative(),
  previous: z.string().nullable(),
  refresh: z.uuid(),
  digest: z.string().nullable(),
});
type State = z.infer<typeof stateSchema>;
interface Catalog {
  installs: ReportObject[];
  earnings: ReportObject[];
  installPermission: boolean;
  earningsPermission: boolean;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function encode(state: State): string {
  return PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}
function decode(cursor: string): State {
  try {
    return stateSchema.parse(
      JSON.parse(
        Buffer.from(cursor.slice(PREFIX.length), "base64url").toString("utf8"),
      ),
    );
  } catch {
    throw new Error("Invalid Google Play sync checkpoint");
  }
}
function monthOf(date: string): string {
  return date.slice(0, 7) + "-01";
}
function nextMonth(month: string): string {
  const date = new Date(month);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}
function priorMonth(month: string): string {
  const date = new Date(month);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}
function nameMonth(raw: string): string | undefined {
  const value = `${raw.slice(0, 4)}-${raw.slice(4)}-01`;
  if (!z.iso.date().safeParse(value).success) return undefined;
  return value;
}
const INSTALL_FILE = /^stats\/installs\/installs_(.+)_(\d{6})_country\.csv$/;
const EARNING_FILE = /^earnings\/earnings_(\d{6})(?:[^/]*)\.zip$/;

export async function reportCatalog(
  client: PlayReportsClient,
): Promise<Catalog> {
  const read = async (prefix: string) => {
    try {
      return { objects: await client.list(prefix), permission: true };
    } catch (error) {
      if (error instanceof PlayReportError && error.status === 403)
        return { objects: [], permission: false };
      throw error;
    }
  };
  const [installs, earnings] = await Promise.all([
    read("stats/installs/"),
    read("earnings/"),
  ]);
  return {
    installs: installs.objects,
    earnings: earnings.objects,
    installPermission: installs.permission,
    earningsPermission: earnings.permission,
  };
}
export function reportedPackages(objects: ReportObject[]): string[] {
  return [
    ...new Set(
      objects.flatMap((object) => {
        const match = INSTALL_FILE.exec(object.name);
        return match ? [match[1]!] : [];
      }),
    ),
  ].sort();
}

function tasksFor(state: State, apps: string[], catalog: Catalog): Task[] {
  const months = new Set<string>();
  const current = monthOf(state.to),
    previous = priorMonth(current),
    earliest = monthOf(state.from);
  const dirtySince = Date.parse(state.since) - 7 * 86_400_000;
  for (const object of [...catalog.installs, ...catalog.earnings]) {
    const match =
      INSTALL_FILE.exec(object.name) ?? EARNING_FILE.exec(object.name);
    const rawMonth = match?.[match.length - 1];
    if (!rawMonth) continue;
    const month = nameMonth(rawMonth);
    if (!month) continue;
    if (
      month <= current &&
      (!state.historyFloor || month >= monthOf(state.historyFloor)) &&
      (month >= earliest ||
        (state.mode === "incremental" &&
          Date.parse(object.updated) >= dirtySince))
    )
      months.add(month);
  }
  // Expected recent months surface missing/delayed reports even before their
  // first object exists. Older unavailable periods are not fabricated as zero.
  if (current >= earliest) months.add(current);
  if (previous >= earliest) months.add(previous);
  const tasks: Task[] = [];
  for (const month of months) {
    const order = String(
      999999 - Number(month.slice(0, 7).replace("-", "")),
    ).padStart(6, "0");
    for (const appId of apps)
      tasks.push({
        key: `${order}:0:${appId}`,
        kind: "installs",
        month,
        appId,
      });
    tasks.push({ key: `${order}:1`, kind: "earnings", month });
  }
  return tasks.sort((a, b) => a.key.localeCompare(b.key));
}

interface Frame {
  definition: SourceDatasetDefinition;
  rows: Map<string, DatasetRecord[]>;
  apps: string[];
  availability:
    "available" | "not_published" | "permission_missing" | "invalid_report";
  objects: ReportObject[];
  unmapped: number;
}
class ReportDownloadError extends Error {
  constructor(readonly original: unknown) {
    super("Google Play report download failed");
  }
}
async function readFrame(
  task: Task,
  apps: string[],
  selected: boolean,
  catalog: Catalog,
  client: PlayReportsClient,
): Promise<Frame> {
  const objects = (
    task.kind === "installs" ? catalog.installs : catalog.earnings
  ).filter((object) => {
    const match =
      task.kind === "installs"
        ? INSTALL_FILE.exec(object.name)
        : EARNING_FILE.exec(object.name);
    return (
      match &&
      nameMonth(match[match.length - 1]!) === task.month &&
      (task.kind !== "installs" || match[1] === task.appId)
    );
  });
  const frame: Frame = {
    definition: task.kind === "installs" ? installDataset : earningsDataset,
    rows: new Map(),
    apps: task.kind === "installs" ? [task.appId!] : [...apps],
    availability: "available",
    objects,
    unmapped: 0,
  };
  if (
    !(task.kind === "installs"
      ? catalog.installPermission
      : catalog.earningsPermission)
  )
    frame.availability = "permission_missing";
  else if (objects.length === 0) frame.availability = "not_published";
  if (frame.availability !== "available") return frame;
  const download = async (object: ReportObject) => {
    try {
      return await client.bytes(object);
    } catch (error) {
      throw new ReportDownloadError(error);
    }
  };
  try {
    if (task.kind === "installs") {
      if (objects.length !== 1)
        throw new Error(
          "Google Play returned duplicate country install reports",
        );
      const object = objects[0]!;
      frame.rows.set(
        task.appId!,
        installRows(
          await download(object),
          task.appId!,
          task.month,
          object.name,
          object.generation,
        ),
      );
    } else {
      for (const object of objects) {
        const parsed = earningsRows(
          await download(object),
          task.month,
          object.name,
          object.generation,
          selected ? new Set(apps) : undefined,
        );
        frame.unmapped += parsed.unmapped;
        for (const [appId, rows] of parsed.records)
          frame.rows.set(appId, [...(frame.rows.get(appId) ?? []), ...rows]);
      }
      if (!selected)
        frame.apps = [
          ...new Set([...apps, ...frame.rows.keys(), "__unmapped"]),
        ].sort();
    }
    for (const rows of frame.rows.values())
      rows.sort((a, b) =>
        JSON.stringify(a.values).localeCompare(JSON.stringify(b.values)),
      );
  } catch (error) {
    if (error instanceof ReportDownloadError) {
      const cause = error.original;
      if (cause instanceof PlayReportError && cause.status === 403)
        frame.availability = "permission_missing";
      else if (cause instanceof PlayReportError && cause.status === 404)
        frame.availability = "not_published";
      else throw cause;
    } else frame.availability = "invalid_report";
    frame.rows = new Map();
  }
  return frame;
}

function statusPage(
  task: Task,
  appId: string,
  frame: Frame,
  capturedAt: string,
): DatasetPage {
  const updated =
    frame.objects
      .map((object) => object.updated)
      .sort()
      .at(-1) ?? null;
  return {
    datasetKey: reportStatusDataset.key,
    schemaVersion: 1,
    refreshKey: randomUUID(),
    pageKey: "0",
    previousPageKey: null,
    complete: true,
    records: [
      {
        values: {
          app_id: appId,
          report_type: task.kind,
          report_month: task.month,
          availability: frame.availability,
          captured_at: capturedAt,
          provider_updated_at: updated,
          object_names: frame.objects.map((object) => object.name),
          unmapped_rows: frame.unmapped,
        },
      },
    ],
  };
}

export interface PlaySyncOptions {
  now: number;
  signature: string;
  historyFrom?: string;
  scope: { country: string; locale: string };
  apps: () => Promise<string[]>;
  client: PlayReportsClient;
  onListing?: (id: string, snapshot: ListingSnapshot) => void;
}
export async function syncPlayReports(
  request: SyncRequest,
  runtime: ConnectorRuntime,
  options: PlaySyncOptions,
): Promise<SyncResult> {
  let state = request.cursor?.startsWith(PREFIX)
    ? decode(request.cursor)
    : undefined;
  if (!state || state.signature !== options.signature) {
    const from =
      request.mode === "backfill"
        ? options.historyFrom
          ? options.historyFrom + "T00:00:00.000Z"
          : request.from
        : priorMonth(monthOf(request.from)) + "T00:00:00.000Z";
    if (Date.parse(from) >= Date.parse(request.to))
      throw new Error("Google Play history start must be before the sync end.");
    state = {
      version: 1,
      signature: options.signature,
      phase: "ratings",
      mode: request.mode,
      historyFloor: options.historyFrom,
      from,
      to: request.to,
      since: request.from,
      offset: 0,
      previous: null,
      refresh: randomUUID(),
      digest: null,
    };
  }
  const apps = [...new Set(await options.apps())].sort();
  if (apps.length === 0)
    return { observations: [], nextCursor: state.to, done: true };
  const capturedAt = new Date(options.now).toISOString();
  if (state.phase === "ratings") {
    const ratingAfter = state.ratingAfter;
    const remaining = apps.filter(
      (id) => ratingAfter === undefined || id.localeCompare(ratingAfter) > 0,
    );
    const batch = remaining.slice(0, 4);
    const snapshots = await Promise.all(
      batch.map(async (id) => {
        const snapshot = await listingSnapshot(
          runtime,
          id,
          options.scope,
          capturedAt,
        );
        options.onListing?.(id, snapshot);
        return snapshot.record;
      }),
    );
    const next: State =
      remaining.length <= batch.length
        ? { ...state, phase: "reports" }
        : { ...state, ratingAfter: batch.at(-1) };
    return {
      observations: [],
      datasetPages: [
        {
          datasetKey: listingRatingDataset.key,
          schemaVersion: 1,
          refreshKey: randomUUID(),
          pageKey: "0",
          previousPageKey: null,
          complete: true,
          records: snapshots,
        },
      ],
      nextCursor: encode(next),
      done: false,
    };
  }
  const catalog = await reportCatalog(options.client);
  const afterTask = state.afterTask;
  const task =
    state.task ??
    tasksFor(state, apps, catalog).find(
      (task) =>
        afterTask === undefined || task.key.localeCompare(afterTask) > 0,
    );
  if (!task || apps.length === 0)
    return { observations: [], nextCursor: state.to, done: true };
  const frame = await readFrame(
    task,
    apps,
    request.resources !== undefined,
    catalog,
    options.client,
  );
  const roster = hash(frame.apps);
  if (
    !state.task ||
    state.roster !== roster ||
    !state.app ||
    !frame.apps.includes(state.app)
  )
    state = {
      ...state,
      task,
      roster,
      app: frame.apps[0]!,
      offset: 0,
      previous: null,
      refresh: randomUUID(),
      digest: null,
    };
  const app = state.app!;
  const rows = frame.rows.get(app) ?? [];
  const digest = hash([
    rows,
    frame.objects.map((object) => [object.name, object.generation]),
  ]);
  if (state.digest !== null && state.digest !== digest)
    state = {
      ...state,
      offset: 0,
      previous: null,
      refresh: randomUUID(),
      digest: null,
    };
  if (state.offset > rows.length)
    throw new Error("Invalid Google Play report checkpoint");
  const records: DatasetRecord[] = [];
  let bytes = 4096;
  if (frame.availability === "available")
    for (const row of rows.slice(
      state.offset,
      state.offset + DATASET_LIMITS.pageRows,
    )) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (size > DATASET_LIMITS.rowBytes)
        throw new Error(
          "Google Play report row exceeds the transport record budget",
        );
      if (bytes + size + 1 > DATASET_LIMITS.pageBytes) break;
      records.push(row);
      bytes += size + 1;
    }
  const end = state.offset + records.length;
  const complete = frame.availability !== "available" || end === rows.length;
  const pages: DatasetPage[] =
    frame.availability === "available"
      ? [
          {
            datasetKey: frame.definition.key,
            schemaVersion: 1,
            refreshKey: state.refresh,
            pageKey: String(state.offset),
            previousPageKey: state.previous,
            records,
            complete,
            window: {
              from: task.month,
              toExclusive: nextMonth(task.month),
              partition: { app_id: app },
            },
          },
        ]
      : [];
  if (complete) pages.push(statusPage(task, app, frame, capturedAt));
  const nextApp = complete
    ? frame.apps[frame.apps.indexOf(app) + 1]
    : undefined;
  const next: State = !complete
    ? { ...state, offset: end, previous: String(state.offset), digest }
    : nextApp
      ? {
          ...state,
          app: nextApp,
          offset: 0,
          previous: null,
          refresh: randomUUID(),
          digest: null,
        }
      : {
          ...state,
          task: undefined,
          app: undefined,
          roster: undefined,
          afterTask: task.key,
          offset: 0,
          previous: null,
          refresh: randomUUID(),
          digest: null,
        };
  return {
    observations: [],
    datasetPages: pages,
    nextCursor: encode(next),
    done: false,
  };
}
