import { and, eq, inArray } from "drizzle-orm";
import type { DeviceStatusStream, WidgetFreshness } from "@netrics/contracts";
import type {
  ConnectorManifest,
  FreshnessStream,
} from "@netrics/connector-sdk";
import {
  schema,
  type ConnectionFreshnessRow,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_LOCALE,
  isFreshnessLate,
  isFreshnessOverdue,
  localizedFreshnessStreamName,
  RESOURCE_DIMENSION,
  slideScopeResource,
  type DashboardFilterExclusion,
  type Locale,
  type SlideFilterScope,
} from "@netrics/domain";

import {
  relevantFreshnessRows,
  selectedResourcesOf,
} from "../sync/freshness.js";
import { modelSourceDatasets, type ModelRelease } from "./model-sources.js";

// A widget's freshness (ADR 0025 sections 6 and 7): the freshness streams
// its data depends on, resolved per (connection, stream, resources), and
// summarized as the least fresh of their stored rows. Everything comes from
// stored rows and the connections' next_due_at, never from the clock, so a
// payload's version (its ETag) changes only when those rows do.

/** Where the streams of a connector come from: the connector registry. */
export interface FreshnessManifests {
  get(connectorId: string): { manifest: ConnectorManifest } | undefined;
}

/**
 * One part of a widget's data: a metric or a source dataset of a
 * connection, or a stream by its key (review text, which no metric or
 * dataset carries).
 */
export type FreshnessDependency = {
  connectionId: string;
  /** One resource; absent: every selected resource. */
  resource?: string | undefined;
} & ({ metricKey: string } | { datasetKey: string } | { stream: string });

/**
 * The stream of a connector's review text (ADR 0025 section 1: App Store
 * Connect's `reviews` stream holds the review metrics and the review text).
 * Latest-review widgets depend on the stream with this key.
 */
export const REVIEWS_FRESHNESS_STREAM = "reviews";

export interface WidgetFreshnessResult {
  /** Absent when the widget depends on no stream with stored rows. */
  freshness?: WidgetFreshness;
  /** A row used is late by 24 hours or more: the widget is `stale`. */
  overdue: boolean;
}

interface LoadedConnection {
  manifest: ConnectorManifest;
  streams: readonly FreshnessStream[];
  selected: readonly string[] | undefined;
  nextDueAt: Date | null;
  rows: { row: ConnectionFreshnessRow; stream: FreshnessStream }[];
}

interface UsedRow {
  connectionId: string;
  row: ConnectionFreshnessRow;
  stream: FreshnessStream;
  manifest: ConnectorManifest;
}

/**
 * Reads freshness for the widgets of one response, loading each
 * connection's stored rows once. Connections of connectors that declare
 * no streams are never queried for rows.
 */
export interface FreshnessReader {
  read(
    tx: Transaction,
    dependencies: readonly FreshnessDependency[],
  ): Promise<WidgetFreshnessResult>;
  /**
   * Each connection's streams with stored rows, in manifest order, each
   * summarized over the rows a widget of every selected resource uses
   * (a status board, #727). Connections without such rows are absent.
   */
  streams(
    tx: Transaction,
    connectionIds: readonly string[],
  ): Promise<Map<string, DeviceStatusStream[]>>;
}

