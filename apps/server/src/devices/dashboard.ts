import { createHash } from "node:crypto";

import {
  DEVICE_REFRESH_AFTER_SECONDS,
  barWidgetOptionsSchema,
  clockWidgetOptionsSchema,
  imageWidgetOptionsSchema,
  lineWidgetOptionsSchema,
  metricWidgetOptionsSchema,
  textWidgetOptionsSchema,
  themeTokensSchema,
  type ConnectionStateView,
  type DeviceDashboardResponse,
  type DeviceDashboardV2Response,
  type DeviceImage,
  type DeviceSlide,
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
  findDashboard,
  findImages,
  findResourceNames,
  findTheme,
  findWorkspace,
  listConnections,
  resourceNameKey,
  schema1Tiles,
  type Dashboard,
  type DashboardWidgetRow,
  type Transaction,
} from "@netrics/database";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_KEY,
  EXCHANGE_RATE_SOURCE,
  RESOURCE_DIMENSION,
  STUDIO_GRID,
  isBuiltinThemeKey,
  isDataWidgetType,
  tileLabel,
  type ThemeTokens,
} from "@netrics/domain";

import { toStateView } from "../connections/present.js";
import {
  findAllResourcesNames,
  queryMetric,
  queryMetricBreakdown,
  tileAllResourcesName,
} from "../metrics/query.js";

// The device dashboard read model (ADR 0007, #57), computed by the same
// metric query service as the web dashboard.
//
// Schema 1 (ADR 0015 section 7): the tiles are the metric widgets of the
// enabled slides in reading order, at most 24; for a migrated tile
// dashboard exactly its tiles as before, byte for byte.
//
// Schema 2 (#219): the enabled slides with every widget, its placement and
// computed data, the resolved theme, rotation and the referenced images.

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
}

function tileStatus(
  state: ConnectionStateView | null,
  hasData: boolean,
  now: Date,
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
    return "no_data";
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
  label(widget: DataWidget, metricName: string | undefined): string;
}

async function loadDataContext(
  tx: Transaction,
  workspaceId: string,
  widgets: readonly DataWidget[],
  options: BuildOptions,
): Promise<DataContext> {
  const states = new Map(
    (await listConnections(tx, workspaceId)).map(({ row, state }) => [
      row.id,
      toStateView(state),
    ]),
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
  );
  return {
    workspaceId,
    options,
    states,
    label(widget, metricName) {
      const dimensions = dimensionsOf(widget);
      const resourceId = dimensions[RESOURCE_DIMENSION];
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
      { exchangeRates: context.options.exchangeRates ?? false },
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
    status: tileStatus(state, value !== null, context.options.now),
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
  const content = {
    refreshAfterSec: DEVICE_REFRESH_AFTER_SECONDS,
    timeZone: workspace?.timeZone ?? "UTC",
    dashboard: dashboard ? { id: dashboard.id, name: dashboard.name } : null,
    tiles,
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
          { exchangeRates: context.options.exchangeRates ?? false },
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
        status: tileStatus(state, hasData, context.options.now),
        updatedAt: state?.lastSuccessAt ?? null,
        groupBy: options.groupBy,
        bars: breakdown?.groups ?? [],
        others: breakdown?.others ?? null,
      },
    };
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
 * Builds the schema 2 read model inside the device's workspace
 * transaction. Data widgets are computed like schema 1 tiles: one that
 * fails reports `no_data` (or its connection's failure) and never fails
 * the payload.
 */
export async function buildDeviceDashboardV2(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: BuildOptions,
): Promise<DeviceDashboardV2Response> {
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
  const deviceSlides: DeviceSlide[] = [];
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
      } else if (widget.type === "clock") {
        const clock = parsedOptions(clockWidgetOptionsSchema, widget.options);
        widgets.push({
          type: "clock",
          ...placement,
          label: widget.title,
          options: { ...clock, timeZone: clock.timeZone ?? timeZone },
        });
      }
    }
    const background = imageRef(slide.backgroundImageId);
    deviceSlides.push({
      id: slide.id,
      name: slide.name,
      durationSec: slide.durationSeconds ?? dashboard!.defaultSlideSeconds,
      background:
        background !== null
          ? { imageId: background, dim: slide.backgroundDim }
          : null,
      widgets,
    });
  }

  const logo = imageRef(dashboard?.logoImageId ?? null);
  const content = {
    schema: 2 as const,
    refreshAfterSec: DEVICE_REFRESH_AFTER_SECONDS,
    timeZone,
    dashboard: dashboard
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
    grid: { columns: STUDIO_GRID.columns, rows: STUDIO_GRID.rows },
    slides: deviceSlides,
    images,
  };
  return { version: versionOf(content), ...content };
}
