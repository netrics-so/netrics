"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ConnectionStateView,
  DashboardTile,
  MetricQueryResponse,
  WorkspaceMetric,
} from "@netrics/contracts";

import { apiErrorMessage, queryMetric } from "@/lib/api";
import {
  AGGREGATION_LABELS,
  COMPARISON_LABELS,
  PERIOD_LABELS,
  formatChange,
  formatValue,
} from "@/lib/format-metric";
import { relativeTime } from "@/lib/relative-time";

import { Sparkline } from "./sparkline";

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
    return "Connection removed";
  }
  const { state } = connection;
  if (state.health === "auth_failed") {
    return "Connection needs new credentials";
  }
  if (state.health === "outage") {
    return "Source unreachable";
  }
  if (!state.lastSuccessAt) {
    return "Waiting for the first sync";
  }
  const age = Date.now() - new Date(state.lastSuccessAt).getTime();
  const limit = Math.max(
    STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    MIN_STALE_MS,
  );
  return age > limit ? `Last sync ${relativeTime(state.lastSuccessAt)}` : null;
}

const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;

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
  const change = data ? formatChange(data.delta, data.ratio, unit) : null;

  return (
    <article
      className={variant === "tv" ? "tile tile--tv" : "tile"}
      aria-busy={loading}
    >
      <header className="tile-header">
        <h3 className="tile-label">{label}</h3>
        <span className="tile-period">
          {PERIOD_LABELS[tile.period]} · {AGGREGATION_LABELS[tile.aggregation]}
        </span>
      </header>

      {data ? (
        <>
          <div className="tile-value">{formatValue(data.value, unit)}</div>
          {change ? (
            <div className={`tile-change ${change.direction}`}>
              <span aria-hidden="true">{ARROWS[change.direction]}</span>{" "}
              {change.text}{" "}
              <span className="tile-comparison">
                {COMPARISON_LABELS[tile.period]}
              </span>
            </div>
          ) : (
            <div className="tile-change flat">
              <span className="tile-comparison">
                {data.value === null
                  ? "No data for this period yet"
                  : `No data to compare ${COMPARISON_LABELS[tile.period]}`}
              </span>
            </div>
          )}
          <Sparkline
            series={data.series}
            unit={unit}
            hourly={tile.period === "today"}
            timeZone={data.timeZone}
          />
        </>
      ) : loading ? (
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
      )}

      <footer className="tile-footer">
        <span className="muted">{connection?.name ?? "—"}</span>
        {stale ? (
          <span className="tile-stale" title="The numbers may be out of date">
            <span aria-hidden="true">⚠</span> {stale}
          </span>
        ) : null}
        {data && error ? (
          <span className="tile-stale" title={error}>
            <span aria-hidden="true">⚠</span> Refresh failed
          </span>
        ) : null}
      </footer>
    </article>
  );
}
