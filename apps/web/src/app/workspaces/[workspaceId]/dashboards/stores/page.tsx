import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import {
  listStoreTemplateInstalls,
  listWorkspaces,
  readStoreTemplateOptions,
  readStoreTemplateScope,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { storeUpdatePath } from "@/lib/store-updates";
import { StoreTemplateForm } from "./store-template-form";
export const dynamic = "force-dynamic";
export default async function StoreTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params,
    query = await searchParams;
  const { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const workspace = workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  if (!workspace) notFound();
  const t = await getT("storeTemplate");
  // ?install=<requestId>: change the connections and app scope of an
  // install (data:edit and dashboards:create, like applying an update).
  const installId = typeof query.install === "string" ? query.install : null;
  if (installId) {
    const allowed =
      can(workspace.role, "dashboards:create") &&
      can(workspace.role, "data:edit");
    const install = allowed
      ? (
          await listStoreTemplateInstalls(cookieHeader, workspaceId)
        ).installs.find((entry) => entry.requestId === installId)
      : undefined;
    if (allowed && !install) notFound();
    const [scope, options] =
      install && install.error === null && !install.updateAvailable
        ? await Promise.all([
            readStoreTemplateScope(cookieHeader, workspaceId, installId),
            readStoreTemplateOptions(cookieHeader, workspaceId),
          ])
        : [null, null];
    return (
      <div className="area-page store-template-page">
        <header className="page-header">
          <div>
            <h1>{t("editTitle", { name: install?.name ?? "" })}</h1>
            <p className="page-meta">{t("editSubtitle")}</p>
          </div>
          <Link href={`/workspaces/${workspaceId}/dashboards`}>
            {t("back")}
          </Link>
        </header>
        {!allowed ? (
          <p className="notice">{t("editRoleCannot")}</p>
        ) : install?.updateAvailable && install.error === null ? (
          <p className="notice">
            {t("editUpdateFirst")}{" "}
            <Link href={storeUpdatePath(workspaceId, installId)}>
              {t("editOpenUpdate")}
            </Link>
          </p>
        ) : install && scope && options ? (
          <StoreTemplateForm
            workspaceId={workspaceId}
            install={{ requestId: installId, name: install.name, scope }}
            initialOptions={options}
          />
        ) : (
          <p className="notice">{t("editUnavailable")}</p>
        )}
      </div>
    );
  }
  return (
    <div className="area-page store-template-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">{t("subtitle")}</p>
        </div>
        <Link href={`/workspaces/${workspaceId}/dashboards`}>{t("back")}</Link>
      </header>
      {can(workspace.role, "dashboards:create") &&
      can(workspace.role, "data:publish") ? (
        <StoreTemplateForm
          workspaceId={workspaceId}
          projectId={workspace.activeProjectId}
          initialConnectionId={
            typeof query.connection === "string" ? query.connection : undefined
          }
        />
      ) : (
        <p className="notice">{t("roleCannot")}</p>
      )}
    </div>
  );
}
