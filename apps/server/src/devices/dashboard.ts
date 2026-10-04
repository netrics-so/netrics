import { createHash } from "node:crypto";

import {
  DEVICE_REFRESH_AFTER_SECONDS,
  barWidgetOptionsSchema,
  clockWidgetOptionsSchema,
  compareWidgetOptionsSchema,
  countdownWidgetOptionsSchema,
  gaugeWidgetOptionsSchema,
  imageWidgetOptionsSchema,
  lineWidgetOptionsSchema,
  metricWidgetOptionsSchema,
  statusWidgetOptionsSchema,
  tableWidgetOptionsSchema,
  textWidgetOptionsSchema,
  themeTokensSchema,
  type ConnectionStateView,
  type DeviceDashboardResponse,
  type DeviceDashboardV2Response,
  type DeviceDashboardV3Response,
  type DeviceImage,
  type DeviceSlide,
  type DeviceStatusData,
  type DeviceTile,
  type DeviceTileStatus,
  type DeviceWidget,
  type ImageContentType,
  type MetricAggregation,
  type MetricBreakdownResponse,
  type MetricPeriod,
  type MetricQueryRequest,
  type MetricQueryResponse,
} from "@netrics/contracts";
import {
  findBackfillingConnectionIds,
  findDashboard,
  findGoalsByIds,
  findImages,
  findResourceNames,
  findTheme,
  findWorkspace,
  listConnections,
  resourceNameKey,
  schema1Tiles,
  type Dashboard,
  type DashboardWidgetRow,
  type GoalRow,
  type Transaction,
} from "@netrics/database";
import {
  BUILTIN_THEMES,
  DEFAULT_LOCALE,
  DEFAULT_THEME_KEY,
  EXCHANGE_RATE_SOURCE,
  RESOURCE_DIMENSION,
  SCREEN_FORMATS,
  STUDIO_GRID,
  STUDIO_MIN_WIDGET_SIZE,
  amountCurrency,
  compareRatioUnit,
  countdownLabel,
  isBuiltinThemeKey,
  isScreenFormat,
  slideLayoutFor,
  zonedInstant,
  type CustomLayout,
  type LayoutWidget,
  type ScreenFormat,
  isDataWidgetType,
  sortSourceItems,
  sourceItemStatus,
  sourcesLabel,
  ratioOf,
  goalLabel,
  goalPeriodEnd,
  tileLabel,
  zonedIsoString,
  type GoalAggregation,
  type GoalPeriod,
  type Locale,
  type ThemeTokens,
} from "@netrics/domain";

import { toStateView } from "../connections/present.js";
import { readGoal } from "../goals/progress.js";
import {
  findAllResourcesNames,
  queryMetric,
  queryMetricBreakdown,
  tileAllResourcesName,
  type QueryOptions,
} from "../metrics/query.js";

// The device dashboard read model (ADR 0007, #57), computed by the same
// metric query service as the web dashboard.
//
// Schema 1 (ADR 0015 section 7): the tiles are the metric widgets of the
// enabled slides in reading order, at most 24; for a migrated tile
// dashboard exactly its tiles as before, byte for byte.
//
// Schema 2 (#219): the enabled slides with every widget, its placement and
// computed data, the resolved theme, rotation and the referenced images,
// in the `16x9` layout (ADR 0017 section 9).
//
// Schema 3 (#277): schema 2's content with the primary placements, the
// custom layouts of other formats and the device's settings; every screen
// lays the dashboard out for its own format.

/**
 * Data older than this many poll intervals (at least 15 minutes) is stale.
 * The web tile uses the same rule.
 */
const STALE_AFTER_INTERVALS = 3;
const MIN_STALE_MS = 15 * 60 * 1000;

export interface TileErrorLogger {
  warn(details: { tileId: string; err: unknown }, message: string): void;
}

export interface BuildOptions {
  now: Date;
  log?: TileErrorLogger;
  /** NETRICS_EXCHANGE_RATES: display-currency conversion (#191). */
  exchangeRates?: boolean;
  /**
   * The screen language (ADR 0016): labels are built in it, and the
   * payload names it in `locale`. English when absent.
   */
  locale?: Locale;
}

export function tileStatus(
  state: ConnectionStateView | null,
  hasData: boolean,
  now: Date,
  /** A backfill of the connection's history is queued or running. */
  backfilling = false,
): DeviceTileStatus {
  if (state?.health === "auth_failed" || state?.health === "outage") {
    return state.health;
  }
  // Screens know auth_failed; a grant that needs reauthorization is the same
  // story for a viewer (the tvOS status set stays unchanged, ADR 0007).
  if (state?.health === "needs_reauthorization") {
    return "auth_failed";
  }
  if (!state || !hasData) {
    // Nothing yet while the history loads: the first sync has not
    // succeeded (pending), or a backfill is queued or running (#311).
    return state && (state.health === "pending" || backfilling)
      ? "backfilling"
      : "no_data";
  }
  if (!state.lastSuccessAt) {
    return "stale";
  }
  const age = now.getTime() - new Date(state.lastSuccessAt).getTime();
  const limit = Math.max(
    STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    MIN_STALE_MS,
  );
  return age > limit ? "stale" : "ok";
}

