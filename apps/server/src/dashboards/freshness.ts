import { and, eq, inArray, sql } from "drizzle-orm";
import type { DeviceStatusStream, WidgetFreshness } from "@netrics/contracts";
import type {
  ConnectorManifest,
  FreshnessStream,
} from "@netrics/connector-sdk";
import {
  resolveDataPolicy,
  schema,
  type ConnectionFreshnessRow,
  type Transaction,
  notDraftConnection,
  findConnectionHistory,
  rethrowWorkspaceGone,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  DEFAULT_LOCALE,
  isFreshnessLate,
  isFreshnessOverdue,
  localizedFreshnessSourceName,
  localizedFreshnessStreamName,
  RESOURCE_DIMENSION,
  scopedFreshnessResources,
  type DashboardDataFilter,
  type DashboardFilterExclusion,
  type DashboardFilterValue,
  type DataExpression,
  type DataPolicy,
  type Locale,
  type SlideFilterScope,
} from "@netrics/domain";

import { createDataLoader } from "../data/service.js";
import {
  relevantFreshnessRows,
  selectedResourcesOf,
} from "../sync/freshness.js";
import {
  modelSourceDatasets,
  type ModelRelease,
  type PinnedDefaultLinks,
} from "./model-sources.js";

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

export interface UsedRow {
  connectionId: string;
  row: ConnectionFreshnessRow;
  stream: FreshnessStream;
  manifest: ConnectorManifest;
  /**
   * A stand-in for an app a widget names that has no stored row yet (#776):
   * "no data yet", so it is the least fresh row. `checked`: its `checkedAt`
   * is its connection's latest check; `unchecked`: the connection has no
   * rows, so it has no time and adds none to `fetchedAt`.
   */
  missing?: "checked" | "unchecked";
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
  /** The mapping tables product scopes resolve through, read once (#767). */
  readonly scopeMappings: ScopeMappingCache;
}