export function createFreshnessReader(
  workspaceId: string,
  manifests: FreshnessManifests,
  locale: Locale = DEFAULT_LOCALE,
): FreshnessReader {
  const loaded = new Map<string, LoadedConnection | null>();

  async function load(tx: Transaction, connectionIds: readonly string[]) {
    const missing = [...new Set(connectionIds)].filter((id) => !loaded.has(id));
    if (!missing.length) return;
    for (const id of missing) loaded.set(id, null);
    const connections = await tx
      .select({
        id: schema.connections.id,
        connectorId: schema.connections.connectorId,
        config: schema.connections.config,
        nextDueAt: schema.connectionState.nextDueAt,
      })
      .from(schema.connections)
      .leftJoin(
        schema.connectionState,
        and(
          eq(schema.connectionState.workspaceId, workspaceId),
          eq(schema.connectionState.connectionId, schema.connections.id),
        ),
      )
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          inArray(schema.connections.id, missing),
        ),
      );
    const withStreams = connections.flatMap((connection) => {
      const manifest = manifests.get(connection.connectorId)?.manifest;
      return manifest?.freshnessStreams?.length
        ? [{ connection, manifest }]
        : [];
    });
    if (!withStreams.length) return;
    const rows = await tx
      .select()
      .from(schema.connectionFreshness)
      .where(
        and(
          eq(schema.connectionFreshness.workspaceId, workspaceId),
          inArray(
            schema.connectionFreshness.connectionId,
            withStreams.map(({ connection }) => connection.id),
          ),
        ),
      );
    for (const { connection, manifest } of withStreams) {
      const streams = manifest.freshnessStreams ?? [];
      const selected = selectedResourcesOf(
        connection.config as Record<string, unknown>,
        manifest,
      );
      loaded.set(connection.id, {
        manifest,
        streams,
        selected,
        nextDueAt: connection.nextDueAt,
        rows: relevantFreshnessRows(
          rows.filter((row) => row.connectionId === connection.id),
          streams,
          selected,
        ),
      });
    }
  }

  return {
    async read(tx, dependencies) {
      if (!dependencies.length) return { overdue: false };
      await load(
        tx,
        dependencies.map((dependency) => dependency.connectionId),
      );
      const used = new Map<string, UsedRow>();
      const nextDue = new Map<string, Date | null>();
      for (const dependency of dependencies) {
        const connection = loaded.get(dependency.connectionId);
        if (!connection) continue;
        const stream = connection.streams.find((stream) =>
          "metricKey" in dependency
            ? stream.metrics?.includes(dependency.metricKey)
            : "datasetKey" in dependency
              ? stream.datasets?.includes(dependency.datasetKey)
              : stream.key === dependency.stream,
        );
        if (!stream) continue;
        for (const row of streamRows(connection, stream, dependency.resource))
          used.set(
            `${dependency.connectionId}\u0000${row.stream}\u0000${row.resource}`,
            {
              connectionId: dependency.connectionId,
              row,
              stream,
              manifest: connection.manifest,
            },
          );
        nextDue.set(dependency.connectionId, connection.nextDueAt);
      }
      return summarizeFreshness([...used.values()], nextDue, locale);
    },
    async streams(tx, connectionIds) {
      await load(tx, connectionIds);
      const found = new Map<string, DeviceStatusStream[]>();
      for (const connectionId of connectionIds) {
        const connection = loaded.get(connectionId);
        if (!connection) continue;
        const nextDue = new Map([[connectionId, connection.nextDueAt]]);
        const streams = connection.streams.flatMap((stream) => {
          const summary = summarizeFreshness(
            streamRows(connection, stream, undefined).map((row) => ({
              connectionId,
              row,
              stream,
              manifest: connection.manifest,
            })),
            nextDue,
            locale,
          );
          return summary.freshness
            ? [
                {
                  key: stream.key,
                  ...summary.freshness,
                  ...(summary.overdue ? { overdue: true as const } : {}),
                },
              ]
            : [];
        });
        if (streams.length) found.set(connectionId, streams);
      }
      return found;
    },
  };
}

/**
 * A live query's freshness fields (#727): `freshness`, and `status`
 * "stale" when a row used is overdue by 24 h. Nothing without rows, so
 * those responses stay as they were.
 */
export function liveFreshness(found: WidgetFreshnessResult): {
  freshness?: WidgetFreshness;
  status?: "stale";
} {
  return {
    ...(found.freshness ? { freshness: found.freshness } : {}),
    ...(found.overdue ? { status: "stale" as const } : {}),
  };
}

/**
 * The freshness of a live metric query or goal (#727): its metric on its
 * connection, for the `resource` filter (a widget's own or the slide
 * scope's, which browsers send as the filter), else every selected
 * resource; as a device payload resolves the same widget.
 */
export async function metricLiveFreshness(
  tx: Transaction,
  reader: FreshnessReader | undefined,
  query: {
    connectionId: string;
    metricKey: string;
    dimensions?: Readonly<Record<string, string>> | undefined;
  },
): Promise<{ freshness?: WidgetFreshness; status?: "stale" }> {
  if (!reader) return {};
  return liveFreshness(
    await reader.read(tx, [
      {
        connectionId: query.connectionId,
        metricKey: query.metricKey,
        resource: query.dimensions?.[RESOURCE_DIMENSION],
      },
    ]),
  );
}

/**
 * The rows of one stream for a widget (ADR 0025 section 6): the resource's
 * row, else the connection row; for every selected resource each one's
 * row, else the connection row. Without a stored selection (every
 * resource), every resource row and the connection row.
 */
