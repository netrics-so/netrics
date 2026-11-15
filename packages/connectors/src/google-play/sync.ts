import { createHash, randomUUID } from "node:crypto";

import {
  DATASET_LIMITS,
  type ConnectorDatasetStaging,
  type ConnectorRuntime,
  type DatasetPage,
  type DatasetRecord,
  type DatasetStageWriter,
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
  installDataset,
  listingRatingDataset,
  ratingReportDataset,
  readEarningsReport,
  readInstallReport,
  readRatingReport,
  reportStatusDataset,
  type Drain,
  type RowSink,
} from "./datasets.js";
import {
  RowsDigest,
  StageBuilder,
  WindowReader,
  type AppWindow,
  type StagedPart,
} from "./partitions.js";
import { listingSnapshot, type ListingSnapshot } from "./ratings.js";
import {
  ReportFormatError,
  ReportTooLargeError,
  type ReportSource,
} from "./tabular.js";

const PREFIX = "google-play-data:";
/**
 * Version of the report reader. Raise it when reports the previous reader
 * refused (invalid_report) can now be read: the first incremental sync after
 * the upgrade then reads the whole import window again instead of only recent
 * months, so those reports are not skipped forever. 2: report headers match
 * case- and whitespace-insensitively (#611). 3: Play Console rating overview
 * reports are read, so a year of ratings is imported once.
 */
export const REPORT_READER = 3;
/** Default import window, in days, of a first import and a reader catch-up. */
export const HISTORY_DAYS = 365;
/**
 * The cursor of a finished sync: the reader version and the sync end. A bare
 * timestamp is the finished cursor of reader 1.
 */
