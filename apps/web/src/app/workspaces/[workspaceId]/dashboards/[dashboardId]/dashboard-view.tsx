"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";
import type { DisplayMode } from "@netrics/domain";

import {
  apiErrorMessage,
  deleteDashboard,
  duplicateDashboard,
} from "@/lib/api";
import { ScrollView } from "@/components/scroll/scroll-view";
import { LiveScrollWidget } from "@/components/scroll/scroll-widgets";
import { pickableMetrics } from "@/lib/format-metric";
import type { ResolvedTheme } from "@/lib/studio-theme";
import {
  logoImageId,
  type StudioEnv,
  type StudioImage,
} from "@/lib/studio-widgets";

import { DisplayModeSwitch, useDisplayMode } from "./display-mode-switch";
import type { TileConnection } from "./metric-tile";
import { SlideViewer } from "./slide-viewer";
import { useServerRefresh } from "./use-server-refresh";
import { useLocale, useT } from "@/lib/i18n/client";

function metricId(metric: WorkspaceMetric) {
  return `${metric.connectionId}|${metric.key}`;
}

/**
 * A dashboard's slides with live data, and what the role may do with it.
 * Every dashboard, tile dashboards included, is edited in the Studio
 * (#223, #225). Two display modes (ADR 0017, section 5): scroll view, a
 * responsive page with every slide as a section (phones and tablets by
 * default), and screen view, the slides on their canvas (desktops).
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
  initialMode = null,
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
  /** Tests: the mode to render with, instead of the browser's default. */
  initialMode?: DisplayMode | null;
}) {
  const locale = useLocale();
  const t = useT("dashboard");
  const common = useT("common");
  const router = useRouter();
  useServerRefresh();
  const [dashboard, setDashboard] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useDisplayMode(initialMode);

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
    if (!window.confirm(t("deleteConfirm", { name: dashboard.name }))) {
      return;
    }
    setPending(true);
    try {
      await deleteDashboard(workspaceId, dashboard.id);
      router.push(`/workspaces/${workspaceId}/dashboards`);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  const actions = (
    <div className="actions">
      <DisplayModeSwitch mode={mode} onChange={setMode} />
      {canEdit ? (
        <Link href={studioHref}>
          <button type="button" className="primary">
            {t("openStudio")}
          </button>
        </Link>
      ) : null}
      <Link href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}/tv`}>
        <button type="button">{t("tvMode")}</button>
      </Link>
      {canDuplicate ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void onDuplicate()}
        >
          {t("duplicate")}
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          className="danger"
          disabled={pending}
          onClick={() => void onDelete()}
        >
          {common("delete")}
        </button>
      ) : null}
    </div>
  );
  const errorBox = error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;

  if (widgetCount === 0) {
    return (
      <>
        <div className="dashboard-header">
          <h1>{dashboard.name}</h1>
          {actions}
        </div>
        {errorBox}
        <div className="card">
          <p>{t("empty")}</p>
          {pickable.length === 0 ? (
            <p className="muted">
              {t.rich("needsConnection", {
                link: (
                  <Link
                    key="link"
                    href={`/workspaces/${workspaceId}/connections/new`}
                  >
                    {t("addConnection")}
                  </Link>
                ),
              })}
            </p>
          ) : canEdit ? (
            <Link href={studioHref}>
              <button type="button" className="primary">
                {t("openStudio")}
              </button>
            </Link>
          ) : null}
        </div>
      </>
    );
  }

  if (mode === "scroll") {
    return (
      <>
        {errorBox}
        <ScrollView
          name={dashboard.name}
          logoImageId={logoImageId(dashboard.settings)}
          slides={dashboard.slides}
          tokens={theme.tokens}
          images={env.images}
          toolbar={actions}
          renderWidget={(widget, size) => (
            <LiveScrollWidget widget={widget} env={env} size={size} />
          )}
        />
      </>
    );
  }

  return (
    <>
      <div className="dashboard-header">
        <h1>{dashboard.name}</h1>
        {actions}
      </div>
      {errorBox}
      {mode === "screen" ? (
        <SlideViewer dashboard={dashboard} tokens={theme.tokens} env={env} />
      ) : (
        // Until the browser's default is known (after mount).
        <div className="display-mode-pending" aria-busy="true" />
      )}
    </>
  );
}
