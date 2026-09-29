"use client";

import Link from "next/link";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";

import { TvFrame, useClock } from "@/components/tv-frame";

import { MetricTile, type TileConnection } from "../metric-tile";
import { useServerRefresh } from "../use-server-refresh";

export function TvDashboard({
  workspaceId,
  timeZone,
  dashboard,
  metrics,
  connections,
}: {
  workspaceId: string;
  timeZone: string;
  dashboard: Dashboard;
  metrics: WorkspaceMetric[];
  connections: Record<string, TileConnection>;
}) {
  // A wall screen runs for days: pick up tile edits and sync health.
  useServerRefresh();
  const clock = useClock(timeZone);
  const metricsById = new Map(
    metrics.map((metric) => [`${metric.connectionId}|${metric.key}`, metric]),
  );

  return (
    <TvFrame
      title={dashboard.name}
      tileCount={dashboard.tiles.length}
      meta={
        <>
          <span>{clock}</span>
          <Link
            className="tv-exit"
            href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
          >
            Exit TV mode
          </Link>
        </>
      }
    >
      {dashboard.tiles.map((tile) => (
        <MetricTile
          key={tile.id}
          variant="tv"
          workspaceId={workspaceId}
          tile={tile}
          metric={metricsById.get(`${tile.connectionId}|${tile.metricKey}`)}
          connection={connections[tile.connectionId]}
        />
      ))}
    </TvFrame>
  );
}
