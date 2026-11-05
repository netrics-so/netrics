import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@netrics/domain";
import { DataWorkspace } from "@/components/data/data-workspace";
import { getDataWorkspace } from "@/lib/data-api";
import { listWorkspaces } from "@/lib/api";
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
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params,
    { cookieHeader } = await requireSession();
  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !can(membership.role, "data:edit")) notFound();
  const initial = await getDataWorkspace(workspaceId, cookieHeader);
  return <DataWorkspace workspaceId={workspaceId} initial={initial} />;
}
