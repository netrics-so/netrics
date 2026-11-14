import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import { DataWorkspace } from "@/components/data/data-workspace";
import { listProjects, listWorkspaces } from "@/lib/api";
import { loadDataLists } from "@/lib/data-lists";
import { activeProjectName, projectScope } from "@/lib/project-scope";
import { requireSession } from "@/lib/session";
import { getT } from "@/lib/i18n/server";
import "@/app/styles/data.css";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("data");
  return { title: t("title") + " · netrics" };
}
export default async function DataPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ model?: string | string[] }>;
}) {
  const { workspaceId } = await params,
    { model } = await searchParams,
    { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "data:edit")) notFound();
  // Lists follow the active project (#573); the server reads an archived
  // one back as null ("All projects").
  const [{ projects }, lists] = await Promise.all([
    listProjects(cookieHeader, workspaceId),
    loadDataLists(
      workspaceId,
      projectScope(membership.activeProjectId, []),
      cookieHeader,
    ),
  ]);
  const scope = projectScope(membership.activeProjectId, projects);
  // ?model=<id> opens that model, e.g. from the Studio to publish it (#508).
  return (
    <DataWorkspace
      workspaceId={workspaceId}
      initial={lists.data}
      initialPickerSources={lists.pickerSources}
      scope={scope}
      projectName={activeProjectName(scope, projects)}
      {...(typeof model === "string" ? { openModelId: model } : {})}
    />
  );
}
