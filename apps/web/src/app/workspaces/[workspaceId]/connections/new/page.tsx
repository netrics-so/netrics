import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { can } from "@netrics/domain";

import { FinishSetup } from "../finish-setup";
import { OAuthOutcomeBanner } from "../oauth-outcome";
import { NewConnectionWizard } from "./new-connection-wizard";
import "@/app/styles/sources.css";
import {
  getConnection,
  getWorkspace,
  listConnections,
  listConnectors,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { parseOAuthOutcome } from "@/lib/oauth-connection";
import { requireSession } from "@/lib/session";
import { connectorStandings } from "@/lib/sources";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("connections.newPage");
  return { title: t("pageTitle") };
}

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
  const t = await getT("connections.newPage");
  const roles = await getT("common.roles");
  const outcome = parseOAuthOutcome(query.oauth);
  const connectionParam =
    typeof query.connection === "string" && UUID.test(query.connection)
      ? query.connection
      : null;

  const connectorParam =
    typeof query.connector === "string" ? query.connector : null;

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
        <h1>{t("title")}</h1>
        <p className="muted">
          {t("roleCannot", { role: roles(membership.role) })}
        </p>
        <p className="muted">
          <Link href={`/workspaces/${workspaceId}/sources`}>{t("back")}</Link>
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
        <h1>{t("finishSetup")}</h1>
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
      <h1>{t("title")}</h1>
      <p className="subtitle">{workspaceResult.workspace.name}</p>
      <OAuthOutcomeBanner outcome={outcome} />
      <NewConnectionWizard
        workspaceId={workspaceId}
        connectors={connectors}
        standings={connectorStandings(
          (await listConnections(cookieHeader, workspaceId)).connections,
        )}
        initialConnectorId={connectorParam}
      />
    </>
  );
}
