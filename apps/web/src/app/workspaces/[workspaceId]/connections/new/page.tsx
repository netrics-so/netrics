import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { FinishSetup } from "../finish-setup";
import { OAuthOutcomeBanner } from "../oauth-outcome";
import { NewConnectionWizard } from "./new-connection-wizard";
import {
  getConnection,
  getWorkspace,
  listConnectors,
  listWorkspaces,
} from "@/lib/api";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface NewConnectionPageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function NewConnectionPage({
  params,
  searchParams,
}: NewConnectionPageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { cookieHeader } = await requireSession();
  const outcome = parseOAuthOutcome(query.oauth);
  const connectionParam =
    typeof query.connection === "string" && UUID.test(query.connection)
      ? query.connection
      : null;

  const [{ workspaces }, workspaceResult, { connectors }, detail] =
    await Promise.all([
      listWorkspaces(cookieHeader),
      getWorkspace(cookieHeader, workspaceId),
      listConnectors(cookieHeader),
      connectionParam
        ? getConnection(cookieHeader, workspaceId, connectionParam)
        : Promise.resolve(null),
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

  // Back from the provider with a new connection: finish its setup here.
  if (detail) {
    const { connection } = detail;
    if (!connection.setupPending) {
      redirect(`/workspaces/${workspaceId}/connections/${connection.id}`);
    }
    return (
      <>
        <h1>Finish setup</h1>
        <p className="subtitle">{workspaceResult.workspace.name}</p>
        <FinishSetup
          workspaceId={workspaceId}
          connection={connection}
          connector={connectors.find((c) => c.id === connection.connectorId)}
          canUpdate={can(membership.role, "connections:update")}
          returnPath={`/workspaces/${workspaceId}/connections/${connection.id}`}
        />
      </>
    );
  }

  return (
    <>
      <h1>Add connection</h1>
      <p className="subtitle">{workspaceResult.workspace.name}</p>
      <OAuthOutcomeBanner outcome={outcome} />
      <NewConnectionWizard workspaceId={workspaceId} connectors={connectors} />
    </>
  );
}
