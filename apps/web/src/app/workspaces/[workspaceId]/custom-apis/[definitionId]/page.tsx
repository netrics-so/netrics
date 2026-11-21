import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/custom-api.css";
import "@/app/styles/data.css";
import { CustomApiBuilder } from "@/components/custom-api/builder";
import { DefinitionConnections } from "@/components/custom-api/definition-connections";
import { ExportDefinitionButton } from "@/components/custom-api/export-definition";
import { VersionHistory } from "@/components/custom-api/version-history";
import { BuilderOAuthOutcome } from "@/components/custom-api/oauth-outcome";
import {
  getCustomApiDefinition,
  listCustomApiDefinitionConnections,
  listCustomApiVersions,
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
  // History and connections (#808).
  const [history, { connections }] = await Promise.all([
    listCustomApiVersions(forwarded, workspaceId, definitionId),
    listCustomApiDefinitionConnections(forwarded, workspaceId, definitionId),
  ]);
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
        <div className="page-actions">
          <ExportDefinitionButton
            workspaceId={workspaceId}
            definitionId={definition.id}
          />
          {can(membership.role, "connections:create") &&
          definition.archivedAt === null ? (
            <Link
              className="button"
              href={`/workspaces/${workspaceId}/custom-apis/${definition.id}/connect`}
            >
              {t("list.connect")}
            </Link>
          ) : null}
        </div>
      </header>
      <BuilderOAuthOutcome outcome={parseOAuthOutcome(query.oauth)} />
      <div className="custom-api-definition-panels">
        <VersionHistory
          // A restore makes a new version: the list starts over.
          key={definition.currentVersion}
          workspaceId={workspaceId}
          definitionId={definition.id}
          currentVersion={definition.currentVersion}
          canRestore={canEdit}
          initial={history}
        />
        <DefinitionConnections
          workspaceId={workspaceId}
          connections={connections}
          canUpdate={can(membership.role, "connections:update")}
        />
      </div>
      <CustomApiBuilder
        // A restored version reloads the builder on its document.
        key={definition.currentVersion}
        workspaceId={workspaceId}
        definition={definition}
        canEdit={canEdit}
        projects={projects}
        draftId={draftId}
      />
    </div>
  );
}
