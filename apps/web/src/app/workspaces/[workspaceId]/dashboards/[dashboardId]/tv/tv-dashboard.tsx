"use client";
import { DashboardDataProvider } from "@/components/studio/dashboard-data-provider";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";

import { LiveWidget, useOffline } from "@/components/studio/slide-canvas";
import { SlidePlayer } from "@/components/studio/slide-player";
import { useWidgetRefreshCycle } from "@/components/studio/use-widget-data";
import { clockTime, useIdle } from "@/components/tv-frame";
import { useLocale, useT } from "@/lib/i18n/client";
import { documentRotation } from "@/lib/slide-rotation";
import { themeStyle, type ResolvedTheme } from "@/lib/studio-theme";
import {
  logoImageId,
  scopedSlide,
  type StudioEnv,
  type StudioImage,
} from "@/lib/studio-widgets";
import { useWakeLock } from "@/lib/use-screen";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

import type { TileConnection } from "../metric-tile";
import { useServerRefresh } from "../use-server-refresh";

/**
 * The signed-in TV mode (#52, #221): the same slide player as a paired
 * kiosk, fed by the dashboard document and live widget queries instead of
 * the device payload. The session already authorises those queries, so no
 * second, session-side payload builder is needed; the rotation rules
 * (enabled slides, durations, transition) are the payload's. Screen view
 * on the whole window in its format (ADR 0017), kept awake. It hangs on a
 * wall like a paired screen, so it speaks as one: viewer wording without
 * editor instructions, and an offline note with the last update (#681,
 * as the kiosk since #649).
 */
export function TvDashboard({
  workspaceId,
  timeZone,
  dashboard,
  theme,
  images,
  metrics,
  connections,
}: {
  workspaceId: string;
  timeZone: string;
  dashboard: Dashboard;
  theme: ResolvedTheme;
  images: StudioImage[];
  metrics: WorkspaceMetric[];
  connections: Record<string, TileConnection>;
}) {
  // A wall screen runs for days: pick up slide edits and sync health.
  // A refresh only runs when the web app answers (#681).
  const reachable = useServerRefresh();
  const idle = useIdle();
  // Offline: no network, or a network that does not reach netrics.
  const offline = useOffline() || !reachable;
  const t = useT("screen.tv");
  const note = useT("screen.widget");
  const locale = useLocale();
  const { settings } = dashboard;
  const refresh = useWidgetRefreshCycle();
  useWakeLock(true);
  // The last update: the page's load, then each server refresh (new props:
  // sync health, tiles) and each measure load; offline, neither arrives.
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  useEffect(() => {
    setUpdatedAt(Date.now());
  }, [dashboard, metrics, connections]);
  // The viewer's zone, not the workspace's (#736).
  const viewerZone = useViewerTimeZone();
  const offlineSince = clockTime(updatedAt, viewerZone, locale);

  const env: StudioEnv = useMemo(
    () => ({
      workspaceId,
      audience: "viewer",
      dataFilters: dashboard.settings.dataFilters ?? [],
      timeZone,
      fontScale: theme.tokens.fontScale,
      showHeader: settings.showHeader,
      metrics: new Map(
        metrics.map((metric) => [
          `${metric.connectionId}|${metric.key}`,
          metric,
        ]),
      ),
      connections,
      images: new Map(images.map((image) => [image.id, image])),
    }),
    [
      workspaceId,
      timeZone,
      theme.tokens.fontScale,
      settings.showHeader,
      metrics,
      connections,
      images,
    ],
  );
  const slides = useMemo(
    // As screens show them: widgets follow their slide's scope (#707).
    () =>
      documentRotation(
        dashboard.slides.map((slide) =>
          scopedSlide(slide, dashboard.productApps),
        ),
        settings,
      ),
    [dashboard.slides, dashboard.productApps, settings],
  );

  return (
    <div
      className={idle ? "slide-screen slide-screen--idle" : "slide-screen"}
      style={themeStyle(theme.tokens)}
    >
      <DashboardDataProvider
        workspaceId={workspaceId}
        slides={dashboard.slides}
        filters={dashboard.settings.dataFilters ?? []}
        onLoaded={setUpdatedAt}
        keepLastGood
      >
        <SlidePlayer
          slides={slides}
          autoAdvance={settings.autoAdvance}
          transition={settings.transition}
          tokens={theme.tokens}
          showHeader={settings.showHeader}
          header={{
            name: dashboard.name,
            logoImageId: logoImageId(settings),
            offline,
            offlineSince,
            refresh,
          }}
          images={env.images}
          renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
          primaryFormat={dashboard.primaryFormat}
          empty={<p className="tv-empty">{t("allHidden")}</p>}
        />
      </DashboardDataProvider>
      <div className="slide-screen-status">
        {/* With the header the note is in it; without, in the corner. */}
        {offline && !settings.showHeader ? (
          <span className="kiosk-offline" role="status">
            {note("offlineSince", { time: offlineSince })}
          </span>
        ) : null}
        <Link
          className="tv-exit"
          href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
        >
          {t("exit")}
        </Link>
      </div>
    </div>
  );
}
