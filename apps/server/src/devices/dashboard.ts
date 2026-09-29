import { createHash } from "node:crypto";

import {
  DEVICE_REFRESH_AFTER_SECONDS,
  type ConnectionStateView,
  type DeviceDashboardResponse,
  type DeviceTile,
  type DeviceTileStatus,
  type MetricAggregation,
  type MetricPeriod,
} from "@netrics/contracts";
import {
  findDashboard,
  findWorkspace,
  listConnections,
  type Transaction,
} from "@netrics/database";

import { toStateView } from "../connections/present.js";
import { queryMetric } from "../metrics/query.js";

// The device dashboard read model (ADR 0007, #57): the assigned dashboard's
// tiles, computed by the same metric query service as the web dashboard.

/**
 * Data older than this many poll intervals (at least 15 minutes) is stale.
 * The web tile uses the same rule.
 */
const STALE_AFTER_INTERVALS = 3;
const MIN_STALE_MS = 15 * 60 * 1000;

export interface TileErrorLogger {
  warn(details: { tileId: string; err: unknown }, message: string): void;
}

function tileStatus(
  state: ConnectionStateView | null,
  value: number | null,
  now: Date,
): DeviceTileStatus {
  if (state?.health === "auth_failed" || state?.health === "outage") {
    return state.health;
  }
  if (!state || value === null) {
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
function versionOf(content: Omit<DeviceDashboardResponse, "version">): string {
  return createHash("sha256")
    .update(JSON.stringify(content))
    .digest("base64url")
    .slice(0, 32);
}

/**
 * Builds the read model inside the device's workspace transaction. A tile
 * that fails to compute reports `no_data` (or its connection's failure);
 * it never fails the whole dashboard.
 */
export async function buildDeviceDashboard(
  tx: Transaction,
  workspaceId: string,
  dashboardId: string | null,
  options: { now: Date; log?: TileErrorLogger },
): Promise<DeviceDashboardResponse> {
  const { now } = options;
  const workspace = await findWorkspace(tx, workspaceId);
  const dashboard = dashboardId
    ? await findDashboard(tx, workspaceId, dashboardId)
    : null;
  const tiles: DeviceTile[] = [];
  if (dashboard) {
    const states = new Map(
      (await listConnections(tx, workspaceId)).map(({ row, state }) => [
        row.id,
        toStateView(state),
      ]),
    );
    for (const tile of dashboard.tiles) {
      const request = {
        connectionId: tile.connectionId,
        metricKey: tile.metricKey,
        period: tile.period as MetricPeriod,
        aggregation: tile.aggregation as MetricAggregation,
        ...(Object.keys(tile.dimensions as object).length > 0
          ? { dimensions: tile.dimensions as Record<string, string> }
          : {}),
      };
      // A savepoint per tile: a failing query must not abort the others.
      const result = await tx
        .transaction((savepoint) =>
          queryMetric(savepoint, workspaceId, request, now),
        )
        .catch((err: unknown) => {
          options.log?.warn({ tileId: tile.id, err }, "device tile failed");
          return null;
        });
      const query = result?.ok ? result.value : null;
      const state = states.get(tile.connectionId) ?? null;
      const value = query?.value ?? null;
      tiles.push({
        id: tile.id,
        label: tile.title ?? query?.metric.name ?? tile.metricKey,
        period: request.period,
        aggregation: query?.aggregation ?? request.aggregation,
        value,
        unit: query?.metric.unit ?? null,
        change: {
          previousValue: query?.previousValue ?? null,
          delta: query?.delta ?? null,
          ratio: query?.ratio ?? null,
        },
        spark: query?.series.map((point) => point.value) ?? [],
        status: tileStatus(state, value, now),
        updatedAt: state?.lastSuccessAt ?? null,
      });
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
