import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/custom-api.css";
import "@/app/styles/data.css";
import { CustomApiBuilder } from "@/components/custom-api/builder";
import { BuilderOAuthOutcome } from "@/components/custom-api/oauth-outcome";
import {
  getCustomApiDefinition,
  listProjects,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("customApi.list");
  return { title: `${t("title")} · netrics` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A saved custom API (#807): the builder on its current version for
 * members who may change it (`connections:update`), a read-only summary
 * for everyone else.
 */
export default async function CustomApiPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; definitionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, definitionId } = await params;
  const query = await searchParams;
  if (!UUID.test(definitionId)) notFound();
  const { forwarded } = await requireSession();
  const t = await getT("customApi");
  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) notFound();
  const [response, { projects }] = await Promise.all([
    getCustomApiDefinition(forwarded, workspaceId, definitionId),
    listProjects(forwarded, workspaceId),
  ]);
  if (!response) notFound();
  const { definition } = response;
  const canEdit =
    can(membership.role, "connections:update") &&
    can(membership.role, "connections:create") &&
    definition.archivedAt === null;
  const draftId =
    typeof query.draft === "string" && UUID.test(query.draft)
      ? query.draft
      : null;
  return (
    <div className="area-page custom-api-page">
      <header className="page-header">
        <div>
          <h1>
            {canEdit
              ? t("title.edit", { name: definition.name })
              : t("title.view", { name: definition.name })}
          </h1>
          <p className="page-meta">
            {t("list.version", { version: definition.currentVersion })}
          </p>
        </div>
        {can(membership.role, "connections:create") &&
        definition.archivedAt === null ? (
          <div className="page-actions">
            <Link
              className="button"
              href={`/workspaces/${workspaceId}/custom-apis/${definition.id}/connect`}
            >
              {t("list.connect")}
            </Link>
          </div>
        ) : null}
      </header>
      <BuilderOAuthOutcome outcome={parseOAuthOutcome(query.oauth)} />
      <CustomApiBuilder
        workspaceId={workspaceId}
        definition={definition}
        canEdit={canEdit}
        projects={projects}
        draftId={draftId}
      />
    </div>
  );
}
