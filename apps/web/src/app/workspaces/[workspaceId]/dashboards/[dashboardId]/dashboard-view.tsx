"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";

import {
  apiErrorMessage,
  deleteDashboard,
  duplicateDashboard,
} from "@/lib/api";
import { pickableMetrics } from "@/lib/format-metric";
import type { ResolvedTheme } from "@/lib/studio-theme";
import type { StudioEnv, StudioImage } from "@/lib/studio-widgets";

import type { TileConnection } from "./metric-tile";
import { SlideViewer } from "./slide-viewer";
import { useServerRefresh } from "./use-server-refresh";
import { useLocale } from "@/lib/i18n/client";

function metricId(metric: WorkspaceMetric) {
  return `${metric.connectionId}|${metric.key}`;
}

/**
 * A dashboard's slides with live data, and what the role may do with it.
 * Every dashboard, tile dashboards included, is edited in the Studio
 * (#223, #225).
 */
export function DashboardView({
  workspaceId,
  dashboard: initial,
  metrics,
  connections,
  canEdit,
  canDuplicate,
  canDelete,
  theme,
  timeZone,
  images,
}: {
  workspaceId: string;
  dashboard: Dashboard;
  metrics: WorkspaceMetric[];
  connections: Record<string, TileConnection>;
  /** The dashboard's theme, resolved on the server (#216). */
  theme: ResolvedTheme;
  /** The workspace's time zone, for clocks and chart labels. */
  timeZone: string;
  /** The workspace images the slides show (#217). */
  images: StudioImage[];
  canEdit: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
}) {
  const locale = useLocale();
  const router = useRouter();
  useServerRefresh();
  const [dashboard, setDashboard] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the server's copy when it changes (refreshed every minute), so
  // changes saved elsewhere show up.
  useEffect(() => {
    setDashboard(initial);
  }, [initial]);

  const metricsById = useMemo(
    () => new Map(metrics.map((metric) => [metricId(metric), metric])),
    [metrics],
  );
  const pickable = pickableMetrics(metrics);
  const env: StudioEnv = useMemo(
    () => ({
      workspaceId,
      timeZone,
      fontScale: theme.tokens.fontScale,
      showHeader: dashboard.settings.showHeader,
      metrics: metricsById,
      connections,
      images: new Map(images.map((image) => [image.id, image])),
    }),
    [
      workspaceId,
      timeZone,
      theme.tokens.fontScale,
      dashboard.settings.showHeader,
      metricsById,
      connections,
      images,
    ],
  );
  const widgetCount = dashboard.slides.reduce(
    (sum, slide) => sum + slide.widgets.length,
    0,
  );
  const studioHref = `/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`;

  async function onDuplicate() {
    setPending(true);
    try {
      const copy = await duplicateDashboard(workspaceId, dashboard.id);
      router.push(`/workspaces/${workspaceId}/dashboards/${copy.dashboard.id}`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete dashboard "${dashboard.name}"?`)) {
      return;
    }
    setPending(true);
    try {
      await deleteDashboard(workspaceId, dashboard.id);
      router.push(`/workspaces/${workspaceId}`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <>
      <div className="dashboard-header">
        <h1>{dashboard.name}</h1>
        <div className="actions">
          {canEdit ? (
            <Link href={studioHref}>
              <button type="button" className="primary">
                Open in Studio
              </button>
            </Link>
          ) : null}
          <Link
            href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}/tv`}
          >
            <button type="button">TV mode</button>
          </Link>
          {canDuplicate ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void onDuplicate()}
            >
              Duplicate
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="danger"
              disabled={pending}
              onClick={() => void onDelete()}
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {widgetCount === 0 ? (
        <div className="card">
          <p>This dashboard has no widgets yet.</p>
          {pickable.length === 0 ? (
            <p className="muted">
              Widgets show metrics from your connections.{" "}
              <Link href={`/workspaces/${workspaceId}/connections/new`}>
                Add a connection
              </Link>{" "}
              first.
            </p>
          ) : canEdit ? (
            <Link href={studioHref}>
              <button type="button" className="primary">
                Open in Studio
              </button>
            </Link>
          ) : null}
        </div>
      ) : (
        <SlideViewer dashboard={dashboard} tokens={theme.tokens} env={env} />
      )}
    </>
  );
}
