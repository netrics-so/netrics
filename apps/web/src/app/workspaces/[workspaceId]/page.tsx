import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { OAuthOutcomeBanner } from "./connections/oauth-outcome";
import { ViewerHint } from "./viewer-hint";
import {
  getWorkspace,
  listConnections,
  listDashboards,
  listDevices,
  listWorkspaces,
} from "@/lib/api";
import {
  isScreenOnline,
  sourcesNeedingAttention,
  workspacePath,
} from "@/lib/app-nav";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { navigationQuery, projectScope } from "@/lib/project-scope";
import { requireSession } from "@/lib/session";
import { connectTvHref } from "@/lib/device-platform";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.home");
  return { title: t("metaTitle") };
}

interface WorkspacePageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Query keys of the old all-in-one page that belong to Sources now. */
const SOURCES_QUERY = ["disconnected", "revoked", "keyRemoved"];

/**
 * Workspace home (#302): what the workspace has at a glance, with the way
 * to each area and the first things to do.
 */
export default async function WorkspaceHomePage({
  params,
  searchParams,
}: WorkspacePageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;
  // Links from before the split (a deleted connection's outcome) go on
  // to Sources, where the connections are now.
  if (Object.keys(query).some((key) => SOURCES_QUERY.includes(key))) {
    const forward = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const one of [value ?? []].flat()) {
        forward.append(key, one);
      }
    }
    redirect(`${workspacePath(workspaceId, "sources")}?${forward}`);
  }
  const outcome = parseOAuthOutcome(query.oauth);
  const { forwarded } = await requireSession();
  const [t, roles] = await Promise.all([
    getT("workspace"),
    getT("common.roles"),
  ]);

  const [{ workspaces }, workspaceResult] = await Promise.all([
    listWorkspaces(forwarded),
    getWorkspace(forwarded, workspaceId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership) {
    notFound();
  }
  const role = membership.role;
  // Dashboards and sources of the active project (#573); source health
  // stays workspace-wide, like the shell's badge: a failing source in
  // another project still needs attention.
  const scoped = navigationQuery(projectScope(membership.activeProjectId, []));
  const [
    { dashboards },
    { connections },
    { connections: allConnections },
    devices,
  ] = await Promise.all([
    listDashboards(forwarded, workspaceId, scoped),
    listConnections(forwarded, workspaceId, scoped),
    listConnections(forwarded, workspaceId),
    can(role, "devices:view")
      ? listDevices(forwarded, workspaceId).then((r) =>
          r.devices.filter((device) => device.revokedAt === null),
        )
      : null,
  ]);
  const now = Date.now();
  const online = devices?.filter((d) => isScreenOnline(d, now)).length ?? 0;
  const attention = sourcesNeedingAttention(allConnections);
  const at = (area: string) => workspacePath(workspaceId, area);

  return (
    <div className="area-page home-page">
      <header className="page-header">
        <div>
          <h1>{workspaceResult.workspace.name}</h1>
          <p className="page-meta">
            {t("yourRole")} <span className="role-badge">{roles(role)}</span>
          </p>
        </div>
      </header>
      <OAuthOutcomeBanner outcome={outcome} />

      <div className="overview-grid">
        <section className="card overview-card" aria-labelledby="home-dash">
          <h2 id="home-dash" className="section-label">
            {t("home.dashboards")}
          </h2>
          <p className="overview-value">
            {t("dashboardCount", { count: dashboards.length })}
          </p>
          <p className="overview-link">
            <Link href={at("dashboards")}>{t("home.allDashboards")}</Link>
          </p>
        </section>

        {devices ? (
          <section className="card overview-card" aria-labelledby="home-tv">
            <h2 id="home-tv" className="section-label">
              {t("home.screens")}
            </h2>
            <p className="overview-value">
              {devices.length === 0 ? (
                t("home.noScreens")
              ) : (
                <>
                  <span
                    className={`dot ${online > 0 ? "up" : "down"}`}
                    aria-hidden="true"
                  />
                  {t("home.online", { online, total: devices.length })}
                </>
              )}
            </p>
            <p className="overview-link">
              <Link href={at("screens")}>{t("home.allScreens")}</Link>
            </p>
          </section>
        ) : null}

        <section className="card overview-card" aria-labelledby="home-src">
          <h2 id="home-src" className="section-label">
            {t("home.sources")}
          </h2>
          <p className="overview-value">
            {t("sourceCount", { count: connections.length })}
          </p>
          {allConnections.length > 0 ? (
            <p
              className={`overview-health ${attention > 0 ? "attention" : "fresh"}`}
            >
              <span
                className={`dot ${attention > 0 ? "warning" : "up"}`}
                aria-hidden="true"
              />
              {attention > 0
                ? t("home.attention", { count: attention })
                : t("home.allFresh")}
            </p>
          ) : null}
          <p className="overview-link">
            <Link href={at("sources")}>{t("home.allSources")}</Link>
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="home-actions">
        <h2 id="home-actions" className="section-label">
          {t("home.quickActions")}
        </h2>
        <div className="quick-actions">
          {can(role, "dashboards:create") ? (
            <Link
              href={`${at("dashboards")}#new-dashboard`}
              className="button primary"
            >
              {t("home.newDashboard")}
            </Link>
          ) : null}
          {can(role, "devices:manage") ? (
            <Link href={connectTvHref(workspaceId)} className="button">
              {t("connectTv")}
            </Link>
          ) : null}
          {can(role, "connections:create") ? (
            <Link href={at("connections/new")} className="button">
              {t("home.addSource")}
            </Link>
          ) : null}
        </div>
        <ViewerHint role={role} workspaceId={workspaceId} />
      </section>
    </div>
  );
}
