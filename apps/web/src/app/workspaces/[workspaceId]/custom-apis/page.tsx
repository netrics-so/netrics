import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/custom-api.css";
import { CustomApiDefinitionList } from "@/components/custom-api/definition-list";
import { listCustomApiDefinitions, listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("customApi.list");
  return { title: `${t("title")} · netrics` };
}

/** The workspace's custom APIs (#807): build one, edit or connect one. */
export default async function CustomApisPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { forwarded } = await requireSession();
  const t = await getT("customApi.list");
  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) notFound();
  const { definitions } = await listCustomApiDefinitions(
    forwarded,
    workspaceId,
  );
  const canCreate = can(membership.role, "connections:create");
  return (
    <div className="area-page custom-api-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">{t("subtitle")}</p>
        </div>
        {canCreate ? (
          <div className="page-actions">
            <Link
              href={`/workspaces/${workspaceId}/custom-apis/new`}
              className="button primary"
            >
              {t("build")}
            </Link>
          </div>
        ) : null}
      </header>
      <div className="card">
        <CustomApiDefinitionList
          workspaceId={workspaceId}
          definitions={definitions}
          canCreate={canCreate}
          canEdit={can(membership.role, "connections:update")}
        />
      </div>
    </div>
  );
}
