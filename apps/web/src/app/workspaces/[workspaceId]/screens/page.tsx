import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { DeviceControls } from "../device-controls";
import { listDashboards, listDevices, listWorkspaces } from "@/lib/api";
import { isScreenOnline } from "@/lib/app-nav";
import {
  isAppleTv,
  rotationKey,
  summarizeHeartbeat,
  summarizeScreen,
} from "@/lib/device-heartbeat";
import { getLocale, getT } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("screens")} · netrics` };
}

interface ScreensPageProps {
  params: Promise<{ workspaceId: string }>;
}

/** The workspace's TVs and browser kiosks, and connecting one (#302). */
export default async function ScreensPage({ params }: ScreensPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const [t, deviceT] = await Promise.all([getT("workspace"), getT("devices")]);

  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "devices:view")) {
    notFound();
  }
  const role = membership.role;
  const [{ devices: all }, { dashboards }] = await Promise.all([
    listDevices(cookieHeader, workspaceId),
    listDashboards(cookieHeader, workspaceId),
  ]);
  // Active TVs first, revoked ones after (the sort is stable).
  const devices = all.toSorted(
    (a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null),
  );
  const active = devices.filter((device) => device.revokedAt === null);
  const now = Date.now();
  const online = active.filter((d) => isScreenOnline(d, now)).length;
  const dashboardNames = new Map(dashboards.map((d) => [d.id, d.name]));

  return (
    <div className="area-page screens-page">
      <header className="page-header">
        <div>
          <h1>{t("pages.screens")}</h1>
          <p className="page-meta">
            {t("screenCount", { total: active.length, online })}
          </p>
        </div>
        {can(role, "devices:manage") ? (
          <div className="page-actions">
            <Link href="/devices/approve" className="button primary">
              {t("connectTv")}
            </Link>
          </div>
        ) : null}
      </header>

      <div className="card">
        <h2>{t("tvs")}</h2>
        {devices.length === 0 ? (
          <p className="muted">{t("noTvs")}</p>
        ) : (
          <ul className="workspace-list device-list">
            {devices.map((device) => {
              const heartbeat = summarizeHeartbeat(device.heartbeat, locale);
              const screen = summarizeScreen(device.screen);
              // "3840 × 2160 · 16:9 · Screen view", plus the orientation
              // when the TV is turned (#276).
              const screenLine = [
                ...(screen
                  ? [
                      t("screenSize", {
                        width: screen.width,
                        height: screen.height,
                      }),
                      ...(screen.format ? [screen.format] : []),
                      deviceT(`modes.${screen.mode}`),
                    ]
                  : []),
                ...(device.rotation !== 0
                  ? [deviceT(`rotations.${rotationKey(device.rotation)}`)]
                  : []),
              ].join(" · ");
              return (
                <li key={device.id}>
                  <strong>{device.name}</strong>{" "}
                  {device.revokedAt ? (
                    <span className="role-badge">{t("revoked")}</span>
                  ) : null}{" "}
                  <span className="muted">
                    {(device.dashboardId &&
                      dashboardNames.get(device.dashboardId)) ??
                      t("noDashboard")}{" "}
                    ·{" "}
                    {t("lastSeen", {
                      time: relativeTime(device.lastSeenAt, locale),
                    })}
                    {heartbeat
                      ? ` · ${t("heartbeat", {
                          version: heartbeat.version,
                          time: heartbeat.at,
                        })}`
                      : null}
                  </span>
                  {heartbeat?.lastError ? (
                    <p
                      className="muted device-error"
                      title={heartbeat.lastErrorFull ?? undefined}
                    >
                      {t("lastError", { error: heartbeat.lastError })}
                    </p>
                  ) : null}
                  {screenLine && !device.revokedAt ? (
                    <p className="muted device-screen">{screenLine}</p>
                  ) : null}
                  {can(role, "devices:manage") && !device.revokedAt ? (
                    <DeviceControls
                      workspaceId={workspaceId}
                      device={device}
                      appleTv={isAppleTv(device.heartbeat)}
                      dashboards={dashboards}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
