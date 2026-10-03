import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// Dashboard persistence (#49; slides and widgets since ADR 0015), as
// netrics_app inside withWorkspace. Every query names the workspace
// explicitly on top of RLS. A dashboard is written as a whole (settings,
// slides and widgets) and guarded by its version.

export type DashboardRow = typeof schema.dashboards.$inferSelect;
export type DashboardSlideRow = typeof schema.dashboardSlides.$inferSelect;
export type DashboardWidgetRow = typeof schema.dashboardWidgets.$inferSelect;

export interface DashboardSlide extends DashboardSlideRow {
  /** In reading order: top to bottom, then left to right. */
  widgets: DashboardWidgetRow[];
}

export interface Dashboard extends DashboardRow {
  /** By position. */
  slides: DashboardSlide[];
}

export interface DashboardSummary {
  id: string;
  name: string;
  projectId: string | null;
  version: number;
  /** Metric widgets, the tiles of the expand/contract window. */
  tileCount: number;
  slideCount: number;
  widgetCount: number;
  updatedAt: Date;
}

export interface DashboardSettings {
  showHeader: boolean;
  autoAdvance: boolean;
  defaultSlideSeconds: number;
  transition: string;
  /** A built-in theme key or a custom theme id, exactly one (#216). */
  themeBuiltin: string | null;
  themeId: string | null;
  /** `#rrggbb`, overrides the theme accent. */
  accentColor: string | null;
}

export interface WidgetInput {
  /** Kept when it is a widget of this dashboard; otherwise a new id. */
  id?: string | null;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string | null;
  connectionId: string | null;
  metricKey: string | null;
  aggregation: string | null;
  period: string | null;
  dimensions: Record<string, string>;
  /** A per-currency amount converted into this currency (#191). */
  displayCurrency: string | null;
  text: string | null;
  options: Record<string, unknown>;
}

export interface SlideInput {
  /** Kept when it is a slide of this dashboard; otherwise a new id. */
  id?: string | null;
  name: string | null;
  durationSeconds: number | null;
  enabled: boolean;
  widgets: WidgetInput[];
}

export interface DashboardInput {
  name: string;
  projectId: string | null;
  /** Missing fields: the defaults on insert, unchanged on replace. */
  settings?: Partial<DashboardSettings>;
  slides: SlideInput[];
}

/** Screens that read schema 1 get at most this many tiles (ADR 0015). */
const MAX_SCHEMA1_TILES = 24;

function dashboardScope(workspaceId: string, dashboardId: string) {
  return and(
    eq(schema.dashboards.workspaceId, workspaceId),
    eq(schema.dashboards.id, dashboardId),
  );
}

/**
 * The metric widgets in reading order (slide, then row, then column): the
 * dashboard's tiles for clients of the tile API and device schema 1.
 */
export function metricWidgets(
  slides: readonly DashboardSlide[],
  options: { enabledOnly: boolean },
): DashboardWidgetRow[] {
  return slides
    .filter((slide) => !options.enabledOnly || slide.enabled)
    .flatMap((slide) =>
      slide.widgets.filter((widget) => widget.type === "metric"),
    );
}

/** What screens on device schema 1 show: enabled slides, at most 24. */
export function schema1Tiles(
  slides: readonly DashboardSlide[],
): DashboardWidgetRow[] {
  return metricWidgets(slides, { enabledOnly: true }).slice(
    0,
    MAX_SCHEMA1_TILES,
  );
}

export async function listDashboards(
  tx: Transaction,
  workspaceId: string,
): Promise<DashboardSummary[]> {
  // Spelled out: drizzle leaves column names unqualified in a select list.
  const count = (table: string, filter = sql``) => sql<number>`(
    select count(*)::int from ${sql.identifier(table)} c
    where c.dashboard_id = "dashboards"."id"
      and c.workspace_id = ${workspaceId} ${filter})`;
  return tx
    .select({
      id: schema.dashboards.id,
      name: schema.dashboards.name,
      projectId: schema.dashboards.projectId,
      version: schema.dashboards.version,
      updatedAt: schema.dashboards.updatedAt,
      tileCount: count("dashboard_widgets", sql`and c.type = 'metric'`),
      widgetCount: count("dashboard_widgets"),
      slideCount: count("dashboard_slides"),
    })
    .from(schema.dashboards)
    .where(eq(schema.dashboards.workspaceId, workspaceId))
    .orderBy(desc(schema.dashboards.updatedAt));
}