function streamRows(
  connection: LoadedConnection,
  stream: FreshnessStream,
  resource: string | undefined,
): ConnectionFreshnessRow[] {
  const rows = connection.rows
    .filter((entry) => entry.stream.key === stream.key)
    .map((entry) => entry.row);
  const byResource = new Map(rows.map((row) => [row.resource, row]));
  const whole = byResource.get("");
  if (resource !== undefined) {
    const own = byResource.get(resource) ?? whole;
    return own ? [own] : [];
  }
  if (connection.selected === undefined) return rows;
  const picked = new Set<ConnectionFreshnessRow>();
  for (const id of connection.selected) {
    const own = byResource.get(id) ?? whole;
    if (own) picked.add(own);
  }
  if (!picked.size && whole) picked.add(whole);
  return [...picked];
}

const time = (date: Date | null) => date?.getTime() ?? null;

/**
 * Data with its freshness (ADR 0025 section 7): a provider overdue by a
 * day turns `ok` into `stale`. Without freshness the data is returned as
 * it is, so payloads of connectors without streams stay byte for byte.
 */
export function applyFreshness<T extends { status: string }>(
  data: T,
  found: WidgetFreshnessResult,
): T {
  if (!found.freshness && !found.overdue) return data;
  return {
    ...data,
    ...(found.overdue && data.status === "ok" ? { status: "stale" } : {}),
    ...(found.freshness ? { freshness: found.freshness } : {}),
  };
}

/**
 * The least fresh of the rows used (ADR 0025 section 7): among periodic
 * rows the earliest `dataThrough` (a row without one first), ties broken
 * by the earliest `nextExpectedAt`; continuous rows only without periodic
 * ones, the least recently checked. `fetchedAt` is the oldest check of all
 * rows used, `nextCheckAt` the earliest next_due_at of their connections.
 */
export function summarizeFreshness(
  rows: readonly UsedRow[],
  nextDue: ReadonlyMap<string, Date | null>,
  locale: Locale = DEFAULT_LOCALE,
): WidgetFreshnessResult {
  if (!rows.length) return { overdue: false };
  // A stable order, so equal rows always give the same summary.
  const sorted = [...rows].sort((a, b) =>
    compareText(
      `${a.connectionId}\u0000${a.row.stream}\u0000${a.row.resource}`,
      `${b.connectionId}\u0000${b.row.stream}\u0000${b.row.resource}`,
    ),
  );
  const fetchedAt = Math.min(
    ...sorted.map(({ row }) => row.checkedAt.getTime()),
  );
  const dueTimes = [
    ...new Set(sorted.map(({ connectionId }) => connectionId)),
  ].flatMap((id) => {
    const due = time(nextDue.get(id) ?? null);
    return due === null ? [] : [due];
  });
  const nextCheckAt = dueTimes.length ? Math.min(...dueTimes) : null;
  const periodic = sorted.filter(({ stream }) => stream.kind === "periodic");
  const tail = {
    ...(nextCheckAt === null
      ? {}
      : { nextCheckAt: new Date(nextCheckAt).toISOString() }),
  };
  if (!periodic.length) {
    const chosen = sorted.reduce((least, entry) =>
      entry.row.checkedAt.getTime() < least.row.checkedAt.getTime()
        ? entry
        : least,
    );
    return {
      freshness: {
        kind: "continuous",
        stream: localizedFreshnessStreamName(
          chosen.manifest,
          chosen.stream,
          locale,
        ),
        fetchedAt: new Date(fetchedAt).toISOString(),
        ...tail,
      },
      overdue: false,
    };
  }
  const chosen = periodic.reduce((least, entry) =>
    lessFresh(entry.row, least.row) ? entry : least,
  );
  const date = chosen.row.dataThrough;
  const late = periodic.some(
    ({ row }) => row.dataThrough === date && isFreshnessLate(row),
  );
  return {
    freshness: {
      kind: "periodic",
      stream: localizedFreshnessStreamName(
        chosen.manifest,
        chosen.stream,
        locale,
      ),
      fetchedAt: new Date(fetchedAt).toISOString(),
      ...(date === null ? {} : { dataThrough: date }),
      ...(chosen.stream.period === "month" ? { period: "month" as const } : {}),
      ...(chosen.row.nextExpectedAt
        ? { nextExpectedAt: chosen.row.nextExpectedAt.toISOString() }
        : {}),
      ...(late ? { late: true as const } : {}),
      ...tail,
    },
    overdue: periodic.some(({ row }) => isFreshnessOverdue(row)),
  };
}

