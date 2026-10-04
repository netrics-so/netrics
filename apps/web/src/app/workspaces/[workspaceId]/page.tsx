import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { CreateDashboardForm } from "./create-dashboard-form";
import { CreateProjectForm } from "./create-project-form";
import { DisconnectResult } from "./connections/disconnect-result";
import { OAuthOutcomeBanner } from "./connections/oauth-outcome";
import { DeviceControls } from "./device-controls";
import { HealthBadge } from "./health-badge";
import {
  getWorkspace,
  listConnections,
  listConnectors,
  listDashboards,
  listDevices,
  listProjects,
  listWorkspaces,
} from "@/lib/api";
import {
  isAppleTv,
  rotationKey,
  summarizeHeartbeat,
  summarizeScreen,
} from "@/lib/device-heartbeat";
import { parseDisconnected, parseOAuthOutcome } from "@/lib/oauth-connection";
import { getLocale, getT } from "@/lib/i18n/server";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import { parseKeyRemoved } from "@/lib/signed-key";
import { nextSyncLabel } from "@/lib/sync-schedule";

export const dynamic = "force-dynamic";

interface WorkspacePageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WorkspacePage({
  params,
  searchParams,
}: WorkspacePageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const outcome = parseOAuthOutcome(query.oauth);
  const disconnected = parseDisconnected(query);
  const keyRemoved = parseKeyRemoved(query);
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");
  const roles = await getT("common.roles");
  const deviceT = await getT("devices");

  const [{ workspaces }, workspaceResult] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership) {
    notFound();
  }

  const { projects } = await listProjects(cookieHeader, workspaceId);
  const { connections } = await listConnections(cookieHeader, workspaceId);
  const { dashboards } = await listDashboards(cookieHeader, workspaceId);
  // After deleting a connection with an uploaded key: where to revoke it.
  const removedKey = keyRemoved
    ? (await listConnectors(cookieHeader)).connectors
        .flatMap((connector) => connector.authStrategies)
        .find(
          (strategy) =>
            strategy.strategy === "signed-key" &&
            strategy.provider === keyRemoved,
        )
    : undefined;
  const role = membership.role;
  // Active TVs first, revoked ones after (the sort is stable).
  const devices = can(role, "devices:view")
    ? (await listDevices(cookieHeader, workspaceId)).devices.toSorted(
        (a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null),
      )
    : null;
  const dashboardNames = new Map(dashboards.map((d) => [d.id, d.name]));
  const connectTv = can(role, "devices:manage") ? (
    <p>
      <Link href="/devices/approve">{t("connectTv")}</Link>
    </p>
  ) : null;

  return (
    <>
      <h1>{workspaceResult.workspace.name}</h1>
      <OAuthOutcomeBanner outcome={outcome} />
      <DisconnectResult revocation={disconnected} />
      {removedKey ? (
        <div className="notice page-alert" role="status">
          <p>
            {removedKey.providerName
              ? t("keyRemoved", { name: removedKey.providerName })
              : t("keyRemovedUnnamed")}{" "}
            {removedKey.setup?.url ? (
              <a href={removedKey.setup.url} target="_blank" rel="noreferrer">
                {removedKey.providerName
                  ? t("revokeIn", { name: removedKey.providerName })
                  : t("revokeAtProvider")}{" "}
                ↗
              </a>
            ) : null}
          </p>
        </div>
      ) : null}
      <p className="subtitle">
        {t("yourRole")} <span className="role-badge">{roles(role)}</span>
      </p>

      <div className="card">
        <h2>{t("workspaces")}</h2>
        <ul className="workspace-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              {workspace.id === workspaceId ? (
                <span className="current">
                  {t("current", {
                    name: workspace.name,
                    role: roles(workspace.role),
                  })}
                </span>
              ) : (
                <Link href={`/workspaces/${workspace.id}`}>
                  {workspace.name}
                </Link>
              )}
            </li>
          ))}
        </ul>
        <p className="muted">
          <Link href={`/workspaces/${workspaceId}/settings`}>
            {t("settings")}
          </Link>
        </p>
      </div>

      <div className="card">
        <h2>{t("dashboards")}</h2>
        {dashboards.length === 0 ? (
          <p className="muted">{t("noDashboards")}</p>
        ) : (
          <ul className="workspace-list">
            {dashboards.map((dashboard) => (
              <li key={dashboard.id}>
                <Link
                  href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}`}
                >
                  {dashboard.name}
                </Link>{" "}
                <span className="muted">
                  {t("dashboardMeta", {
                    slides: dashboard.slideCount,
                    widgets: dashboard.widgetCount,
                    updated: relativeTime(dashboard.updatedAt, locale),
                  })}
                </span>
                {can(role, "dashboards:update") ? (
                  <>
                    {" "}
                    <Link
                      href={`/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`}
                      className="studio-link"
                      aria-label={t("openInStudio", { name: dashboard.name })}
                    >
                      {t("studio")}
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {can(role, "dashboards:create") ? (
          <CreateDashboardForm workspaceId={workspaceId} />
        ) : null}
      </div>

      {devices ? (
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
          {connectTv}
        </div>
      ) : null}

      <div className="card">
        <h2>{t("connections")}</h2>
        {connections.length === 0 ? (
          <p className="muted">{t("noConnections")}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("table.name")}</th>
                <th>{t("table.connector")}</th>
                <th>{t("table.health")}</th>
                <th>{t("table.lastSuccess")}</th>
                <th>{t("table.nextSync")}</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <Link
                      href={`/workspaces/${workspaceId}/connections/${connection.id}`}
                    >
                      {connection.name}
                    </Link>
                  </td>
                  <td className="muted">
                    {connection.connectorName} {connection.connectorVersion}
                  </td>
                  <td>
                    {connection.setupPending ? (
                      <Link
                        className="health-badge pending"
                        href={`/workspaces/${workspaceId}/connections/${connection.id}#finish-setup`}
                      >
                        {t("finishSetup")}
                      </Link>
                    ) : (
                      <HealthBadge health={connection.state.health} />
                    )}
                  </td>
                  <td className="muted">
                    {relativeTime(connection.state.lastSuccessAt, locale)}
                  </td>
                  <td className="muted">
                    {nextSyncLabel(connection.state, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {can(role, "connections:create") ? (
          <p>
            <Link href={`/workspaces/${workspaceId}/connections/new`}>
              <button type="button" className="primary">
                {t("addConnection")}
              </button>
            </Link>
          </p>
        ) : (
          <p className="muted">{t("cannotCreateConnections")}</p>
        )}
      </div>

      <div className="card">
        <h2>{t("projects")}</h2>
        {projects.length === 0 ? (
          <p className="muted">{t("noProjects")}</p>
        ) : (
          <ul className="workspace-list">
            {projects.map((project) => (
              <li key={project.id}>{project.name}</li>
            ))}
          </ul>
        )}
        {can(role, "projects:create") ? (
          <CreateProjectForm workspaceId={workspaceId} />
        ) : (
          <p className="muted">{t("cannotCreateProjects")}</p>
        )}
      </div>
    </>
  );
}