const FINISHED = "google-play-done:";
function finished(to: string): string {
  return `${FINISHED}${REPORT_READER}:${to}`;
}
/** Staged pages one turn emits at most, within one page's worth of bytes. */
const STAGED_TURN_PAGES = 16;
const taskSchema = z.object({
  key: z.string(),
  kind: z.enum(["installs", "earnings", "ratings"]),
  month: z.iso.date(),
  appId: z.string().optional(),
});
type Task = z.infer<typeof taskSchema>;
const stateSchema = z.object({
  version: z.literal(1),
  /** REPORT_READER of the run; absent in checkpoints of reader 1. */
  reader: z.number().int().positive().optional(),
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
  stageId: z.uuid().optional(),
  /** The pending task's report objects and generations (#519). */
  source: z.string().optional(),
});
type State = z.infer<typeof stateSchema>;
interface Catalog {
  installs: ReportObject[];
  earnings: ReportObject[];
  ratings: ReportObject[];
  installPermission: boolean;
  earningsPermission: boolean;
  ratingsPermission: boolean;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/**
 * hash([rows, objects as [name, generation]]) without building the whole JSON
 * text: the same bytes are fed to the digest one row at a time.
 */
export function rowsDigest(
  rows: DatasetRecord[],
  objects: ReportObject[],
): string {
  const digest = new RowsDigest();
  for (const row of rows) digest.add(JSON.stringify(row));
  return digest.digest(objects);
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
/**
 * Where a run starts from the host's cursor: a checkpoint of this reader to
 * continue, the end of the last finished sync (incremental runs revisit
 * reports changed since then), and whether an older reader read the reports
 * last (`stale`). A checkpoint of an older reader is dropped, as one of
 * another configuration is.
 */
function startingPoint(request: SyncRequest): {
  state?: State;
  since: string;
  stale: boolean;
} {
  const cursor = request.cursor;
  if (!cursor) return { since: request.from, stale: false };
  if (cursor.startsWith(PREFIX)) {
    const state = decode(cursor);
    // A checkpoint of a catch-up keeps that scope if its configuration changes.
    const catchUp = state.mode === "backfill" && request.mode === "incremental";
    if (state.reader === REPORT_READER)
      return { state, since: request.from, stale: catchUp };
    return { since: request.from, stale: true };
  }
  const done = new RegExp(`^${FINISHED}(\\d+):(.+)$`).exec(cursor);
  if (done && z.iso.datetime().safeParse(done[2]).success)
    return {
      since: done[2]!,
      stale: Number(done[1]) !== REPORT_READER,
    };
  // Reader 1 finished with the bare sync end.
  if (z.iso.datetime().safeParse(cursor).success)
    return { since: cursor, stale: true };
  return { since: request.from, stale: false };
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
/** Only the overview dimension: the rating Play Console shows for the app. */
const RATING_FILE = /^stats\/ratings\/ratings_(.+)_(\d{6})_overview\.csv$/;
const FILES: Record<Task["kind"], RegExp> = {
  installs: INSTALL_FILE,
  earnings: EARNING_FILE,
  ratings: RATING_FILE,
};

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
  const [installs, earnings, ratings] = await Promise.all([
    read("stats/installs/"),
    read("earnings/"),
    read("stats/ratings/"),
  ]);
  return {
    installs: installs.objects,
    earnings: earnings.objects,
    // Only overview reports are read; other dimensions are not listed on.
    ratings: ratings.objects.filter((object) => RATING_FILE.test(object.name)),
    installPermission: installs.permission,
    earningsPermission: earnings.permission,
    ratingsPermission: ratings.permission,
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
  for (const object of [
    ...catalog.installs,
    ...catalog.earnings,
    ...catalog.ratings,
  ]) {
    const match =
      INSTALL_FILE.exec(object.name) ??
      EARNING_FILE.exec(object.name) ??
      RATING_FILE.exec(object.name);
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
    for (const appId of apps)
      tasks.push({
        key: `${order}:2:${appId}`,
        kind: "ratings",
        month,
        appId,
      });
  }
  return tasks.sort((a, b) => a.key.localeCompare(b.key));
}

interface Frame {
  definition: SourceDatasetDefinition;
  apps: string[];
  availability:
    "available" | "not_published" | "permission_missing" | "invalid_report";
  objects: ReportObject[];
  unmapped: number;
  /** Safe reason code of an invalid_report (ReportFormatError.reason). */
  reason?: string;
  /** The task's rows are staged: turns read their page from the stage. */
  stage?: { id: string; parts: StagedPart[] };
  /** Not staged: this turn's pages of one app, read from the report again. */
  window?: AppWindow;
}
/**
 * A part's page index in one string, "key.count.bytes" per page and comma
 * separated; offsets follow from the counts. Stage metadata is bounded JSON
 * (10,000 values), and a report staged in short pages has thousands of pages.
 */
const PAGE_INDEX = /^\d+\.\d+\.\d+(,\d+\.\d+\.\d+)*$/;
function encodePages(pages: StagedPart["pages"]): string {
  return pages
    .map((page) => `${page.key}.${page.count}.${page.bytes}`)
    .join(",");
}
function decodePages(index: string): StagedPart["pages"] {
  let offset = 0;
  return index.split(",").map((entry) => {
    const [key, count, bytes] = entry.split(".") as [string, string, string];
    const page = { key, offset, count: Number(count), bytes: Number(bytes) };
    offset += page.count;
    return page;
  });
}
const stagedFrameSchema = z.object({
  version: z.literal(2),
  apps: z.array(z.string()),
  unmapped: z.number().int().nonnegative(),
  parts: z.array(
    z.object({
      app: z.string(),
      totalRows: z.number().int().nonnegative(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      pages: z.string().regex(PAGE_INDEX).transform(decodePages),
    }),
  ),
});
type StagedFrame = z.input<typeof stagedFrameSchema>;
function frameObjects(task: Task, catalog: Catalog): ReportObject[] {
  return catalog[task.kind]
    .filter((object) => {
      const match = FILES[task.kind].exec(object.name);
      return !!(
        match &&
        nameMonth(match[match.length - 1]!) === task.month &&
        (task.kind === "earnings" || match[1] === task.appId)
      );
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const DEFINITIONS: Record<Task["kind"], SourceDatasetDefinition> = {
  installs: installDataset,
  earnings: earningsDataset,
  ratings: ratingReportDataset,
};
function baseFrame(task: Task, apps: string[], catalog: Catalog): Frame {
  const objects = frameObjects(task, catalog);
  const frame: Frame = {
    definition: DEFINITIONS[task.kind],
    apps: task.kind === "earnings" ? [...apps] : [task.appId!],
    availability: "available",
    objects,
    unmapped: 0,
  };
  if (
    !{
      installs: catalog.installPermission,
      earnings: catalog.earningsPermission,
      ratings: catalog.ratingsPermission,
    }[task.kind]
  )
    frame.availability = "permission_missing";
  else if (objects.length === 0) frame.availability = "not_published";
  return frame;
}

class ReportDownloadError extends Error {
  constructor(readonly original: unknown) {
    super("Google Play report download failed");
  }
}
/**
 * Reads the task's report objects once, handing every typed row to `emit`
 * and awaiting `drain` between pieces. Sets the frame's app roster, unmapped
 * count and availability; returns false when the report is not available,
 * in which case every row emitted so far must be discarded.
 */
async function readReport(
  frame: Frame,
  task: Task,
  apps: string[],
  selected: boolean,
  client: PlayReportsClient,
  emit: RowSink,
  drain?: Drain,
): Promise<boolean> {
  if (frame.availability !== "available") return false;
  // Report bodies are read in bounded ranges while they are parsed; a failed
  // provider read keeps its own meaning instead of reading as a bad report.
  const download = async (object: ReportObject): Promise<ReportSource> => {
    let source: ReportSource;
    try {
      source = await client.source(object);
    } catch (error) {
      throw new ReportDownloadError(error);
    }
    return {
      size: source.size,
      async read(offset, length) {
        try {
          return await source.read(offset, length);
        } catch (error) {
          throw new ReportDownloadError(error);
        }
      },
    };
  };
  const seen = new Set<string>();
  try {
    if (task.kind !== "earnings") {
      if (frame.objects.length !== 1)
        throw new ReportFormatError(
          "duplicate_reports",
          "Google Play returned duplicate per-app reports for one month",
        );
      const object = frame.objects[0]!;
      await (task.kind === "installs" ? readInstallReport : readRatingReport)(
        await download(object),
        task.appId!,
        task.month,
        object.name,
        object.generation,
        emit,
        drain,
      );
    } else {
      const wanted = selected ? new Set(apps) : undefined;
      for (const object of frame.objects) {
        const parsed = await readEarningsReport(
          await download(object),
          task.month,
          object.name,
          object.generation,
          wanted,
          (app, row) => {
            seen.add(app);
            emit(app, row);
          },
          drain,
        );
        frame.unmapped += parsed.unmapped;
      }
      if (!selected)
        frame.apps = [...new Set([...apps, ...seen, "__unmapped"])].sort();
    }
    return true;
  } catch (error) {
    if (error instanceof ReportDownloadError) {
      const cause = error.original;
      if (cause instanceof PlayReportError && cause.status === 403)
        frame.availability = "permission_missing";
      else if (cause instanceof PlayReportError && cause.status === 404)
        frame.availability = "not_published";
      else if (cause instanceof ReportTooLargeError) {
        frame.availability = "invalid_report";
        frame.reason = "too_large";
      } else throw cause;
    } else if (error instanceof StagingRefusedError) throw error;
    else {
      // The reason is recorded on the availability row (#611): a code, never
      // the message, row data or the object name.
      frame.availability = "invalid_report";
      frame.reason =
        error instanceof ReportFormatError
          ? error.reason
          : error instanceof ReportTooLargeError
            ? "too_large"
            : "unreadable";
    }
    frame.unmapped = 0;
    return false;
  }
}

/** The host refused (or could not take) a staging write. */
class StagingRefusedError extends Error {
  constructor(readonly original: unknown) {
    super("Google Play report staging was refused");
  }
}
/**
 * The task's frame: an existing stage, a stage written while the report is
 * read (SDK 0.2.11 `begin`), or, when there is no staging, a refusal or a task
 * that started without a stage, one app's pages read from the report again.
 */
async function taskFrame(
  task: Task,
  apps: string[],
  selected: boolean,
  catalog: Catalog,
  client: PlayReportsClient,
  store: ConnectorRuntime["datasetStaging"],
  signature: string,
  position: { app?: string; offset: number },
): Promise<Frame> {
  const frame = baseFrame(task, apps, catalog);
  const permitted = frame.availability !== "permission_missing";
  // Rows staged by another reader version are never reused.
  const key =
    "play-v2:" +
    hash([
      signature,
      task,
      apps,
      selected,
      permitted,
      frame.objects,
      REPORT_READER,
    ]);
  const stage =
    store && frame.availability === "available" ? await store.get(key) : null;
  if (stage) {
    // Listing permission does not imply object permission; verify the exact pinned
    // object generation before reusing retained private rows.
    try {
      for (const object of frame.objects) await client.validate(object);
    } catch (error) {
      if (error instanceof PlayReportError && [403, 404].includes(error.status))
        return {
          ...frame,
          availability:
            error.status === 403 ? "permission_missing" : "not_published",
        };
      throw error;
    }
    const metadata = stagedFrameSchema.parse(stage.metadata);
    return {
      ...frame,
      apps: metadata.apps,
      unmapped: metadata.unmapped,
      stage: { id: stage.id, parts: metadata.parts },
    };
  }
  if (store?.begin && frame.availability === "available") {
    const staged = await stageFrame(
      frame,
      task,
      apps,
      selected,
      client,
      store.begin,
      key,
    );
    if (staged) return staged;
  }
  return windowFrame(
    baseFrame(task, apps, catalog),
    task,
    apps,
    selected,
    client,
    position,
  );
}

/** Stages the task while reading its report; null when the host refuses. */
async function stageFrame(
  frame: Frame,
  task: Task,
  apps: string[],
  selected: boolean,
  client: PlayReportsClient,
  begin: NonNullable<ConnectorDatasetStaging["begin"]>,
  key: string,
): Promise<Frame | null> {
  // Staging is an optimization. Stage-size, quota or storage refusals fall
  // back to reading one app per turn; ingestion still enforces the workspace
  // quota on the rows themselves.
  const refused = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw new StagingRefusedError(error);
    }
  };
  let writer: DatasetStageWriter;
  try {
    writer = await begin({
      key,
      datasetKey: frame.definition.key,
      schemaVersion: frame.definition.version,
    });
  } catch {
    return null;
  }
  const builder = new StageBuilder(writer, frame.definition, {
    from: task.month,
    toExclusive: nextMonth(task.month),
  });
  try {
    const available = await readReport(
      frame,
      task,
      apps,
      selected,
      client,
      (app, row) => builder.add(app, row),
      () => refused(() => builder.drain()),
    );
    if (!available) {
      await writer.abort();
      return frame;
    }
    const parts = await refused(() =>
      builder.finish(frame.apps, frame.objects),
    );
    const metadata: StagedFrame = {
      version: 2,
      apps: frame.apps,
      unmapped: frame.unmapped,
      parts: parts.map((part) => ({ ...part, pages: encodePages(part.pages) })),
    };
    const stored = await refused(() => writer.commit({ metadata }));
    return { ...frame, stage: { id: stored.id, parts } };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    if (error instanceof StagingRefusedError) return null;
    throw error;
  }
}

/** Reads the report again for up to UNSTAGED_TURN_PAGES pages of one app. */
async function windowFrame(
  frame: Frame,
  task: Task,
  apps: string[],
  selected: boolean,
  client: PlayReportsClient,
  position: { app?: string; offset: number },
): Promise<Frame> {
  const reader = new WindowReader(
    position.app,
    position.app === undefined ? 0 : position.offset,
    frame.apps.concat(
      task.kind === "earnings" && !selected ? ["__unmapped"] : [],
    ),
  );
  const available = await readReport(
    frame,
    task,
    apps,
    selected,
    client,
    (app, row) => reader.add(app, row),
  );
  if (!available) return frame;
  return { ...frame, window: reader.result(frame.objects) };
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
    schemaVersion: reportStatusDataset.version,
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
          reason:
            frame.availability === "invalid_report"
              ? (frame.reason ?? "unreadable")
              : null,
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
  const start = startingPoint(request);
  let state = start.state;
  if (!state || state.signature !== options.signature) {
    // A sync after one whose reader was older reads the whole import window
    // again, as a backfill does: reports the old reader refused would
    // otherwise stay invalid_report once they are no longer recent (#611).
    const catchUp = request.mode === "incremental" && start.stale;
    const mode = catchUp ? "backfill" : request.mode;
    const from =
      mode === "backfill"
        ? options.historyFrom
          ? options.historyFrom + "T00:00:00.000Z"
          : catchUp
            ? new Date(
                Date.parse(request.to) - HISTORY_DAYS * 86_400_000,
              ).toISOString()
            : request.from
        : priorMonth(monthOf(start.since)) + "T00:00:00.000Z";
    if (Date.parse(from) >= Date.parse(request.to))
      throw new Error("Google Play history start must be before the sync end.");
    state = {
      version: 1,
      reader: REPORT_READER,
      signature: options.signature,
      phase: "ratings",
      mode,
      historyFloor: options.historyFrom,
      from,
      to: request.to,
      since: start.since,
      offset: 0,
      previous: null,
      refresh: randomUUID(),
      digest: null,
    };
  }
  const apps = [...new Set(await options.apps())].sort();
  if (apps.length === 0)
    return { observations: [], nextCursor: finished(state.to), done: true };
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
        return snapshot.record ? [snapshot.record] : [];
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
          records: snapshots.flat(),
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
  if (!task)
    return {
      observations: [],
      nextCursor: finished(state.to),
      // Every month of the window was checked for every app. Rating rows
      // are only emitted for months with a readable report, so an account
      // without any would otherwise stay pending forever: declared received,
      // the host stores it as empty while it has no rows and never replaces
      // stored rows (#666). Install and earnings reports are not declared.
      receivedDatasets: [ratingReportDataset.key],
      done: true,
    };
  const source = hash(
    frameObjects(task, catalog).map((object) => [
      object.name,
      object.generation,
    ]),
  );
  const continuing = state.task?.key === task.key && state.app !== undefined;
  // A changed report (new object generations) restarts the pending app from
  // its first row; otherwise the turn continues at the checkpoint.
  const position = continuing
    ? {
        app: state.app,
        offset:
          state.source === undefined || state.source === source
            ? state.offset
            : 0,
      }
    : { offset: 0 };
  const frame = await taskFrame(
    task,
    apps,
    request.resources !== undefined,
    catalog,
    options.client,
    // Once a task starts without a stage, keep that choice through its
    // continuation. Admitting a cache later would change stage identity and
    // abandon the partially committed refresh even though the report is unchanged.
    state.task && !state.stageId ? undefined : runtime.datasetStaging,
    options.signature,
    position,
  );
  const restart = (from: State): State => ({
    ...from,
    offset: 0,
    previous: null,
    refresh: randomUUID(),
    digest: null,
    source,
  });
  const roster = hash(frame.apps);
  if (
    !state.task ||
    state.roster !== roster ||
    !state.app ||
    !frame.apps.includes(state.app)
  )
    state = restart({
      ...state,
      task,
      stageId: frame.stage?.id,
      roster,
      app: frame.apps[0]!,
    });
  else if (state.stageId !== frame.stage?.id)
    // A rebuilt or expired stage restarts only the pending app partition, so one
    // refresh never mixes pages (and collection times) from two stages. Apps
    // already completed in this task are not emitted again.
    state = restart({ ...state, stageId: frame.stage?.id });
  else if (position.offset !== state.offset) state = restart(state);
  const app = state.app!;
  const part = frame.stage?.parts.find((part) => part.app === app);
  if (frame.stage && !part)
    throw new Error("Invalid Google Play staged report index");
  const window = frame.availability === "available" ? frame.window : undefined;
  const digest = part?.digest ?? window?.digest ?? null;
  if (
    (frame.availability === "available" &&
      !frame.stage &&
      (window?.app !== app || window.offset !== state.offset)) ||
    (!frame.stage &&
      state.digest !== null &&
      digest !== null &&
      state.digest !== digest)
  )
    // The rows read again this turn are not the ones the checkpoint needs:
    // the app roster changed, or the report's rows did. Start the pending app
    // over on the next turn, without emitting anything.
    return {
      observations: [],
      datasetPages: [],
      nextCursor: encode(restart(state)),
      done: false,
    };
  if (state.digest !== null && digest !== null && state.digest !== digest)
    state = restart(state);
  const totalRows = part?.totalRows ?? window?.totalRows ?? 0;
  if (frame.availability === "available" && state.offset > totalRows)
    throw new Error("Invalid Google Play report checkpoint");
  const pages: DatasetPage[] = [];
  let offset = state.offset,
    previous = state.previous,
    complete = frame.availability !== "available";
  const dataPage = (records: DatasetRecord[], last: boolean) => {
    const page: DatasetPage = {
      datasetKey: frame.definition.key,
      schemaVersion: frame.definition.version,
      refreshKey: state.refresh,
      pageKey: String(offset),
      previousPageKey: previous,
      records,
      complete: last,
      window: {
        from: task.month,
        toExclusive: nextMonth(task.month),
        partition: { app_id: app },
      },
    };
    previous = String(offset);
    offset += records.length;
    return page;
  };
  if (part) {
    const first = part.pages.findIndex((page) => page.offset === state.offset);
    if (first < 0)
      throw new Error("Invalid Google Play staged report checkpoint");
    // Staged pages can be short (cut early to bound memory while staging), so
    // a turn takes consecutive pages up to about one full page of rows.
    let bytes = 0;
    for (const stagedPage of part.pages.slice(
      first,
      first + STAGED_TURN_PAGES,
    )) {
      if (pages.length && bytes + stagedPage.bytes > DATASET_LIMITS.pageBytes)
        break;
      bytes += stagedPage.bytes;
      const staged = await runtime.datasetStaging!.getPage(
        frame.stage!.id,
        stagedPage.key,
      );
      // A page cut early is never complete, even when it ends the app's
      // rows: the app's (empty) final page follows.
      complete = staged.complete;
      pages.push({
        ...dataPage(staged.records, complete),
        stagingId: frame.stage!.id,
        stagingPageKey: stagedPage.key,
      });
      if (complete) break;
    }
  } else if (window)
    for (const records of window.pages) {
      complete = offset + records.length === totalRows;
      pages.push(dataPage(records, complete));
      if (complete) break;
    }
  if (complete) pages.push(statusPage(task, app, frame, capturedAt));
  const nextApp = complete
    ? frame.apps[frame.apps.indexOf(app) + 1]
    : undefined;
  const next: State = !complete
    ? { ...state, offset, previous, digest, source }
    : nextApp
      ? restart({ ...state, app: nextApp })
      : {
          ...restart(state),
          task: undefined,
          app: undefined,
          roster: undefined,
          stageId: undefined,
          source: undefined,
          afterTask: task.key,
        };
  return {
    observations: [],
    datasetPages: pages,
    nextCursor: encode(next),
    done: false,
  };
}
