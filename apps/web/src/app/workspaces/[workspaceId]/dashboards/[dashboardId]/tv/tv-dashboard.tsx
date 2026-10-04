"use client";

import Link from "next/link";
import { useMemo } from "react";

import type { Dashboard, WorkspaceMetric } from "@netrics/contracts";

import { LiveWidget, useOffline } from "@/components/studio/slide-canvas";
import { SlidePlayer } from "@/components/studio/slide-player";
import { useIdle } from "@/components/tv-frame";
import { documentRotation } from "@/lib/slide-rotation";
import { themeStyle, type ResolvedTheme } from "@/lib/studio-theme";
import {
  logoImageId,
  type StudioEnv,
  type StudioImage,
} from "@/lib/studio-widgets";

import type { TileConnection } from "../metric-tile";
import { useServerRefresh } from "../use-server-refresh";

/**
 * The signed-in TV mode (#52, #221): the same slide player as a paired
 * kiosk, fed by the dashboard document and live widget queries instead of
 * the device payload. The session already authorises those queries, so no
 * second, session-side payload builder is needed; the rotation rules
 * (enabled slides, durations, transition) are the payload's.
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
  useServerRefresh();
  const idle = useIdle();
  const offline = useOffline();
  const { settings } = dashboard;

  const env: StudioEnv = useMemo(
    () => ({
      workspaceId,
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
    () => documentRotation(dashboard.slides, settings),
    [dashboard.slides, settings],
  );

  return (
    <div
      className={idle ? "slide-screen slide-screen--idle" : "slide-screen"}
      style={themeStyle(theme.tokens)}
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
          timeZone,
          offline,
        }}
        images={env.images}
        renderWidget={(widget) => <LiveWidget widget={widget} env={env} />}
        empty={
          <p className="tv-empty">
            Every slide is hidden. Show at least one slide to play this
            dashboard.
          </p>
        }
      />
      <div className="slide-screen-status">
        <Link
          className="tv-exit"
          href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
        >
          Exit TV mode
        </Link>
      </div>
    </div>
  );
}
