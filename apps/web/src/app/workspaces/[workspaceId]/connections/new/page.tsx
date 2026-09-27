import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { NewConnectionWizard } from "./new-connection-wizard";
import { getWorkspace, listConnectors, listWorkspaces } from "@/lib/api";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface NewConnectionPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function NewConnectionPage({
  params,
}: NewConnectionPageProps) {
  const { workspaceId } = await params;
  const { cookieHeader } = await requireSession();

  const [{ workspaces }, workspaceResult, { connectors }] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
    listConnectors(cookieHeader),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership) {
    notFound();
  }

  if (!can(membership.role, "connections:create")) {
    return (
      <>
        <h1>Add connection</h1>
        <p className="muted">
          Your role ({membership.role}) cannot create connections in this
          workspace.
        </p>
        <p className="muted">
          <Link href={`/workspaces/${workspaceId}`}>Back to workspace</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Add connection</h1>
      <p className="subtitle">{workspaceResult.workspace.name}</p>
      <NewConnectionWizard workspaceId={workspaceId} connectors={connectors} />
    </>
  );
}
