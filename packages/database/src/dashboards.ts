import { and, asc, count, desc, eq } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// Dashboard persistence (#49), as netrics_app inside withWorkspace. Every
// query names the workspace explicitly on top of RLS. A dashboard is written
// as a whole (name and ordered tiles) and guarded by its version.

export type DashboardRow = typeof schema.dashboards.$inferSelect;
export type DashboardTileRow = typeof schema.dashboardTiles.$inferSelect;

export interface Dashboard extends DashboardRow {
  tiles: DashboardTileRow[];
}

export interface DashboardSummary {
  id: string;
  name: string;
  projectId: string | null;
  version: number;
  tileCount: number;
  updatedAt: Date;
}

export interface TileInput {
  connectionId: string;
  metricKey: string;
  aggregation: string;
  period: string;
  dimensions: Record<string, string>;
  title: string | null;
  /** A per-currency amount converted into this currency (#191). */
  displayCurrency?: string | null;
}

export interface DashboardInput {
  name: string;
  projectId: string | null;
  tiles: TileInput[];
}

function dashboardScope(workspaceId: string, dashboardId: string) {
  return and(
    eq(schema.dashboards.workspaceId, workspaceId),
    eq(schema.dashboards.id, dashboardId),
  );
}

export async function listDashboards(
  tx: Transaction,
  workspaceId: string,
): Promise<DashboardSummary[]> {
  return tx
    .select({
      id: schema.dashboards.id,
      name: schema.dashboards.name,
      projectId: schema.dashboards.projectId,
      version: schema.dashboards.version,
      updatedAt: schema.dashboards.updatedAt,
      tileCount: count(schema.dashboardTiles.id),
    })
    .from(schema.dashboards)
    .leftJoin(
      schema.dashboardTiles,
      and(
        eq(schema.dashboardTiles.dashboardId, schema.dashboards.id),
        eq(schema.dashboardTiles.workspaceId, workspaceId),
      ),
    )
    .where(eq(schema.dashboards.workspaceId, workspaceId))
    .groupBy(schema.dashboards.id)
    .orderBy(desc(schema.dashboards.updatedAt));
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
  const tiles = await tx
    .select()
    .from(schema.dashboardTiles)
    .where(
      and(
        eq(schema.dashboardTiles.workspaceId, workspaceId),
        eq(schema.dashboardTiles.dashboardId, dashboardId),
      ),
    )
    .orderBy(asc(schema.dashboardTiles.position));
  return { ...row, tiles };
}

async function writeTiles(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string,
  tiles: TileInput[],
): Promise<DashboardTileRow[]> {
  if (tiles.length === 0) {
    return [];
  }
  return tx
    .insert(schema.dashboardTiles)
    .values(
      tiles.map((tile, position) => ({
        dashboardId,
        workspaceId,
        connectionId: tile.connectionId,
        metricKey: tile.metricKey,
        aggregation: tile.aggregation,
        period: tile.period,
        dimensions: tile.dimensions,
        title: tile.title,
        displayCurrency: tile.displayCurrency ?? null,
        position,
      })),
    )
    .returning();
}

export async function insertDashboard(
  tx: Transaction,
  workspaceId: string,
  input: DashboardInput,
): Promise<Dashboard> {
  const [row] = await tx
    .insert(schema.dashboards)
    .values({ workspaceId, name: input.name, projectId: input.projectId })
    .returning();
  if (!row) {
    throw new Error("dashboard insert returned no row");
  }
  const tiles = await writeTiles(tx, workspaceId, row.id, input.tiles);
  return { ...row, tiles };
}

export type ReplaceResult =
  | { status: "ok"; dashboard: Dashboard }
  | { status: "not_found" }
  | { status: "version_conflict"; currentVersion: number };

/**
 * Replaces name, project and tiles if `expectedVersion` is still current,
 * and increments the version. A concurrent writer that saved first makes
 * this a version conflict instead of silently overwriting its changes.
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
  await tx
    .delete(schema.dashboardTiles)
    .where(
      and(
        eq(schema.dashboardTiles.workspaceId, workspaceId),
        eq(schema.dashboardTiles.dashboardId, dashboardId),
      ),
    );
  const tiles = await writeTiles(tx, workspaceId, dashboardId, input.tiles);
  return { status: "ok", dashboard: { ...row, tiles } };
}

/** Tiles go with the dashboard (foreign key cascade). */
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
