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

import { StoreUpdateReview } from "../../../stores/updates/[requestId]/store-update-review";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("storeUpdate");
  return { title: `${t("review")} · netrics` };
}

/**
 * An update of a Developer Portfolio install (#876), reviewed, applied,
 * copied and swapped like an App Portfolio update (11E). It has no app
 * scope to change.
 */
export default async function DeveloperUpdatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; requestId: string }>;
}) {
  const { workspaceId, requestId } = await params;
  const { forwarded } = await requireSession();
  const { workspaces } = await listWorkspaces(forwarded);
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
    listStoreTemplateInstalls(forwarded, workspaceId, "developer"),
    can(role, "devices:view")
      ? listDevices(forwarded, workspaceId).then(({ devices }) => devices)
      : null,
    listDashboards(forwarded, workspaceId, { archived: "include" }),
  ]);
  const found = installs.find((entry) => entry.requestId === requestId);
  if (!found) notFound();
  const install = { ...found, template: "developer" as const };
  return (
    <div className="area-page store-update-page">
      <header className="page-header">
        <div>
          <h1>{t("title", { name: install.name })}</h1>
        </div>
        <div className="actions">{back}</div>
      </header>
      <StoreUpdateReview
        workspaceId={workspaceId}
        install={install}
        template="developer"
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
