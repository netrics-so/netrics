import type {
  CreateDashboardRequest,
  Dashboard as DashboardView,
  DashboardTileInput,
  DuplicateDashboardRequest,
  ReplaceDashboardRequest,
} from "@netrics/contracts";
import {
  deleteDashboard,
  findConnectionMetric,
  findDashboard,
  findProject,
  insertAuditEvent,
  insertDashboard,
  listDashboards,
  replaceDashboard,
  withWorkspace,
  type Dashboard,
  type Database,
  type TileInput,
  type Transaction,
} from "@netrics/database";
import {
  compatibleAggregations,
  type Aggregation,
  type MetricKind,
} from "@netrics/domain";

/**
 * Dashboard use cases (#49). Tiles are validated against the workspace's
 * connections and their metrics: a tile can only show a metric its
 * connection provides, with an aggregation that fits the metric's kind.
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(status: 400 | 404 | 409, error: string): Result<T> {
  return { ok: false, status, error };
}

const NOT_FOUND = "dashboard_not_found";

export function presentDashboard(dashboard: Dashboard): DashboardView {
  return {
    id: dashboard.id,
    name: dashboard.name,
    projectId: dashboard.projectId,
    version: dashboard.version,
    createdAt: dashboard.createdAt.toISOString(),
    updatedAt: dashboard.updatedAt.toISOString(),
    tiles: dashboard.tiles.map((tile) => ({
      id: tile.id,
      position: tile.position,
      connectionId: tile.connectionId,
      metricKey: tile.metricKey,
      aggregation: tile.aggregation as Aggregation,
      period: tile.period as DashboardView["tiles"][number]["period"],
      dimensions: tile.dimensions as Record<string, string>,
      title: tile.title,
    })),
  };
}

async function validateTiles(
  tx: Transaction,
  workspaceId: string,
  tiles: readonly DashboardTileInput[],
): Promise<Result<TileInput[]>> {
  const valid: TileInput[] = [];
  for (const tile of tiles) {
    const metric = await findConnectionMetric(
      tx,
      workspaceId,
      tile.connectionId,
      tile.metricKey,
    );
    if (!metric) {
      return fail(400, "tile_metric_not_found");
    }
    const compatible = compatibleAggregations(
      metric.kind as MetricKind,
      metric.aggregations as Aggregation[],
    );
    const aggregation = tile.aggregation ?? compatible[0];
    if (!aggregation || !compatible.includes(aggregation)) {
      return fail(400, "aggregation_not_supported");
    }
    const dimensions = tile.dimensions ?? {};
    if (
      Object.keys(dimensions).some((key) => !metric.dimensions.includes(key))
    ) {
      return fail(400, "unknown_dimension");
    }
    valid.push({
      connectionId: tile.connectionId,
      metricKey: tile.metricKey,
      aggregation,
      period: tile.period,
      dimensions,
      title: tile.title ?? null,
    });
  }
  return ok(valid);
}

async function checkProject(
  tx: Transaction,
  workspaceId: string,
  projectId: string | null | undefined,
): Promise<boolean> {
  return !projectId || (await findProject(tx, workspaceId, projectId)) !== null;
}

export function createDashboardService(deps: { db: Database }) {
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  return {
    list(actor: Actor) {
      return inWorkspace(actor, async (tx) =>
        (await listDashboards(tx, actor.workspaceId)).map((summary) => ({
          ...summary,
          updatedAt: summary.updatedAt.toISOString(),
        })),
      );
    },

    get(actor: Actor, dashboardId: string) {
      return inWorkspace(actor, async (tx) => {
        const dashboard = await findDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
        );
        return dashboard
          ? ok(presentDashboard(dashboard))
          : fail<DashboardView>(404, NOT_FOUND);
      });
    },

    create(actor: Actor, body: CreateDashboardRequest) {
      return inWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        const tiles = await validateTiles(
          tx,
          actor.workspaceId,
          body.tiles ?? [],
        );
        if (!tiles.ok) {
          return tiles;
        }
        const dashboard = await insertDashboard(tx, actor.workspaceId, {
          name: body.name,
          projectId: body.projectId ?? null,
          tiles: tiles.value,
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.created",
          target: dashboard.id,
          metadata: { name: dashboard.name },
        });
        return ok(presentDashboard(dashboard));
      });
    },

    replace(actor: Actor, dashboardId: string, body: ReplaceDashboardRequest) {
      return inWorkspace(actor, async (tx) => {
        if (!(await checkProject(tx, actor.workspaceId, body.projectId))) {
          return fail<DashboardView>(404, "project_not_found");
        }
        const tiles = await validateTiles(tx, actor.workspaceId, body.tiles);
        if (!tiles.ok) {
          return tiles;
        }
        const result = await replaceDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
          body.version,
          { name: body.name, projectId: body.projectId, tiles: tiles.value },
        );
        if (result.status === "not_found") {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        if (result.status === "version_conflict") {
          return fail<DashboardView>(409, "version_conflict");
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.updated",
          target: dashboardId,
          metadata: {
            name: result.dashboard.name,
            version: result.dashboard.version,
            tileCount: result.dashboard.tiles.length,
          },
        });
        return ok(presentDashboard(result.dashboard));
      });
    },

    duplicate(
      actor: Actor,
      dashboardId: string,
      body: DuplicateDashboardRequest,
    ) {
      return inWorkspace(actor, async (tx) => {
        const source = await findDashboard(tx, actor.workspaceId, dashboardId);
        if (!source) {
          return fail<DashboardView>(404, NOT_FOUND);
        }
        const name = body.name ?? `${source.name} (copy)`.slice(0, 100);
        const copy = await insertDashboard(tx, actor.workspaceId, {
          name,
          projectId: source.projectId,
          tiles: source.tiles.map((tile) => ({
            connectionId: tile.connectionId,
            metricKey: tile.metricKey,
            aggregation: tile.aggregation,
            period: tile.period,
            dimensions: tile.dimensions as Record<string, string>,
            title: tile.title,
          })),
        });
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.duplicated",
          target: copy.id,
          metadata: { name, sourceId: dashboardId },
        });
        return ok(presentDashboard(copy));
      });
    },

    remove(actor: Actor, dashboardId: string) {
      return inWorkspace(actor, async (tx) => {
        const existing = await findDashboard(
          tx,
          actor.workspaceId,
          dashboardId,
        );
        if (!existing) {
          return fail<null>(404, NOT_FOUND);
        }
        await deleteDashboard(tx, actor.workspaceId, dashboardId);
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "dashboard.deleted",
          target: dashboardId,
          metadata: { name: existing.name },
        });
        return ok(null);
      });
    },
  };
}
