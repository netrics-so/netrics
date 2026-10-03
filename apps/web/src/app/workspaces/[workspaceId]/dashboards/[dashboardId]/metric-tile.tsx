"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type {
  ConnectionStateView,
  DashboardTile,
  MetricQueryResponse,
  WorkspaceMetric,
} from "@netrics/contracts";

import { TileNotice, TileView } from "@/components/tile-view";
import { apiErrorMessage, queryMetric } from "@/lib/api";
import { TILE_NOTICES, lastSyncNotice } from "@/lib/tile-status";

export interface TileConnection {
  name: string;
  state: ConnectionStateView;
}

/**
 * Data older than this many poll intervals (at least 15 minutes) is marked
 * stale: the numbers may no longer reflect the source.
 */
const STALE_AFTER_INTERVALS = 3;
const MIN_STALE_MS = 15 * 60 * 1000;

function staleness(connection: TileConnection | undefined): string | null {
  if (!connection) {
    return TILE_NOTICES.removed;
  }
  const { state } = connection;
  if (state.health === "auth_failed") {
    return TILE_NOTICES.authFailed;
  }
  if (state.health === "needs_reauthorization") {
    return TILE_NOTICES.needsReconnect;
  }
  if (state.health === "outage") {
    return TILE_NOTICES.outage;
  }
  if (!state.lastSuccessAt) {
    return TILE_NOTICES.firstSync;
  }
  const age = Date.now() - new Date(state.lastSuccessAt).getTime();
  const limit = Math.max(
    STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    MIN_STALE_MS,
  );
  return age > limit ? lastSyncNotice(state.lastSuccessAt) : null;
}

export function MetricTile({
  workspaceId,
  tile,
  metric,
  connection,
  refreshMs = 60_000,
  variant = "default",
}: {
  workspaceId: string;
  tile: DashboardTile;
  metric: WorkspaceMetric | undefined;
  connection: TileConnection | undefined;
  refreshMs?: number;
  /** "tv": sized by its grid cell for reading at a distance (#52). */
  variant?: "default" | "tv";
}) {
  const [data, setData] = useState<MetricQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await queryMetric(workspaceId, {
        connectionId: tile.connectionId,
        metricKey: tile.metricKey,
        period: tile.period,
        aggregation: tile.aggregation,
        ...(Object.keys(tile.dimensions).length > 0
          ? { dimensions: tile.dimensions }
          : {}),
      });
      setData(result);
      setError(null);
    } catch (cause) {
      // Keep showing the last good numbers; the error explains why they
      // did not update.
      setError(apiErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, tile]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  const label = tile.title ?? metric?.name ?? tile.metricKey;
  const unit = data?.metric.unit ?? metric?.unit ?? "";
  const stale = staleness(connection);

  return (
    <TileView
      variant={variant}
      label={label}
      period={tile.period}
      aggregation={tile.aggregation}
      busy={loading}
      reading={
        data
          ? {
              value: data.value,
              unit,
              delta: data.delta,
              ratio: data.ratio,
              series: data.series,
              timeZone: data.timeZone,
            }
          : null
      }
      fallback={
        loading ? (
          <div className="tile-value tile-placeholder" aria-hidden="true">
            …
          </div>
        ) : (
          <div className="tile-error" role="alert">
            <p>This tile could not load.</p>
            {error ? <p className="muted">{error}</p> : null}
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )
      }
      footer={
        <>
          <span className="muted">{connection?.name ?? "—"}</span>
          {stale ? (
            connection && variant === "default" ? (
              // Leads to the connection page, where the problem can be fixed.
              <Link
                className="tile-stale"
                title="The numbers may be out of date"
                href={`/workspaces/${workspaceId}/connections/${tile.connectionId}`}
              >
                <span aria-hidden="true">⚠</span> {stale}
              </Link>
            ) : (
              <TileNotice>{stale}</TileNotice>
            )
          ) : null}
          {data && error ? (
            <TileNotice title={error}>Refresh failed</TileNotice>
          ) : null}
        </>
      }
    />
  );
}
