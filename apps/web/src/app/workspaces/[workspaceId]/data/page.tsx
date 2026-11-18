import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import { DataWorkspace } from "@/components/data/data-workspace";
import { listProjects, listWorkspaces } from "@/lib/api";
import { getModel } from "@/lib/data-api";
import { loadDataLists } from "@/lib/data-lists";
import { projectScope } from "@/lib/project-scope";
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
  searchParams: Promise<{
    model?: string | string[];
    preparation?: string | string[];
  }>;
}) {
  const { workspaceId } = await params,
    { model, preparation } = await searchParams,
    { forwarded } = await requireSession();
  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "data:edit")) notFound();
  // Lists follow the active project (#573); the server reads an archived
  // one back as null ("All projects").
  const [{ projects }, lists] = await Promise.all([
    listProjects(forwarded, workspaceId),
    loadDataLists(
      workspaceId,
      projectScope(membership.activeProjectId, []),
      forwarded,
    ),
  ]);
  // ?model=<id> opens that model, e.g. from the Studio to publish it
  // (#508), also when it is in another project than the active one: it
  // opens without joining the list (#573).
  const openModel =
    typeof model === "string" &&
    !lists.data.models.some((entry) => entry.id === model)
      ? await getModel(workspaceId, model, forwarded).catch(() => null)
      : null;
  return (
    <DataWorkspace
      workspaceId={workspaceId}
      initial={lists.data}
      initialPickerSources={lists.pickerSources}
      projects={projects.map(({ id, name, archivedAt }) => ({
        id,
        name,
        archivedAt,
      }))}
      activeProjectId={membership.activeProjectId}
      canDelete={can(membership.role, "data:delete")}
      {...(typeof model === "string" ? { openModelId: model } : {})}
      {...(openModel ? { openModel } : {})}
      {...(typeof preparation === "string"
        ? { openPreparationId: preparation }
        : {})}
    />
  );
}