/** A stable hash of the content: equal payloads get equal versions. */
function versionOf(content: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(content))
    .digest("base64url")
    .slice(0, 32);
}

/** A metric, line or bar widget with its data binding. */
type DataWidget = DashboardWidgetRow & {
  connectionId: string;
  metricKey: string;
  period: string;
  aggregation: string;
};

function isDataWidget(widget: DashboardWidgetRow): widget is DataWidget {
  return (
    isDataWidgetType(widget.type) &&
    widget.connectionId !== null &&
    widget.metricKey !== null &&
    widget.period !== null &&
    widget.aggregation !== null
  );
}

function dimensionsOf(widget: DashboardWidgetRow): Record<string, string> {
  return widget.dimensions as Record<string, string>;
}

/**
 * What every data widget of one payload shares: connection health and the
 * names its labels use, each loaded once.
 */
interface DataContext {
  workspaceId: string;
  options: BuildOptions;
  states: Map<string, ConnectionStateView>;
  /**
   * Every connection of the workspace as a status board lists it (ADR
   * 0019 section 7), from the same query as `states`: shared by all
   * boards of the payload.
   */
  sources: DeviceStatusData["items"];
  /** Connections with a backfill queued or running. */
  backfilling: Set<string>;
  label(widget: DataWidget, metricName: string | undefined): string;
}

async function loadDataContext(
  tx: Transaction,
  workspaceId: string,
  widgets: readonly DataWidget[],
  options: BuildOptions,
): Promise<DataContext> {
  const connections = await listConnections(tx, workspaceId);
  const states = new Map(
    connections.map(({ row, state }) => [row.id, toStateView(state)]),
  );
  const backfilling = await findBackfillingConnectionIds(tx, workspaceId);
  // Only what a board shows: never credentials, configuration or errors.
  const sources = sortSourceItems(
    connections.map(({ row }) => {
      const state = states.get(row.id)!;
      return {
        connectionId: row.id,
        name: row.name,
        status: sourceItemStatus(
          {
            health: state.health,
            lastSuccessAt: state.lastSuccessAt,
            pollIntervalSeconds: state.pollIntervalSeconds,
            setupPending: row.setupPending,
            backfilling: backfilling.has(row.id),
          },
          options.now.getTime(),
        ),
        lastSuccessAt: state.lastSuccessAt,
      };
    }),
  );
  // Widgets of one resource are labelled with its name (#194).
  const resourceNames = await findResourceNames(
    tx,
    workspaceId,
    widgets.flatMap((widget) => {
      const resourceId = dimensionsOf(widget)[RESOURCE_DIMENSION];
      return resourceId === undefined
        ? []
        : [{ connectionId: widget.connectionId, resourceId }];
    }),
  );
  // Widgets of several resources added up say so: "All apps" (#208).
  const scopes = await findAllResourcesNames(
    tx,
    workspaceId,
    widgets.map((widget) => ({
      connectionId: widget.connectionId,
      metricKey: widget.metricKey,
      dimensions: dimensionsOf(widget),
    })),
    options.locale,
  );
  return {
    workspaceId,
    options,
    states,
    sources,
    backfilling,
    label(widget, metricName) {
      const dimensions = dimensionsOf(widget);
      const resourceId = dimensions[RESOURCE_DIMENSION];
      // The metric name comes from the metric query, in the screen
      // language when the connector translates it (#257).
      return tileLabel({
        title: widget.title,
        metricName: metricName ?? widget.metricKey,
        dimensions,
        resourceName:
          resourceId === undefined
            ? null
            : (resourceNames.get(
                resourceNameKey(widget.connectionId, resourceId),
              ) ?? null),
        allResourcesName: tileAllResourcesName(scopes, {
          connectionId: widget.connectionId,
          metricKey: widget.metricKey,
          dimensions,
        }),
      });
    },
  };
}

function queryOptions(options: BuildOptions): QueryOptions {
  return {
    exchangeRates: options.exchangeRates ?? false,
    ...(options.locale ? { locale: options.locale } : {}),
  };
}

function metricRequest(
  widget: DataWidget,
): MetricQueryRequest & { aggregation: MetricAggregation } {
  const dimensions = dimensionsOf(widget);
  return {
    connectionId: widget.connectionId,
    metricKey: widget.metricKey,
    period: widget.period as MetricPeriod,
    aggregation: widget.aggregation as MetricAggregation,
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    ...(widget.displayCurrency
      ? { displayCurrency: widget.displayCurrency }
      : {}),
  };
}

/**
 * Runs one widget's query in a savepoint: a failing query must not abort
 * the others. A failure (an error or a refused query) is null.
 */
async function guarded<T>(
  tx: Transaction,
  widget: DataWidget,
  context: DataContext,
  query: (
    savepoint: Transaction,
  ) => Promise<{ ok: true; value: T } | { ok: false }>,
): Promise<T | null> {
  const result = await tx
    .transaction((savepoint) => query(savepoint))
    .catch((err: unknown) => {
      context.options.log?.warn(
        { tileId: widget.id, err },
        "device tile failed",
      );
      return null;
    });
  return result?.ok ? result.value : null;
}