export function createFreshnessReader(
  workspaceId: string,
  manifests: FreshnessManifests,
  locale: Locale = DEFAULT_LOCALE,
  /** Mapping tables the response already read; else a cache of its own. */
  scopeMappings: ScopeMappingCache = createScopeMappingCache(),
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
          notDraftConnection(),
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
    scopeMappings,
    async read(tx, dependencies) {
      if (!dependencies.length) return { overdue: false };
      await load(
        tx,
        dependencies.map((dependency) => dependency.connectionId),
      );
      const used = new Map<string, UsedRow>();
      const nextDue = new Map<string, Date | null>();
      // The apps the dependencies name, each with the first periodic
      // stream that has no row for it, until one of its streams has a row.
      const apps = new Map<
        string,
        {
          connectionId: string;
          resource: string;
          connection: LoadedConnection;
          found: boolean;
          stream?: FreshnessStream;
        }
      >();
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
        const rows = streamRows(connection, stream, dependency.resource);
        if (dependency.resource !== undefined) {
          const key = `${dependency.connectionId}\u0000${dependency.resource}`;
          const app = apps.get(key) ?? {
            connectionId: dependency.connectionId,
            resource: dependency.resource,
            connection,
            found: false,
          };
          if (rows.length) app.found = true;
          else if (stream.kind === "periodic") app.stream ??= stream;
          apps.set(key, app);
        }
        for (const row of rows)
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
      // An app without a row in any of its streams (just added, or not
      // synced yet) counts as "no data yet" next to the rows of the
      // others (#776): a product is never fresher than its least fresh
      // app. Alone it stays without freshness, as before.
      if (used.size)
        for (const app of apps.values()) {
          if (app.found || !app.stream) continue;
          const entry = missingRow(workspaceId, app, app.stream);
          used.set(
            `${app.connectionId}\u0000${entry.row.stream}\u0000${entry.row.resource}`,
            entry,
          );
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
 * The days a widget's metric is read completely (#378): from the start of
 * the connection's last complete backfill (`history_from`) to the least
 * fresh periodic `dataThrough` of the streams it uses. None while a
 * backfill runs, without a complete backfill, for continuous streams and
 * for connectors that report no freshness: their empty windows stay "no
 * data" (ADR 0025 section 9).
 */
export function readCoverage(
  found: { freshness?: WidgetFreshness | undefined },
  history: { historyFrom: Date | null; backfilling: boolean },
): { from: string; through: string } | undefined {
  const freshness = found.freshness;
  const through =
    freshness?.kind === "periodic" ? freshness.dataThrough : undefined;
  if (!through || history.backfilling || !history.historyFrom) {
    return undefined;
  }
  return { from: history.historyFrom.toISOString().slice(0, 10), through };
}

/**
 * The read days of a live query's or goal's metric (#378, #799), from the
 * freshness it answers with and its connection's history: one path for
 * metric queries, breakdowns and goals.
 */
export async function liveReadCoverage(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  live: { freshness?: WidgetFreshness | undefined },
): Promise<{ from: string; through: string } | undefined> {
  return live.freshness
    ? readCoverage(
        live,
        await findConnectionHistory(tx, workspaceId, connectionId),
      )
    : undefined;
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

/**
 * The stand-in row of an app without stored rows (#776): periodic without
 * a covered day or a next time, checked when its connection last was.
 */
function missingRow(
  workspaceId: string,
  app: { connectionId: string; resource: string; connection: LoadedConnection },
  stream: FreshnessStream,
): UsedRow {
  const checks = app.connection.rows.map(({ row }) => row.checkedAt.getTime());
  const checkedAt = new Date(checks.length ? Math.max(...checks) : 0);
  return {
    connectionId: app.connectionId,
    row: {
      workspaceId,
      connectionId: app.connectionId,
      stream: stream.key,
      resource: app.resource,
      dataThrough: null,
      timeZone: null,
      expectedFrom: null,
      nextExpectedAt: null,
      checkedAt,
      advancedAt: null,
    },
    stream,
    manifest: app.connection.manifest,
    missing: checks.length ? "checked" : "unchecked",
  };
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
 * The least fresh of the rows used (ADR 0025 section 7), and with rows of
 * several connectors each connector's own (`sources`, #784): among periodic
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
  const summary = leastFresh(rows, nextDue, locale);
  if (!summary.freshness) return summary;
  // Rows of several connectors (#784): each one's own summary as well,
  // so screens list every source instead of the least fresh one only.
  const byConnector = new Map<string, UsedRow[]>();
  for (const entry of rows)
    byConnector.set(entry.manifest.id, [
      ...(byConnector.get(entry.manifest.id) ?? []),
      entry,
    ]);
  if (byConnector.size < 2) return summary;
  const sources = [...byConnector.values()]
    .flatMap((group) => {
      const freshness = leastFresh(group, nextDue, locale).freshness;
      return freshness
        ? [
            {
              source: localizedFreshnessSourceName(
                group[0]!.manifest,
                locale,
              ).slice(0, 60),
              ...freshness,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        compareText(a.source, b.source) || compareText(a.stream, b.stream),
    )
    // One per connector, never one left out (the schema bounds it at 50,
    // far above any workspace's connectors of one model).
    .slice(0, 50);
  return sources.length < 2
    ? summary
    : { ...summary, freshness: { ...summary.freshness, sources } };
}

/** The least fresh of the rows used, as `summarizeFreshness` describes. */
function leastFresh(
  rows: readonly UsedRow[],
  nextDue: ReadonlyMap<string, Date | null>,
  locale: Locale,
): WidgetFreshnessResult {
  // Rows with a check time; stand-ins without one alone say nothing.
  const checked = rows.filter((entry) => entry.missing !== "unchecked");
  if (!checked.length) return { overdue: false };
  // A stable order, so equal rows always give the same summary.
  const sorted = [...rows].sort((a, b) =>
    compareText(
      `${a.connectionId}\u0000${a.row.stream}\u0000${a.row.resource}`,
      `${b.connectionId}\u0000${b.row.stream}\u0000${b.row.resource}`,
    ),
  );
  const fetchedAt = Math.min(
    ...checked.map(({ row }) => row.checkedAt.getTime()),
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
    const chosen = checked.reduce((least, entry) =>
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
  read?: ScopeRead,
  choices?: FilterChoices,
): Promise<FreshnessDependency[]> {
  const sources = await modelSourceDatasets(tx, workspaceId, release);
  return sourceFreshnessDependencies(
    tx,
    workspaceId,
    sources.all,
    slideScope,
    exclusions,
    deviceScope,
    read && { ...read, defaultLinks: sources.defaultLinks },
    undefined,
    choices,
  );
}

/**
 * The dashboard's filters with the viewer's choices (#776): what the data
 * rows apply next to the scopes, a filter's chosen value (else its
 * default) and its fixed value.
 */
export interface FilterChoices {
  filters: readonly DashboardDataFilter[];
  values: Readonly<Record<string, DashboardFilterValue>>;
}

/**
 * The streams of a model's datasets. A source dataset resolves to its
 * connection's dataset key, an observation dataset through its metric
 * definition to the metric key. `resources:` and manual datasets have no
 * stream. The resources are the apps of the connection that both the
 * slide's scope, a screen's scope (#500), the viewer's chosen filter
 * values and the dashboard's fixed ones (#776) all pick, as the data rows
 * apply them; a linked product's through the install's mapping table
 * (scopedFreshnessResources, #767), or a Developer Portfolio project's through
 * its links table (#876, `linksDatasetId`). A connection they name no app of adds
 * nothing, and when none picks apps every selected resource counts.
 */
export async function sourceFreshnessDependencies(
  tx: Transaction,
  workspaceId: string,
  ids: ReadonlySet<string>,
  slideScope: SlideFilterScope,
  exclusions: readonly DashboardFilterExclusion[],
  /** A paired screen's fixed scope; it can never be excluded. */
  deviceScope: SlideFilterScope = {},
  /** How to read the mapping a product scope resolves through (#767). */
  read?: ScopeRead,
  /**
   * The widget's own binding filter (#784 review): a fixed app counts as a
   * scope, and on a store template's model a fixed store keeps only that
   * store's connections ("Google Play's proceeds" lists Google Play only).
   */
  bindingFilter?: DataExpression,
  /** The filters' chosen and fixed values, which the rows apply (#776). */
  choices?: FilterChoices,
): Promise<FreshnessDependency[]> {
  const chosen: Record<string, SlideFilterScope[string]> = {},
    fixedValues: Record<string, SlideFilterScope[string]> = {};
  for (const filter of choices?.filters ?? []) {
    const value = Object.hasOwn(choices!.values, filter.id)
      ? choices!.values[filter.id]
      : filter.defaultValue;
    if (value) chosen[filter.id] = value;
    if (filter.fixedValue) fixedValues[filter.id] = filter.fixedValue;
  }
  const fixed = fixedFilterValues(bindingFilter);
  // A fixed value of any field is a scope: values naming apps or products
  // pick their apps; any other value picks nothing and is ignored there.
  const bindingScope: SlideFilterScope = Object.fromEntries(
    [...fixed].map(([fieldId, values]) => [
      `binding:${fieldId}`,
      { kind: "values" as const, values: values as never },
    ]),
  );
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
  const apps = await scopeProductApps(
    tx,
    workspaceId,
    ids,
    [slideScope, deviceScope, bindingScope, chosen, fixedValues],
    read,
  );
  // A fixed store on a store template's model: only its connector's
  // connections (STORE_CONNECTORS, the template's `store` values).
  const stores = fixed.get("store");
  let connectors: Map<string, string> | null = null;
  if (
    stores?.length &&
    stores.every(
      (value) => typeof value === "string" && value in STORE_CONNECTORS,
    ) &&
    found.length &&
    (await isStoreTemplateModel(tx, workspaceId, ids, read))
  )
    connectors = new Map(
      (
        await tx
          .select({
            id: schema.connections.id,
            connectorId: schema.connections.connectorId,
          })
          .from(schema.connections)
          .where(
            and(
              eq(schema.connections.workspaceId, workspaceId),
              notDraftConnection(),
              inArray(schema.connections.id, [
                ...new Set(found.map((entry) => entry.connectionId)),
              ]),
            ),
          )
      ).map((row) => [row.id, row.connectorId]),
    );
  const storeConnectors = new Set(
    (stores ?? []).map((value) => STORE_CONNECTORS[value as string]),
  );
  return found.flatMap(({ connectionId, key, metric }) => {
    if (connectors && !storeConnectors.has(connectors.get(connectionId) ?? ""))
      return [];
    // What each scope picks on this connection; those that pick apps
    // leave the apps all of them pick.
    const picks = [
      scopedFreshnessResources(
        { ...slideScope, ...bindingScope },
        connectionId,
        exclusions,
        apps,
      ),
      scopedFreshnessResources(deviceScope, connectionId, [], apps),
      scopedFreshnessResources(chosen, connectionId, exclusions, apps),
      scopedFreshnessResources(fixedValues, connectionId, exclusions, apps),
    ].filter((picked) => picked !== undefined);
    const resources = picks.length
      ? picks.reduce((left, right) =>
          left.filter((resource) => right.includes(resource)),
        )
      : undefined;
    return (resources ?? [undefined]).map((resource) =>
      metric
        ? { connectionId, metricKey: key, resource }
        : { connectionId, datasetKey: key, resource },
    );
  });
}

/**
 * The store-template model's `store` values and their connectors
 * (store-portfolio: "apple" for App Store Connect, "google" for Google
 * Play), for a widget whose binding fixes the store.
 */
const STORE_CONNECTORS: Readonly<Record<string, string>> = {
  apple: "app-store-connect",
  google: "google-play",
};

/**
 * The values a filter fixes per field: `eq(field, literal)` and
 * `in(field, literals…)`, alone or joined by `and` (others are ignored,
 * which leaves every source as before).
 */
export function fixedFilterValues(
  filter: DataExpression | undefined,
): Map<string, unknown[]> {
  const fixed = new Map<string, unknown[]>();
  const visit = (node: DataExpression) => {
    if (node.kind !== "call") return;
    if (node.fn === "and") {
      for (const arg of node.args) visit(arg);
      return;
    }
    const [first, ...rest] = node.args;
    if (
      (node.fn === "eq" || node.fn === "in") &&
      first?.kind === "field" &&
      rest.length > 0 &&
      (node.fn === "in" || rest.length === 1) &&
      rest.every((arg) => arg.kind === "literal")
    ) {
      const values = rest.map((arg) => (arg as { value: unknown }).value);
      const known = fixed.get(first.fieldId);
      fixed.set(
        first.fieldId,
        known ? known.filter((value) => values.includes(value)) : values,
      );
    }
  };
  if (filter) visit(filter);
  return fixed;
}

/** Whether a model reads a store-template install's mapping table. */
async function isStoreTemplateModel(
  tx: Transaction,
  workspaceId: string,
  ids: ReadonlySet<string>,
  read: ScopeRead | undefined,
): Promise<boolean> {
  const datasets = [...ids].filter((id) => UUID.test(id));
  if (!datasets.length) return false;
  const cache = read?.cache;
  const unknown = datasets.filter((id) => !cache?.isMapping.has(id));
  if (unknown.length) {
    const installs = await tx
      .select({
        mapping: sql<string>`coalesce(${schema.dataTemplateInstalls.result}->>'mappingDatasetId', ${schema.dataTemplateInstalls.result}->>'linksDatasetId')`,
      })
      .from(schema.dataTemplateInstalls)
      .where(
        and(
          eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
          inArray(
            sql`coalesce(${schema.dataTemplateInstalls.result}->>'mappingDatasetId', ${schema.dataTemplateInstalls.result}->>'linksDatasetId')`,
            unknown,
          ),
        ),
      );
    const mappings = new Set(installs.map((install) => install.mapping));
    if (!cache) return mappings.size > 0;
    for (const id of unknown) cache.isMapping.set(id, mappings.has(id));
  }
  return datasets.some((id) => cache?.isMapping.get(id));
}

/** When and under which data policy a scope's mapping table is read. */
export interface ScopeRead {
  now: Date;
  /** The deployment's data policy (NETRICS_DATA_POLICY). */
  defaults?: DataPolicy;
  /**
   * What one response already read (FreshnessReader.scopeMappings): a
   * screen's payload resolves the same products for every widget.
   */
  cache?: ScopeMappingCache;
  /**
   * The default links the model's pinned preparations carry, by links
   * table (modelSourceDatasets, #913): a Developer Portfolio's links table
   * is the customer's over them.
   */
  defaultLinks?: PinnedDefaultLinks;
}

/**
 * The mapping tables one response has read (#767): per dataset id whether
 * it is a store-template install's mapping, and per mapping its products'
 * apps (null: the table is gone or not there yet).
 */
export interface ScopeMappingCache {
  isMapping: Map<string, boolean>;
  products: Map<string, Map<string, string[]> | null>;
  policy?: DataPolicy;
}

export function createScopeMappingCache(): ScopeMappingCache {
  return { isMapping: new Map(), products: new Map() };
}

/** The scope values that name a linked product (store-template-service). */
const PRODUCT_PREFIX = "product:";

const APP_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$/i;

/**
 * The apps of each product a scope names (#767): a store-template app
 * slide's `product:<id>` stands for the apps the install's mapping table
 * maps to it (store-template-products, resolveStoreProducts). The mapping
 * is the one of a store-template install among the model's datasets, read
 * as the model reads it (createDataLoader), under the policy's query
 * timeout. Only `product:` values are resolved; a product no mapping row
 * names maps to nothing, and its filter then picks no apps.
 */
async function scopeProductApps(
  tx: Transaction,
  workspaceId: string,
  ids: ReadonlySet<string>,
  scopes: readonly SlideFilterScope[],
  read: ScopeRead | undefined,
): Promise<Map<string, string[]>> {
  const products = scopeProducts(scopes);
  if (!read || !products.size) return new Map();
  return new Map(
    [...(await mappedProductApps(tx, workspaceId, ids, read))].filter(
      ([product]) => products.has(product),
    ),
  );
}

/** The linked products (`product:<id>`) the scopes' values name. */
export function scopeProducts(
  scopes: readonly SlideFilterScope[],
): Set<string> {
  return new Set(
    scopes.flatMap((scope) =>
      Object.values(scope).flatMap((value) =>
        value.kind === "values"
          ? value.values.filter(
              (raw): raw is string =>
                typeof raw === "string" && raw.startsWith(PRODUCT_PREFIX),
            )
          : [],
      ),
    ),
  );
}

/**
 * Every product and its apps in the mapping tables among `ids`, a model's
 * datasets: what measure widgets' freshness resolves a product scope
 * through (#767), and connection widgets their resource (#777).
 */
export async function mappedProductApps(
  tx: Transaction,
  workspaceId: string,
  ids: ReadonlySet<string>,
  read: ScopeRead,
): Promise<Map<string, string[]>> {
  const apps = new Map<string, string[]>();
  const datasets = [...ids].filter((id) => UUID.test(id));
  if (!datasets.length) return apps;
  const cache = read.cache ?? createScopeMappingCache();
  if (!cache.policy) {
    cache.policy = (
      await resolveDataPolicy(
        tx,
        workspaceId,
        read.defaults ?? DEFAULT_DATA_POLICY,
      )
    ).policy;
  }
  const policy = cache.policy;
  const unknown = datasets.filter((id) => !cache.isMapping.has(id));
  if (unknown.length) {
    for (const id of unknown) cache.isMapping.set(id, false);
    for (const install of await tx
      .select({
        mapping: sql<string>`coalesce(${schema.dataTemplateInstalls.result}->>'mappingDatasetId', ${schema.dataTemplateInstalls.result}->>'linksDatasetId')`,
      })
      .from(schema.dataTemplateInstalls)
      .where(
        and(
          eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
          inArray(
            sql`coalesce(${schema.dataTemplateInstalls.result}->>'mappingDatasetId', ${schema.dataTemplateInstalls.result}->>'linksDatasetId')`,
            unknown,
          ),
        ),
      ))
      cache.isMapping.set(install.mapping, true);
  }
  const mappings = datasets.filter((id) => cache.isMapping.get(id));
  for (const mapping of mappings) {
    // Over the default links of the pinned preparation versions (#913):
    // cached by those pins, as two releases may pin different versions.
    const defaults = read.defaultLinks?.get(mapping);
    const key = defaults ? `${mapping}@${defaults.pins}` : mapping;
    if (!cache.products.has(key)) {
      // The policy's query timeout, as dashboard data reads set it.
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
      );
      cache.products.set(
        key,
        await readMapping(
          tx,
          workspaceId,
          mapping,
          read.now,
          policy,
          defaults?.links,
        ),
      );
    }
    for (const [product, keys] of cache.products.get(key) ?? []) {
      const known = apps.get(product);
      if (known) known.push(...keys);
      else apps.set(product, [...keys]);
    }
  }
  return apps;
}

/**
 * A mapping table's products and their apps; null when it cannot be read.
 * Freshness never fails a widget (#776): a table that is gone or not there
 * yet, and any other read error (a row limit, a timeout) map
 * nothing, so a product scope then leaves every selected resource. Read in
 * a savepoint, so a failed statement does not abort the widget's own.
 *
 * A Developer Portfolio's links table is the customer's over `defaults`,
 * the default links the model's pinned preparations carry (#913): a table
 * row overrides one (an empty project unlinks), so a project's freshness
 * covers the resources its rows read.
 */
async function readMapping(
  tx: Transaction,
  workspaceId: string,
  mapping: string,
  now: Date,
  policy: DataPolicy,
  defaults?: ReadonlyMap<string, string>,
): Promise<Map<string, string[]> | null> {
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.transaction(
      async (savepoint) =>
        (
          await createDataLoader(savepoint, workspaceId, now, {
            policy,
            allowPendingResults: true,
          }).load(mapping)
        ).rows,
    );
  } catch (caught) {
    rethrowWorkspaceGone(caught);
    return null;
  }
  // As resolveStoreProducts: an app's first mapping row decides, over the
  // defaults.
  const effective = new Map(defaults ?? []),
    seen = new Set<string>();
  for (const row of rows) {
    const key = row.app_key,
      product = row.product_id;
    if (typeof key !== "string" || typeof product !== "string") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    effective.set(key, product);
  }
  // One array per product, appended in place.
  const products = new Map<string, string[]>();
  for (const [key, product] of effective) {
    if (!product.startsWith(PRODUCT_PREFIX) || !APP_KEY.test(key)) continue;
    const keys = products.get(product);
    if (keys) keys.push(key);
    else products.set(product, [key]);
  }
  return products;
}
