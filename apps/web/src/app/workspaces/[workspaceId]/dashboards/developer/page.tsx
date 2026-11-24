import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import { listWorkspaces, readDeveloperTemplateOptions } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
import { DeveloperTemplateForm } from "./developer-template-form";
export const dynamic = "force-dynamic";

/** Installing the Developer Portfolio template (#876). */
export default async function DeveloperTemplatePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { forwarded } = await requireSession();
  const { workspaces } = await listWorkspaces(forwarded);
  const workspace = workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  if (!workspace) notFound();
  const t = await getT("developerTemplate");
  const allowed =
    can(workspace.role, "dashboards:create") &&
    can(workspace.role, "data:edit") &&
    can(workspace.role, "data:publish");
  const options = allowed
    ? await readDeveloperTemplateOptions(forwarded, workspaceId)
    : null;
  return (
    <div className="area-page store-template-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">{t("subtitle")}</p>
        </div>
        <Link href={`/workspaces/${workspaceId}/dashboards`}>{t("back")}</Link>
      </header>
      {options ? (
        <DeveloperTemplateForm
          workspaceId={workspaceId}
          projectId={workspace.activeProjectId}
          options={options}
        />
      ) : (
        <p className="notice">{t("roleCannot")}</p>
      )}
    </div>
  );
}
