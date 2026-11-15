import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/dashboards.css";
import {
  listDashboards,
  listDevices,
  listStoreTemplateInstalls,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { storeScopePath } from "@/lib/store-updates";

import { StoreUpdateReview } from "./store-update-review";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("storeUpdate");
  return { title: `${t("review")} · netrics` };
}

/**
 * A store-template update of one install (11E): review and apply it as
 * data drafts, then publish, copy, compare and swap. Applying needs
 * data:edit and dashboards:create; the copy and swap buttons check their
 * own capabilities.
 */
export default async function StoreUpdatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; requestId: string }>;
}) {
  const { workspaceId, requestId } = await params;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) notFound();
  const role = membership.role;
  const t = await getT("storeUpdate");
  const back = (
    <Link href={`/workspaces/${workspaceId}/dashboards`}>{t("back")}</Link>
  );
  if (!can(role, "data:edit") || !can(role, "dashboards:create"))
    return (
      <div className="area-page store-update-page">
        <header className="page-header">
          <div>
            <h1>{t("review")}</h1>
          </div>
          {back}
        </header>
        <p className="notice">{t("roleCannot")}</p>
      </div>
    );
  const [{ installs }, devices, { dashboards }] = await Promise.all([
    listStoreTemplateInstalls(cookieHeader, workspaceId),
    can(role, "devices:view")
      ? listDevices(cookieHeader, workspaceId).then(({ devices }) => devices)
      : null,
    listDashboards(cookieHeader, workspaceId, { archived: "include" }),
  ]);
  const install = installs.find((entry) => entry.requestId === requestId);
  if (!install) notFound();
  return (
    <div className="area-page store-update-page">
      <header className="page-header">
        <div>
          <h1>{t("title", { name: install.name })}</h1>
        </div>
        <div className="actions">
          {/* The roles the dashboard page shows the link to. */}
          {install.error === null &&
          can(role, "data:edit") &&
          can(role, "dashboards:create") ? (
            <Link href={storeScopePath(workspaceId, requestId)}>
              {t("changeApps")}
            </Link>
          ) : null}
          {back}
        </div>
      </header>
      <StoreUpdateReview
        workspaceId={workspaceId}
        install={install}
        screens={
          devices?.map(({ id, name, dashboardId, revokedAt }) => ({
            id,
            name,
            dashboardId,
            revokedAt,
          })) ?? null
        }
        dashboardNames={Object.fromEntries(
          dashboards.map((dashboard) => [dashboard.id, dashboard.name]),
        )}
        canCopy={can(role, "dashboards:create")}
        canSwap={can(role, "dashboards:update") && can(role, "devices:manage")}
      />
    </div>
  );
}