async function loadSlides(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardSlide[]> {
  const slides = await tx
    .select()
    .from(schema.dashboardSlides)
    .where(
      and(
        eq(schema.dashboardSlides.workspaceId, workspaceId),
        eq(schema.dashboardSlides.dashboardId, dashboardId),
      ),
    )
    .orderBy(asc(schema.dashboardSlides.position));
  const widgets = await tx
    .select()
    .from(schema.dashboardWidgets)
    .where(
      and(
        eq(schema.dashboardWidgets.workspaceId, workspaceId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    )
    .orderBy(
      asc(schema.dashboardWidgets.y),
      asc(schema.dashboardWidgets.x),
      asc(schema.dashboardWidgets.id),
    );
  return slides.map((slide) => ({
    ...slide,
    widgets: widgets.filter((widget) => widget.slideId === slide.id),
  }));
}

export async function findDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
): Promise<Dashboard | null> {
  const [row] = await tx
    .select()
    .from(schema.dashboards)
    .where(dashboardScope(workspaceId, dashboardId))
    .limit(1);
  if (!row) {
    return null;
  }
  return { ...row, slides: await loadSlides(tx, workspaceId, dashboardId) };
}

/** `id` when it is one of `existing` and not taken yet; otherwise none. */
function keepId(
  id: string | null | undefined,
  existing: ReadonlySet<string>,
  taken: Set<string>,
): { id?: string } {
  if (!id || !existing.has(id) || taken.has(id)) {
    return {};
  }
  taken.add(id);
  return { id };
}

/**
 * Writes the slides and widgets of a dashboard that has none (any old ones
 * deleted first). Ids in `keep` are reused; the rest are new.
 */
async function writeSlides(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  slides: readonly SlideInput[],
  keep: { slides: ReadonlySet<string>; widgets: ReadonlySet<string> },
): Promise<void> {
  if (slides.length === 0) {
    return;
  }
  const takenSlides = new Set<string>();
  const slideRows = await tx
    .insert(schema.dashboardSlides)
    .values(
      slides.map((slide, position) => ({
        ...keepId(slide.id, keep.slides, takenSlides),
        dashboardId,
        workspaceId,
        position,
        name: slide.name,
        durationSeconds: slide.durationSeconds,
        enabled: slide.enabled,
      })),
    )
    .returning({
      id: schema.dashboardSlides.id,
      position: schema.dashboardSlides.position,
    });
  const slideIds = new Map(slideRows.map((row) => [row.position, row.id]));
  const takenWidgets = new Set<string>();
  const widgetRows = slides.flatMap((slide, position) =>
    slide.widgets.map((widget) => ({
      ...keepId(widget.id, keep.widgets, takenWidgets),
      slideId: slideIds.get(position)!,
      dashboardId,
      workspaceId,
      type: widget.type,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      title: widget.title,
      connectionId: widget.connectionId,
      metricKey: widget.metricKey,
      aggregation: widget.aggregation,
      period: widget.period,
      dimensions: widget.dimensions,
      displayCurrency: widget.displayCurrency,
      text: widget.text,
      options: widget.options,
    })),
  );
  if (widgetRows.length > 0) {
    await tx.insert(schema.dashboardWidgets).values(widgetRows);
  }
}

/**
 * Keeps dashboard_tiles in step with the metric widgets for the
 * expand/contract window (ADR 0015 section 4), so a server rolled back to
 * the tile model still shows what screens show now. Removed with the table.
 */
async function mirrorTiles(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  slides: readonly DashboardSlide[],
): Promise<void> {
  await tx
    .delete(schema.dashboardTiles)
    .where(
      and(
        eq(schema.dashboardTiles.workspaceId, workspaceId),
        eq(schema.dashboardTiles.dashboardId, dashboardId),
      ),
    );
  const tiles = schema1Tiles(slides);
  if (tiles.length === 0) {
    return;
  }
  await tx.insert(schema.dashboardTiles).values(
    tiles.map((widget, position) => ({
      id: widget.id,
      dashboardId,
      workspaceId,
      connectionId: widget.connectionId!,
      metricKey: widget.metricKey!,
      aggregation: widget.aggregation!,
      period: widget.period!,
      dimensions: widget.dimensions,
      title: widget.title,
      displayCurrency: widget.displayCurrency,
      position,
    })),
  );
}

const NO_IDS = { slides: new Set<string>(), widgets: new Set<string>() };

export async function insertDashboard(
  tx: Transaction,
  workspaceId: string,
  input: DashboardInput,
): Promise<Dashboard> {
  const [row] = await tx
    .insert(schema.dashboards)
    .values({
      workspaceId,
      name: input.name,
      projectId: input.projectId,
      ...input.settings,
    })
    .returning();
  if (!row) {
    throw new Error("dashboard insert returned no row");
  }
  await writeSlides(tx, workspaceId, row.id, input.slides, NO_IDS);
  const slides = await loadSlides(tx, workspaceId, row.id);
  await mirrorTiles(tx, workspaceId, row.id, slides);
  return { ...row, slides };
}

export type ReplaceResult =
  | { status: "ok"; dashboard: Dashboard }
  | { status: "not_found" }
  | { status: "version_conflict"; currentVersion: number };

/**
 * Replaces name, project, settings, slides and widgets if
 * `expectedVersion` is still current, and increments the version. A
 * concurrent writer that saved first makes this a version conflict instead
 * of silently overwriting its changes. Slide and widget ids of this
 * dashboard are kept; any other id is replaced by a new one.
 */
export async function replaceDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  expectedVersion: number,
  input: DashboardInput,
): Promise<ReplaceResult> {
  const [row] = await tx
    .update(schema.dashboards)
    .set({
      name: input.name,
      projectId: input.projectId,
      ...input.settings,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        dashboardScope(workspaceId, dashboardId),
        eq(schema.dashboards.version, expectedVersion),
      ),
    )
    .returning();
  if (!row) {
    const [current] = await tx
      .select({ version: schema.dashboards.version })
      .from(schema.dashboards)
      .where(dashboardScope(workspaceId, dashboardId))
      .limit(1);
    return current
      ? { status: "version_conflict", currentVersion: current.version }
      : { status: "not_found" };
  }
  const before = await loadSlides(tx, workspaceId, dashboardId);
  const keep = {
    slides: new Set(before.map((slide) => slide.id)),
    widgets: new Set(
      before.flatMap((slide) => slide.widgets.map((widget) => widget.id)),
    ),
  };
  if (keep.slides.size > 0) {
    // Widgets go with their slides (foreign key cascade).
    await tx
      .delete(schema.dashboardSlides)
      .where(
        and(
          eq(schema.dashboardSlides.workspaceId, workspaceId),
          eq(schema.dashboardSlides.dashboardId, dashboardId),
          inArray(schema.dashboardSlides.id, [...keep.slides]),
        ),
      );
  }
  await writeSlides(tx, workspaceId, dashboardId, input.slides, keep);
  const slides = await loadSlides(tx, workspaceId, dashboardId);
  await mirrorTiles(tx, workspaceId, dashboardId, slides);
  return { status: "ok", dashboard: { ...row, slides } };
}

/** Slides, widgets and tiles go with the dashboard (foreign key cascade). */
export async function deleteDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(schema.dashboards)
    .where(dashboardScope(workspaceId, dashboardId))
    .returning({ id: schema.dashboards.id });
  return rows.length === 1;
}