function queryWidget(
  tx: Transaction,
  widget: DataWidget,
  context: DataContext,
): Promise<MetricQueryResponse | null> {
  return guarded(tx, widget, context, (savepoint) =>
    queryMetric(
      savepoint,
      context.workspaceId,
      metricRequest(widget),
      context.options.now,
      queryOptions(context.options),
    ),
  );
}

function conversionOf(
  conversion: MetricQueryResponse["conversion"],
): DeviceTile["conversion"] {
  return conversion
    ? {
        displayCurrency: conversion.displayCurrency,
        source: EXCHANGE_RATE_SOURCE.name,
        unconverted: conversion.unconverted.map((entry) => ({
          currency: entry.currency,
          value: entry.value,
        })),
      }
    : null;
}

/**
 * A per-currency amount as its currency's "<ISO>_minor" unit (ADR 0008),
 * which screens already format.
 */
function unitOf(
  query: Pick<MetricQueryResponse, "currency" | "metric"> | null,
): string | null {
  return query
    ? query.currency
      ? `${query.currency}_minor`
      : query.metric.unit
    : null;
}

/** A schema 1 tile; its field order is part of the recorded payloads. */
function tileOf(
  widget: DataWidget,
  query: MetricQueryResponse | null,
  context: DataContext,
): DeviceTile {
  const request = metricRequest(widget);
  const state = context.states.get(widget.connectionId) ?? null;
  const value = query?.value ?? null;
  return {
    id: widget.id,
    // The label stays the tile's title: screens mark converted amounts
    // from `conversion` (#191).
    label: context.label(widget, query?.metric.name),
    period: request.period,
    aggregation: query?.aggregation ?? request.aggregation,
    value,
    unit: unitOf(query),
    conversion: conversionOf(query?.conversion ?? null),
    change: {
      previousValue: query?.previousValue ?? null,
      delta: query?.delta ?? null,
      ratio: query?.ratio ?? null,
    },
    spark: query?.series.map((point) => point.value) ?? [],
    kind: query?.metric.kind ?? null,
    granularity: query?.metric.granularity ?? null,
    better: query?.metric.better ?? "higher",
    status: tileStatus(
      state,
      value !== null,
      context.options.now,
      context.backfilling.has(widget.connectionId),
    ),
    updatedAt: state?.lastSuccessAt ?? null,
  };
}

/**
 * Builds the schema 1 read model inside the device's workspace
 * transaction. A tile that fails to compute reports `no_data` (or its
 * connection's failure); it never fails the whole dashboard.
 */
export async function buildDeviceDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: BuildOptions,
): Promise<DeviceDashboardResponse> {
  const workspace = await findWorkspace(tx, workspaceId);
  const dashboard = dashboardId
    ? await findDashboard(tx, workspaceId, dashboardId)
    : null;
  const tiles: DeviceTile[] = [];
  if (dashboard) {
    const sources = schema1Tiles(dashboard.slides).filter(isDataWidget);
    const context = await loadDataContext(tx, workspaceId, sources, options);
    for (const tile of sources) {
      tiles.push(tileOf(tile, await queryWidget(tx, tile, context), context));
    }
  }
  const locale = options.locale ?? DEFAULT_LOCALE;
  const content = {
    refreshAfterSec: DEVICE_REFRESH_AFTER_SECONDS,
    timeZone: workspace?.timeZone ?? "UTC",
    dashboard: dashboard ? { id: dashboard.id, name: dashboard.name } : null,
    tiles,
    // Only when not English: an English payload stays byte for byte what
    // screens got before (#214), and screens read a missing one as "en".
    ...(locale !== DEFAULT_LOCALE ? { locale } : {}),
  };
  return { version: versionOf(content), ...content };
}

// ─── Schema 2 ───────────────────────────────────────────────────────────────

/** Stored options with the type's defaults; unreadable ones fall back. */
function parsedOptions<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  options: unknown,
  fallback: unknown = {},
): T {
  const parsed = schema.safeParse(options);
  return parsed.success
    ? (parsed.data as T)
    : (schema.safeParse(fallback).data as T);
}

/** The dashboard's theme with its brand accent applied (ADR 0015 §6). */
async function resolveTheme(
  tx: Transaction,
  workspaceId: string,
  dashboard: Dashboard | null,
): Promise<DeviceDashboardV2Response["theme"]> {
  let name = BUILTIN_THEMES[DEFAULT_THEME_KEY].name;
  let tokens: ThemeTokens = BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens;
  if (dashboard?.themeId) {
    const row = await findTheme(tx, workspaceId, dashboard.themeId);
    const parsed = row ? themeTokensSchema.safeParse(row.tokens) : null;
    if (row && parsed?.success) {
      name = row.name;
      tokens = parsed.data as ThemeTokens;
    }
  } else if (
    dashboard?.themeBuiltin &&
    isBuiltinThemeKey(dashboard.themeBuiltin)
  ) {
    ({ name, tokens } = BUILTIN_THEMES[dashboard.themeBuiltin]);
  }
  return {
    name,
    tokens: dashboard?.accentColor
      ? { ...tokens, accent: dashboard.accentColor }
      : { ...tokens },
  };
}

