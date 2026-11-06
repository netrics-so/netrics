import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import { listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";
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
