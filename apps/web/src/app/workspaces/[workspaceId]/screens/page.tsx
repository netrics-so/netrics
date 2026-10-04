import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { ScreensView, type ScreenItem } from "./screens-view";
import {
  getDashboard,
  listDashboards,
  listDevices,
  listThemes,
  listWorkspaces,
} from "@/lib/api";
import { isScreenOnline } from "@/lib/app-nav";
import {
  isAppleTv,
  rotationKey,
  summarizeHeartbeat,
  summarizeScreen,
} from "@/lib/device-heartbeat";
import { getLocale, getT } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/relative-time";
import {
  assignedDashboardIds,
  countScreens,
  screenPreview,
} from "@/lib/screens";
import { requireSession } from "@/lib/session";

import "@/app/styles/screens.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("screens")} · netrics` };
}

interface ScreensPageProps {
  params: Promise<{ workspaceId: string }>;
}

/** The workspace's TVs and browser kiosks, and connecting one (#303). */
export default async function ScreensPage({ params }: ScreensPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const [t, deviceT] = await Promise.all([getT("screens"), getT("devices")]);

  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "devices:view")) {
    notFound();
  }
  const [{ devices: all }, { dashboards }] = await Promise.all([
    listDevices(cookieHeader, workspaceId),
    listDashboards(cookieHeader, workspaceId),
  ]);

  // The dashboards the screens show, each fetched once and in parallel,
  // for their first slide and theme; custom themes from one list.
  const shown = await Promise.all(
    assignedDashboardIds(all).map((id) =>
      getDashboard(cookieHeader, workspaceId, id).then(
        (response) => response?.dashboard ?? null,
      ),
    ),
  );
  const shownById = new Map(
    shown.flatMap((dashboard) =>
      dashboard ? [[dashboard.id, dashboard]] : [],
    ),
  );
  const customThemes = [...shownById.values()].some(
    (dashboard) => dashboard.settings.themeId !== null,
  )
    ? new Map(
        (await listThemes(cookieHeader, workspaceId)).themes.map((theme) => [
          theme.id,
          theme,
        ]),
      )
    : new Map();

  // Active screens first, revoked ones after (the sort is stable).
  const devices = all.toSorted(
    (a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null),
  );
  const now = Date.now();
  const dashboardNames = new Map(dashboards.map((d) => [d.id, d.name]));
  const pairedFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const screens: ScreenItem[] = devices.map((device) => {
    const screen = summarizeScreen(device.screen);
    // "3840 × 2160 · 16:9 · Screen view", plus the orientation when the
    // TV is turned (#276).
    const parts = [
      ...(screen
        ? [
            t("screenSize", { width: screen.width, height: screen.height }),
            ...(screen.format ? [screen.format] : []),
            deviceT(`modes.${screen.mode}`),
          ]
        : []),
      ...(device.rotation !== 0
        ? [deviceT(`rotations.${rotationKey(device.rotation)}`)]
        : []),
    ];
    const dashboard =
      device.revokedAt === null && device.dashboardId
        ? (shownById.get(device.dashboardId) ?? null)
        : null;
    const themeId = dashboard?.settings.themeId;
    return {
      device,
      online: isScreenOnline(device, now),
      lastSeen: relativeTime(device.lastSeenAt, locale, now),
      revoked: device.revokedAt
        ? relativeTime(device.revokedAt, locale, now)
        : null,
      dashboardName:
        (device.dashboardId && dashboardNames.get(device.dashboardId)) || null,
      preview: screenPreview(
        dashboard,
        themeId ? (customThemes.get(themeId) ?? null) : null,
      ),
      appleTv: isAppleTv(device.heartbeat),
      heartbeat: summarizeHeartbeat(device.heartbeat, locale),
      screenLine: parts.length > 0 ? parts.join(" · ") : null,
      paired: pairedFormat.format(new Date(device.createdAt)),
    };
  });

  return (
    <ScreensView
      workspaceId={workspaceId}
      screens={screens}
      counts={countScreens(devices, now)}
      dashboards={dashboards.map(({ id, name }) => ({ id, name }))}
      canManage={can(membership.role, "devices:manage")}
    />
  );
}