async function dataWidgetOf(
  tx: Transaction,
  widget: DataWidget,
  context: DataContext,
): Promise<DeviceWidget> {
  const placement = {
    id: widget.id,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
  };
  const state = context.states.get(widget.connectionId) ?? null;
  if (widget.type === "bar") {
    const options = parsedOptions(barWidgetOptionsSchema, widget.options, {
      groupBy: RESOURCE_DIMENSION,
    });
    const request = metricRequest(widget);
    const breakdown: MetricBreakdownResponse | null = await guarded(
      tx,
      widget,
      context,
      (savepoint) =>
        queryMetricBreakdown(
          savepoint,
          context.workspaceId,
          { ...request, groupBy: options.groupBy, limit: options.limit },
          context.options.now,
          queryOptions(context.options),
        ),
    );
    const hasData =
      breakdown !== null &&
      (breakdown.groups.length > 0 || breakdown.others !== null);
    return {
      type: "bar",
      ...placement,
      label: context.label(widget, breakdown?.metric.name),
      options,
      data: {
        period: request.period,
        aggregation: breakdown?.aggregation ?? request.aggregation,
        unit: unitOf(breakdown),
        conversion: conversionOf(breakdown?.conversion ?? null),
        kind: breakdown?.metric.kind ?? null,
        granularity: breakdown?.metric.granularity ?? null,
        better: breakdown?.metric.better ?? "higher",
        status: tileStatus(
          state,
          hasData,
          context.options.now,
          context.backfilling.has(widget.connectionId),
        ),
        updatedAt: state?.lastSuccessAt ?? null,
        groupBy: options.groupBy,
        bars: breakdown?.groups ?? [],
        others: breakdown?.others ?? null,
      },
    };
  }
  if (widget.type === "table") {
    return tableWidgetOf(tx, widget, context, placement, state);
  }
  if (widget.type === "compare") {
    return compareWidgetOf(tx, widget, context, placement);
  }
  const query = await queryWidget(tx, widget, context);
  const { id: _id, label, ...tile } = tileOf(widget, query, context);
  if (widget.type === "line") {
    const options = parsedOptions(lineWidgetOptionsSchema, widget.options);
    const { spark, ...data } = tile;
    return {
      type: "line",
      ...placement,
      label,
      options,
      data: {
        ...data,
        buckets: query?.series.map((point) => point.bucket) ?? [],
        values: spark,
        previous: options.showPrevious
          ? (query?.previousSeries.map((point) => point.value) ?? [])
          : [],
      },
    };
  }
  return {
    type: "metric",
    ...placement,
    label,
    options: parsedOptions(metricWidgetOptionsSchema, widget.options),
    data: tile,
  };
}

/**
 * A table widget (ADR 0019 section 6): the breakdown of its metric over the
 * current window, each group with its value over the previous window (a
 * second grouped query restricted to the groups returned, same
 * aggregation, conversion and names), and the column heads in the
 * payload's language. "Others" only with `showOthers`.
 */
async function tableWidgetOf(
  tx: Transaction,
  widget: DataWidget,
  context: DataContext,
  placement: { id: string; x: number; y: number; w: number; h: number },
  state: ConnectionStateView | null,
): Promise<DeviceWidget> {
  const options = parsedOptions(tableWidgetOptionsSchema, widget.options, {
    groupBy: RESOURCE_DIMENSION,
  });
  const request = metricRequest(widget);
  const breakdown: MetricBreakdownResponse | null = await guarded(
    tx,
    widget,
    context,
    (savepoint) =>
      queryMetricBreakdown(
        savepoint,
        context.workspaceId,
        {
          ...request,
          groupBy: options.groupBy,
          limit: options.limit,
          withPrevious: options.showChange,
        },
        context.options.now,
        queryOptions(context.options),
      ),
  );
  const others = options.showOthers ? (breakdown?.others ?? null) : null;
  const hasData =
    breakdown !== null && (breakdown.groups.length > 0 || others !== null);
  const metricName = breakdown?.metric.name ?? widget.metricKey;
  return {
    type: "table",
    ...placement,
    label: context.label(widget, breakdown?.metric.name),
    options,
    data: {
      period: request.period,
      aggregation: breakdown?.aggregation ?? request.aggregation,
      unit: unitOf(breakdown),
      conversion: conversionOf(breakdown?.conversion ?? null),
      kind: breakdown?.metric.kind ?? null,
      granularity: breakdown?.metric.granularity ?? null,
      better: breakdown?.metric.better ?? "higher",
      status: tileStatus(
        state,
        hasData,
        context.options.now,
        context.backfilling.has(widget.connectionId),
      ),
      updatedAt: state?.lastSuccessAt ?? null,
      groupBy: options.groupBy,
      columns: {
        label: breakdown?.groupByName ?? options.groupBy,
        value: metricName,
      },
      rows: (breakdown?.groups ?? []).map((group) => ({
        key: group.key,
        label: group.label,
        value: group.value,
        previousValue: group.previousValue ?? null,
        ratio: group.ratio ?? null,
      })),
      others,
    },
  };
}

/**
 * A status board (ADR 0019 section 7): the workspace's sources, or the
 * chosen ones (a connection deleted since is left out), attention first,
 * from the payload's one connection query. Always `ok`: the board is the
 * status display; no sources reads "No sources connected" on screens.
 */
