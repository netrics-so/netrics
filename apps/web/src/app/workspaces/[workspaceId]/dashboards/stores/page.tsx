import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import {
  ApiError,
  listStoreTemplateInstalls,
  listWorkspaces,
  readStoreTemplateOptions,
  readStoreTemplateProducts,
  readStoreTemplateScope,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { scopeNeedsUpdateFirst, storeUpdatePath } from "@/lib/store-updates";
import { StoreInstallEditor } from "./store-install-editor";
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
    // A newer template version is reviewed first, as the server requires.
    // An update that only follows changed apps (#709) leaves them editable.
    const versionUpdate = !!install && scopeNeedsUpdateFirst(install);
    const [scope, options, products] =
      install && install.error === null && !versionUpdate
        ? await Promise.all([
            readStoreTemplateScope(cookieHeader, workspaceId, installId),
            readStoreTemplateOptions(cookieHeader, workspaceId),
            // App identity failing (e.g. over the row limit) must not take
            // the scope editor with it: the section explains it in place.
            readStoreTemplateProducts(
              cookieHeader,
              workspaceId,
              installId,
            ).then(
              (value) => ({ value }),
              (error: unknown) => ({
                error:
                  error instanceof ApiError
                    ? { status: error.status, code: error.code }
                    : { status: 503, code: "data_operation_failed" },
              }),
            ),
          ])
        : [null, null, null];
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
        ) : versionUpdate ? (
          <p className="notice">
            {t("editUpdateFirst")}{" "}
            <Link href={storeUpdatePath(workspaceId, installId)}>
              {t("editOpenUpdate")}
            </Link>
          </p>
        ) : install && scope && options && products ? (
          <>
            {install.updateAvailable ? (
              <p className="notice">
                {t("appSlidesUpdate")}{" "}
                <Link href={storeUpdatePath(workspaceId, installId)}>
                  {t("editOpenUpdate")}
                </Link>
              </p>
            ) : null}
            <StoreInstallEditor
              workspaceId={workspaceId}
              install={{ requestId: installId, name: install.name, scope }}
              options={options}
              products={products}
            />
          </>
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
