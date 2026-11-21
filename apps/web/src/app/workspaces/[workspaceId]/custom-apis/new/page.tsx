import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { OAuthOutcomeBanner } from "../../connections/oauth-outcome";
import "@/app/styles/custom-api.css";
import "@/app/styles/data.css";
import { CustomApiBuilder } from "@/components/custom-api/builder";
import { listProjects, listWorkspaces } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("customApi.title");
  return { title: `${t("new")} · netrics` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The builder for a new custom API (#807); `?draft=` keeps its test login. */
export default async function NewCustomApiPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { forwarded } = await requireSession();
  const t = await getT("customApi");
  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) notFound();
  const canCreate = can(membership.role, "connections:create");
  const { projects } = await listProjects(forwarded, workspaceId);
  const draftId =
    typeof query.draft === "string" && UUID.test(query.draft)
      ? query.draft
      : null;
  return (
    <div className="area-page custom-api-page">
      <header className="page-header">
        <h1>{t("title.new")}</h1>
      </header>
      <OAuthOutcomeBanner outcome={parseOAuthOutcome(query.oauth)} />
      {canCreate ? (
        <CustomApiBuilder
          workspaceId={workspaceId}
          canEdit
          projects={projects}
          draftId={draftId}
        />
      ) : (
        <p className="muted">{t("viewer.readOnly")}</p>
      )}
    </div>
  );
}
