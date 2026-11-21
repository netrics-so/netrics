import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import "@/app/styles/custom-api.css";
import { ConnectionUpdateReview } from "@/components/custom-api/connection-update-review";
import {
  getConnection,
  getCustomApiConnectionUpdate,
  getCustomApiDefinition,
  getCustomApiDefinitionVersion,
  listWorkspaces,
} from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("customApi.update");
  return { title: `${t("review")} · netrics` };
}

/**
 * The review of a custom API connection's definition update (#808):
 * offered, never applied by itself. Members who may update connections
 * apply it; without an offer the page goes back to the connection.
 */
export default async function CustomApiUpdatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}) {
  const { workspaceId, connectionId } = await params;
  const { forwarded } = await requireSession();
  const t = await getT("customApi.update");
  const [{ workspaces }, detail] = await Promise.all([
    listWorkspaces(forwarded),
    getConnection(forwarded, workspaceId, connectionId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership || !detail?.connection.customApi) notFound();
  const { connection } = detail;
  const back = `/workspaces/${workspaceId}/connections/${connectionId}`;
  const plan = can(membership.role, "connections:update")
    ? await getCustomApiConnectionUpdate(forwarded, workspaceId, connectionId)
    : null;
  const [current, pinned] = plan
    ? await Promise.all([
        getCustomApiDefinition(forwarded, workspaceId, plan.definitionId),
        getCustomApiDefinitionVersion(
          forwarded,
          workspaceId,
          plan.definitionId,
          plan.fromVersion.version,
        ),
      ])
    : [null, null];
  return (
    <div className="area-page custom-api-page">
      <header className="page-header">
        <div>
          <h1>{t("title", { name: connection.name })}</h1>
        </div>
      </header>
      {plan && current ? (
        <ConnectionUpdateReview
          workspaceId={workspaceId}
          connectionId={connectionId}
          initialPlan={plan}
          streamNames={Object.fromEntries(
            [
              ...(pinned?.document.streams ?? []),
              ...current.definition.document.streams,
            ].map((stream) => [stream.key, stream.name]),
          )}
          environments={current.definition.document.environments}
          variables={current.definition.document.variables}
        />
      ) : (
        <div className="card stack">
          <p>
            <Link className="button" href={back}>
              {t("back")}
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