/** Whether periodic row `a` is less fresh than `b`. */
function lessFresh(a: ConnectionFreshnessRow, b: ConnectionFreshnessRow) {
  if (a.dataThrough !== b.dataThrough) {
    if (a.dataThrough === null) return true;
    if (b.dataThrough === null) return false;
    return a.dataThrough < b.dataThrough;
  }
  const ea = time(a.nextExpectedAt),
    eb = time(b.nextExpectedAt);
  if (ea === eb) return false;
  if (ea === null) return false;
  if (eb === null) return true;
  return ea < eb;
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The streams a measure widget depends on (ADR 0025 section 6): the datasets
 * of the model's published release, also those its preparations read (see
 * `modelSourceDatasets`, which its source warnings share).
 */
export async function modelFreshnessDependencies(
  tx: Transaction,
  workspaceId: string,
  release: ModelRelease,
  slideScope: SlideFilterScope,
  exclusions: readonly DashboardFilterExclusion[],
  /** A paired screen's fixed scope; it can never be excluded. */
  deviceScope: SlideFilterScope = {},
): Promise<FreshnessDependency[]> {
  return sourceFreshnessDependencies(
    tx,
    workspaceId,
    (await modelSourceDatasets(tx, workspaceId, release)).all,
    slideScope,
    exclusions,
    deviceScope,
  );
}

/**
 * The streams of a model's datasets. A source dataset resolves to its
 * connection's dataset key, an observation dataset through its metric
 * definition to the metric key. `resources:` and manual datasets have no
 * stream. The resource is the one the slide scope names for the
 * connection, else the one a screen's scope names (#500), else every
 * selected resource.
 */
export async function sourceFreshnessDependencies(
  tx: Transaction,
  workspaceId: string,
  ids: ReadonlySet<string>,
  slideScope: SlideFilterScope,
  exclusions: readonly DashboardFilterExclusion[],
  /** A paired screen's fixed scope; it can never be excluded. */
  deviceScope: SlideFilterScope = {},
): Promise<FreshnessDependency[]> {
  const datasetIds: string[] = [];
  const observations: { connectionId: string; metricId: string }[] = [];
  for (const id of ids) {
    if (UUID.test(id)) datasetIds.push(id);
    else if (id.startsWith("observation:")) {
      const [, connectionId = "", metricId = ""] = id.split(":");
      if (UUID.test(connectionId) && UUID.test(metricId))
        observations.push({ connectionId, metricId });
    }
  }
  const found: { connectionId: string; key: string; metric: boolean }[] = [];
  if (datasetIds.length)
    for (const dataset of await tx
      .select({
        connectionId: schema.dataDatasets.connectionId,
        key: schema.dataDatasets.key,
      })
      .from(schema.dataDatasets)
      .where(
        and(
          eq(schema.dataDatasets.workspaceId, workspaceId),
          eq(schema.dataDatasets.kind, "source"),
          inArray(schema.dataDatasets.id, datasetIds),
        ),
      ))
      if (dataset.connectionId)
        found.push({
          connectionId: dataset.connectionId,
          key: dataset.key,
          metric: false,
        });
  if (observations.length) {
    const keys = new Map(
      (
        await tx
          .select({
            id: schema.metricDefinitions.id,
            key: schema.metricDefinitions.key,
          })
          .from(schema.metricDefinitions)
          .where(
            inArray(
              schema.metricDefinitions.id,
              observations.map(({ metricId }) => metricId),
            ),
          )
      ).map((row) => [row.id, row.key]),
    );
    for (const { connectionId, metricId } of observations) {
      const key = keys.get(metricId);
      if (key !== undefined) found.push({ connectionId, key, metric: true });
    }
  }
  return found.map(({ connectionId, key, metric }) => {
    const named = (scoped: { resource?: string; conflict: boolean }) =>
      scoped.resource !== undefined && !scoped.conflict
        ? scoped.resource
        : undefined;
    const resource =
      named(slideScopeResource(slideScope, connectionId, exclusions)) ??
      named(slideScopeResource(deviceScope, connectionId, []));
    return metric
      ? { connectionId, metricKey: key, resource }
      : { connectionId, datasetKey: key, resource };
  });
}