function statusWidgetOf(
  widget: DashboardWidgetRow,
  placement: { id: string; x: number; y: number; w: number; h: number },
  context: DataContext,
): DeviceWidget {
  const options = parsedOptions(statusWidgetOptionsSchema, widget.options);
  const chosen = options.connectionIds ? new Set(options.connectionIds) : null;
  return {
    type: "status",
    ...placement,
    label: widget.title ?? sourcesLabel(context.options.locale),
    options,
    data: {
      status: "ok",
      items: chosen
        ? context.sources.filter((item) => chosen.has(item.connectionId))
        : context.sources,
    },
  };
}

/** Worst last: a compare widget shows the worse of its two sides. */
const STATUS_SEVERITY: readonly DeviceTileStatus[] = [
  "ok",
  "stale",
  "backfilling",
  "no_data",
  "outage",
  "auth_failed",
];

function worseStatus(
  a: DeviceTileStatus,
  b: DeviceTileStatus,
): DeviceTileStatus {
  return STATUS_SEVERITY.indexOf(a) >= STATUS_SEVERITY.indexOf(b) ? a : b;
}

/** The older of two sync times; null when either side never synced. */
function olderSync(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/**
 * A compare widget (ADR 0019 section 10): two metric queries over the
 * widget's period (the numerator's binding and the denominator's), and
 * their ratio by `ratioOf`, now and over the previous period. The status
 * is the worse side's and `updatedAt` the older side's; the shared fields
 * describe the ratio (`unit` null, or the currency of an amount per unit).
 * Two amounts that came back in different currencies have no ratio.
 */
async function compareWidgetOf(
  tx: Transaction,
  widget: DataWidget,
  context: DataContext,
  placement: { id: string; x: number; y: number; w: number; h: number },
): Promise<DeviceWidget> {
  const options = parsedOptions(compareWidgetOptionsSchema, widget.options);
  const denominatorWidget: DataWidget | null =
    widget.denominatorConnectionId !== null &&
    widget.denominatorMetricKey !== null &&
    widget.denominatorAggregation !== null
      ? {
          ...widget,
          connectionId: widget.denominatorConnectionId,
          metricKey: widget.denominatorMetricKey,
          aggregation: widget.denominatorAggregation,
          dimensions: widget.denominatorDimensions,
        }
      : null;
  const numerator = await queryWidget(tx, widget, context);
  const denominator = denominatorWidget
    ? await queryWidget(tx, denominatorWidget, context)
    : null;
  const side = (
    binding: DataWidget | null,
    query: MetricQueryResponse | null,
  ) => {
    const state = binding
      ? (context.states.get(binding.connectionId) ?? null)
      : null;
    const value = query?.value ?? null;
    return {
      operand: {
        label: query?.metric.name ?? binding?.metricKey ?? widget.metricKey,
        value,
        unit: unitOf(query),
      },
      previousValue: query?.previousValue ?? null,
      status: tileStatus(
        state,
        value !== null,
        context.options.now,
        binding ? context.backfilling.has(binding.connectionId) : false,
      ),
      updatedAt: state?.lastSuccessAt ?? null,
    };
  };
  const a = side(widget, numerator);
  const b = side(denominatorWidget, denominator);
  // Amounts over amounts must be in one currency to have a ratio.
  const currencyA = a.operand.unit ? amountCurrency(a.operand.unit) : null;
  const currencyB = b.operand.unit ? amountCurrency(b.operand.unit) : null;
  const comparable =
    currencyB === null || (currencyA !== null && currencyA === currencyB);
  const request = metricRequest(widget);
  return {
    type: "compare",
    ...placement,
    label: context.label(widget, numerator?.metric.name),
    options,
    data: {
      period: request.period,
      aggregation: numerator?.aggregation ?? request.aggregation,
      unit: compareRatioUnit(a.operand.unit, b.operand.unit),
      conversion: conversionOf(
        numerator?.conversion ?? denominator?.conversion ?? null,
      ),
      kind: numerator?.metric.kind ?? null,
      granularity: numerator?.metric.granularity ?? null,
      better: numerator?.metric.better ?? "higher",
      status: worseStatus(a.status, b.status),
      updatedAt: olderSync(a.updatedAt, b.updatedAt),
      numerator: a.operand,
      denominator: b.operand,
      ratio: {
        value: comparable ? ratioOf(a.operand.value, b.operand.value) : null,
        previousValue: comparable
          ? ratioOf(a.previousValue, b.previousValue)
          : null,
        format: options.format,
      },
    },
  };
}

/**
 * A goal widget (ADR 0019 section 5): its goal's metric read over the
 * goal's current period and where the goal stands, with the shared data
 * fields of that metric. Screens word the time left themselves. A deleted
 * goal is `goal: null` with status `no_data` ("Goal deleted").
 */
async function gaugeWidgetOf(
  tx: Transaction,
  widget: DashboardWidgetRow,
  goal: GoalRow | null,
  context: DataContext,
  timeZone: string,
): Promise<DeviceWidget> {
  const placement = {
    id: widget.id,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
  };
  const options = parsedOptions(gaugeWidgetOptionsSchema, widget.options);
  const locale = context.options.locale ?? DEFAULT_LOCALE;
  if (goal === null) {
    return {
      type: "gauge",
      ...placement,
      label: widget.title ?? goalLabel(locale),
      options,
      data: {
        period: null,
        aggregation: null,
        unit: null,
        conversion: null,
        kind: null,
        granularity: null,
        better: "higher",
        status: "no_data",
        updatedAt: null,
        goal: null,
        value: null,
        target: null,
        progress: null,
        reachedAt: null,
        periodEnd: null,
      },
    };
  }
  const now = context.options.now;
  const period = goal.period as GoalPeriod;
  const reading = await readGoal(tx, context.workspaceId, goal, now, {
    exchangeRates: context.options.exchangeRates ?? false,
    locale,
  });
  const state = context.states.get(goal.connectionId) ?? null;
  const value = reading?.progress.value ?? null;
  return {
    type: "gauge",
    ...placement,
    label: widget.title ?? goal.name,
    options,
    data: {
      period,
      aggregation: goal.aggregation as GoalAggregation,
      unit: unitOf(reading?.read ?? null),
      conversion: conversionOf(reading?.read.conversion ?? null),
      kind: reading?.read.metric.kind ?? null,
      granularity: reading?.read.metric.granularity ?? null,
      better: reading?.read.metric.better ?? "higher",
      status: tileStatus(
        state,
        value !== null,
        now,
        context.backfilling.has(goal.connectionId),
      ),
      updatedAt: state?.lastSuccessAt ?? null,
      goal: { id: goal.id, name: goal.name },
      value,
      target: goal.target,
      progress: reading?.progress.progress ?? null,
      reachedAt: reading?.progress.reachedAt ?? null,
      periodEnd:
        reading?.progress.periodEnd ??
        zonedIsoString(goalPeriodEnd(period, now, timeZone), timeZone),
    },
  };
}

/** A built slide: its device form, before any layout is applied. */
interface BuiltSlide {
  slide: Dashboard["slides"][number];
  /** The slide without widgets, in the field order of the payload. */
  head: Omit<DeviceSlide, "widgets">;
  /** In the primary's reading order, placed in the primary's grid. */
  widgets: DeviceWidget[];
}

/** What schemas 2 and 3 share: every enabled slide with computed data. */
interface BuiltDashboard {
  dashboard: Dashboard | null;
  primaryFormat: ScreenFormat;
  timeZone: string;
  locale: Locale;
  header: DeviceDashboardV2Response["dashboard"];
  theme: DeviceDashboardV2Response["theme"];
  rotation: DeviceDashboardV2Response["rotation"];
  slides: BuiltSlide[];
  images: DeviceImage[];
}

/**
 * Loads the dashboard and computes every widget of its enabled slides,
 * inside the device's workspace transaction. Data widgets are computed like
 * schema 1 tiles: one that fails reports `no_data` (or its connection's
 * failure) and never fails the payload.
 */
async function buildSlides(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: BuildOptions,
): Promise<BuiltDashboard> {
  const workspace = await findWorkspace(tx, workspaceId);
  const timeZone = workspace?.timeZone ?? "UTC";
  const dashboard = dashboardId
    ? await findDashboard(tx, workspaceId, dashboardId)
    : null;
  const slides = (dashboard?.slides ?? []).filter((slide) => slide.enabled);

  // Only images that exist in the workspace are referenced (the foreign
  // keys make that certain; this keeps the payload consistent regardless).
  const imageRows = await findImages(tx, workspaceId, [
    ...new Set(
      [
        dashboard?.logoImageId ?? null,
        ...slides.flatMap((slide) => [
          slide.backgroundImageId,
          ...slide.widgets.map((widget) =>
            widget.type === "image" ? widget.imageId : null,
          ),
        ]),
      ].filter((id): id is string => id !== null),
    ),
  ]);
  const images: DeviceImage[] = imageRows
    .map((row) => ({
      id: row.id,
      sha256: row.sha256,
      contentType: row.contentType as ImageContentType,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      url: `/v1/device/images/${row.id}?v=${row.sha256}`,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const known = new Set(images.map((image) => image.id));
  const imageRef = (id: string | null) =>
    id !== null && known.has(id) ? id : null;

  const context = await loadDataContext(
    tx,
    workspaceId,
    slides.flatMap((slide) => slide.widgets.filter(isDataWidget)),
    options,
  );
  // The goals of the goal widgets; an id not found is a deleted goal.
  const goals = await findGoalsByIds(
    tx,
    workspaceId,
    slides.flatMap((slide) =>
      slide.widgets.flatMap((widget) =>
        widget.type === "gauge" && widget.goalId !== null
          ? [widget.goalId]
          : [],
      ),
    ),
  );
  const built: BuiltSlide[] = [];
  for (const slide of slides) {
    const widgets: DeviceWidget[] = [];
    for (const widget of slide.widgets) {
      const placement = {
        id: widget.id,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      };
      if (isDataWidget(widget)) {
        widgets.push(await dataWidgetOf(tx, widget, context));
      } else if (widget.type === "gauge") {
        const goal =
          widget.goalId === null ? null : (goals.get(widget.goalId) ?? null);
        widgets.push(await gaugeWidgetOf(tx, widget, goal, context, timeZone));
      } else if (widget.type === "image") {
        const imageId = imageRef(widget.imageId);
        if (imageId !== null) {
          widgets.push({
            type: "image",
            ...placement,
            label: widget.title,
            imageId,
            options: parsedOptions(imageWidgetOptionsSchema, widget.options),
          });
        }
      } else if (widget.type === "text") {
        widgets.push({
          type: "text",
          ...placement,
          label: widget.title,
          text: widget.text ?? "",
          options: parsedOptions(textWidgetOptionsSchema, widget.options),
        });
      } else if (widget.type === "status") {
        widgets.push(statusWidgetOf(widget, placement, context));
      } else if (widget.type === "clock") {
        const { dateStyle, showZone, ...clock } = parsedOptions(
          clockWidgetOptionsSchema,
          widget.options,
        );
        widgets.push({
          type: "clock",
          ...placement,
          label: widget.title,
          options: {
            ...clock,
            timeZone: clock.timeZone ?? timeZone,
            // Only when set (ADR 0019 §9): an existing clock's payload and
            // version stay as they were.
            ...(dateStyle === "short" ? {} : { dateStyle }),
            ...(showZone ? { showZone } : {}),
          },
        });
      } else if (widget.type === "countdown") {
        // ADR 0019 section 8: the target resolved to an instant once, so
        // screens count down from their own clock and the payload (and its
        // version) never changes with time.
        // Options that do not parse (never stored by the API) leave it out.
        const countdown = countdownWidgetOptionsSchema.safeParse(
          widget.options,
        ).data;
        const zone = countdown?.timeZone ?? timeZone;
        const targetAt = countdown
          ? zonedInstant(countdown.target, zone)
          : null;
        if (countdown && targetAt !== null) {
          widgets.push({
            type: "countdown",
            ...placement,
            label: countdownLabel(
              widget.title,
              options.locale ?? DEFAULT_LOCALE,
            ),
            options: {
              ...countdown,
              timeZone: zone,
              targetAt: targetAt.toISOString(),
            },
          });
        }
      }
    }
    const background = imageRef(slide.backgroundImageId);
    built.push({
      slide,
      head: {
        id: slide.id,
        name: slide.name,
        durationSec: slide.durationSeconds ?? dashboard!.defaultSlideSeconds,
        background:
          background !== null
            ? { imageId: background, dim: slide.backgroundDim }
            : null,
      },
      widgets,
    });
  }

  const logo = imageRef(dashboard?.logoImageId ?? null);
  return {
    dashboard,
    primaryFormat: isScreenFormat(dashboard?.primaryFormat)
      ? dashboard.primaryFormat
      : "16x9",
    timeZone,
    locale: options.locale ?? DEFAULT_LOCALE,
    header: dashboard
      ? {
          id: dashboard.id,
          name: dashboard.name,
          showHeader: dashboard.showHeader,
          logo: logo !== null ? { imageId: logo } : null,
        }
      : null,
    theme: await resolveTheme(tx, workspaceId, dashboard),
    rotation: {
      autoAdvance: dashboard?.autoAdvance ?? true,
      transition: (dashboard?.transition ??
        "fade") as DeviceDashboardV2Response["rotation"]["transition"],
    },
    slides: built,
    images,
  };
}

/** The payload's widgets of a slide as input to the domain's layouts. */
function layoutWidgets(widgets: readonly DeviceWidget[]): LayoutWidget[] {
  return widgets.map(({ id, type, x, y, w, h }) => ({ id, type, x, y, w, h }));
}

/**
 * A slide's custom layout of `format` for the given widgets: placements of
 * widgets that are not in the payload (an image widget whose image is
 * gone) are left out, so every screen lays out exactly what it got.
 */
function customLayoutOf(
  slide: Dashboard["slides"][number],
  format: ScreenFormat,
  widgetIds: ReadonlySet<string>,
): CustomLayout | null {
  const layout = slide.layouts.find((entry) => entry.format === format);
  return layout
    ? {
        pages: layout.pages,
        placements: layout.placements
          .filter((placement) => widgetIds.has(placement.widgetId))
          .map(({ widgetId, ...placement }) => ({
            id: widgetId,
            ...placement,
          })),
      }
    : null;
}

/** Fixed namespace of continuation-page slide ids (UUID version 5). */
const PAGE_SLIDE_NAMESPACE = "1c8f8a4e-6f43-4b0a-9a51-5e3d2b7c9d10";

/**
 * A name-based UUID (RFC 9562 version 5) of a slide's continuation page:
 * the same slide and page always get the same id, so screens keep showing
 * it across payloads.
 */
export function pageSlideId(slideId: string, page: number): string {
  const namespace = Buffer.from(PAGE_SLIDE_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(namespace)
    .update(`${slideId}/${page}`)
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A slide in the `16x9` layout for schema 2 (ADR 0017 section 9): as built
 * when the primary is `16x9`, else its custom or auto `16x9` layout, each
 * continuation page an extra slide ("Sales 1/2", "Sales 2/2") whose id is
 * name-based on the slide id and page. Hidden widgets are left out.
 */
function slidesIn16x9(
  built: BuiltSlide,
  primaryFormat: ScreenFormat,
): DeviceSlide[] {
  if (primaryFormat === "16x9") {
    return [{ ...built.head, widgets: built.widgets }];
  }
  const byId = new Map(built.widgets.map((widget) => [widget.id, widget]));
  const pages = slideLayoutFor({
    widgets: layoutWidgets(built.widgets),
    primaryFormat,
    format: "16x9",
    custom: customLayoutOf(built.slide, "16x9", new Set(byId.keys())),
  });
  return pages.map((page, index) => ({
    ...built.head,
    id: index === 0 ? built.head.id : pageSlideId(built.head.id, index),
    name:
      pages.length === 1
        ? built.head.name
        : [built.head.name, `${index + 1}/${pages.length}`]
            .filter((part) => part !== null && part !== "")
            .join(" "),
    widgets: page.flatMap(({ id, x, y, w, h }) => {
      const widget = byId.get(id);
      return widget ? [{ ...widget, x, y, w, h }] : [];
    }),
  }));
}

/**
 * Builds the schema 2 read model inside the device's workspace
 * transaction: the dashboard in its `16x9` layout, as released screens
 * know it. For a `16x9` dashboard (every dashboard before ADR 0017) it is
 * byte for byte what it was.
 */
export async function buildDeviceDashboardV2(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: BuildOptions,
): Promise<DeviceDashboardV2Response> {
  const built = await buildSlides(tx, workspaceId, dashboardId, options);
  const content = {
    schema: 2 as const,
    refreshAfterSec: DEVICE_REFRESH_AFTER_SECONDS,
    timeZone: built.timeZone,
    locale: built.locale,
    dashboard: built.header,
    theme: built.theme,
    rotation: built.rotation,
    grid: { columns: STUDIO_GRID.columns, rows: STUDIO_GRID.rows },
    slides: built.slides.flatMap((slide) =>
      slidesIn16x9(slide, built.primaryFormat),
    ),
    images: built.images,
  };
  return { version: versionOf(content), ...content };
}

// ─── Schema 3 ───────────────────────────────────────────────────────────────

/** Every format's grid and reference canvas, in the fixed format order. */
const DEVICE_FORMATS = Object.fromEntries(
  (["16x9", "21x9", "4x3", "3x4", "9x16"] as const).map((key) => {
    const spec = SCREEN_FORMATS[key];
    return [
      key,
      {
        columns: spec.columns,
        rows: spec.rows,
        reference: [spec.reference.width, spec.reference.height],
      },
    ];
  }),
) as DeviceDashboardV3Response["formats"];

/** Schema 3 without the device settings: the same for every screen. */
export type DeviceDashboardV3Content = Omit<
  DeviceDashboardV3Response,
  "version" | "device"
>;

/**
 * Builds the device-independent part of schema 3 (ADR 0017 section 9)
 * inside the device's workspace transaction: schema 2's content with the
 * primary placements, every format's grid, and per slide the custom layouts
 * (`autoPlaced` is the Studio's and not sent). Screens lay out for their own
 * format. `withDevice` completes it.
 */
export async function buildDeviceDashboardV3(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: BuildOptions,
): Promise<DeviceDashboardV3Content> {
  const built = await buildSlides(tx, workspaceId, dashboardId, options);
  return {
    schema: 3,
    refreshAfterSec: DEVICE_REFRESH_AFTER_SECONDS,
    timeZone: built.timeZone,
    locale: built.locale,
    primaryFormat: built.primaryFormat,
    formats: DEVICE_FORMATS,
    dashboard: built.header,
    theme: built.theme,
    rotation: built.rotation,
    slides: built.slides.map(({ slide, head, widgets }) => {
      const ids = new Set(widgets.map((widget) => widget.id));
      return {
        ...head,
        // Each with its type's minimum, so screens that do not know a
        // type reflow it exactly (ADR 0019 section 2).
        widgets: widgets.map((widget) => ({
          ...widget,
          min: { ...STUDIO_MIN_WIDGET_SIZE[widget.type] },
        })),
        layouts: slide.layouts
          .filter((layout) => layout.format !== built.primaryFormat)
          .map((layout) => ({
            format: layout.format as ScreenFormat,
            pages: layout.pages,
            placements: layout.placements
              .filter((placement) => ids.has(placement.widgetId))
              .map(({ widgetId, page, x, y, w, h, hidden }) => ({
                widgetId,
                page,
                x,
                y,
                w,
                h,
                hidden,
              })),
          })),
      };
    }),
    images: built.images,
  };
}

/**
 * Schema 3 for one device: its settings go into the payload and its hash,
 * so a rotation or mode change is a new ETag and reaches the screen within
 * one poll, while the rest stays shared by every screen of the dashboard.
 */
export function withDevice(
  content: DeviceDashboardV3Content,
  device: DeviceDashboardV3Response["device"],
): DeviceDashboardV3Response {
  const { schema, refreshAfterSec, timeZone, locale, primaryFormat, formats } =
    content;
  const full = {
    schema,
    refreshAfterSec,
    timeZone,
    locale,
    primaryFormat,
    formats,
    device: { rotation: device.rotation, displayMode: device.displayMode },
    dashboard: content.dashboard,
    theme: content.theme,
    rotation: content.rotation,
    slides: content.slides,
    images: content.images,
  };
  return { version: versionOf(full), ...full };
}
