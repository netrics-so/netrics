"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";

import { tvGrid } from "@/lib/tv-grid";

import { MetricTile, type TileConnection } from "../metric-tile";

const IDLE_MS = 3000;

function formatClock(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

/** The time in the workspace's zone, updated every 15 seconds. */
function useClock(timeZone: string): string {
  const [now, setNow] = useState(() => formatClock(timeZone));
  useEffect(() => {
    setNow(formatClock(timeZone));
    const timer = setInterval(() => setNow(formatClock(timeZone)), 15_000);
    return () => clearInterval(timer);
  }, [timeZone]);
  return now;
}

/** Hides the cursor and chrome after a few seconds without movement. */
function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
  return idle;
}

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
  const clock = useClock(timeZone);
  const idle = useIdle();
  const { columns, rows } = tvGrid(dashboard.tiles.length);
  const metricsById = new Map(
    metrics.map((metric) => [`${metric.connectionId}|${metric.key}`, metric]),
  );

  return (
    <div className={idle ? "tv tv--idle" : "tv"}>
      <header className="tv-header">
        <h1 className="tv-title">{dashboard.name}</h1>
        <div className="tv-meta">
          <span>{clock}</span>
          <Link
            className="tv-exit"
            href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
          >
            Exit TV mode
          </Link>
        </div>
      </header>
      {dashboard.tiles.length === 0 ? (
        <p className="tv-empty">This dashboard has no tiles yet.</p>
      ) : (
        <div
          className="tv-grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
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
        </div>
      )}
    </div>
  );
}
