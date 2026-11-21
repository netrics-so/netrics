import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/custom-api.css";
import { ConnectDefinition } from "@/components/custom-api/connect-definition";
import {
  getCustomApiDefinition,
  listProjects,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("customApi.list");
  return { title: `${t("connect")} · netrics` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Connect an existing custom API (#807); needs connections:create. */
export default async function ConnectCustomApiPage({
  params,
}: {
  params: Promise<{ workspaceId: string; definitionId: string }>;
}) {
  const { workspaceId, definitionId } = await params;
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
  if (!response || response.definition.archivedAt !== null) notFound();
  const { definition } = response;
  return (
    <div className="area-page custom-api-page">
      <header className="page-header">
        <h1>{t("connect.title", { name: definition.name })}</h1>
      </header>
      {can(membership.role, "connections:create") ? (
        <ConnectDefinition
          workspaceId={workspaceId}
          definition={definition}
          projects={projects}
        />
      ) : (
        <p className="muted">
          <Link href={`/workspaces/${workspaceId}/custom-apis`}>
            {t("list.title")}
          </Link>
        </p>
      )}
    </div>
  );
}
