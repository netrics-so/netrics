import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { DisconnectResult } from "../connections/disconnect-result";
import { OAuthOutcomeBanner } from "../connections/oauth-outcome";
import { HealthBadge } from "../health-badge";
import { listConnections, listConnectors, listWorkspaces } from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import { parseDisconnected, parseOAuthOutcome } from "@/lib/oauth-connection";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import { parseKeyRemoved } from "@/lib/signed-key";
import { nextSyncLabel } from "@/lib/sync-schedule";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("workspace.pages");
  return { title: `${t("sources")} · netrics` };
}

interface SourcesPageProps {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The workspace's connections and adding one (#302). */
export default async function SourcesPage({
  params,
  searchParams,
}: SourcesPageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const outcome = parseOAuthOutcome(query.oauth);
  const disconnected = parseDisconnected(query);
  const keyRemoved = parseKeyRemoved(query);
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");

  const { workspaces } = await listWorkspaces(cookieHeader);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const role = membership.role;
  const { connections } = await listConnections(cookieHeader, workspaceId);
  // After deleting a connection with an uploaded key: where to revoke it.
  const removedKey = keyRemoved
    ? (await listConnectors(cookieHeader)).connectors
        .flatMap((connector) => connector.authStrategies)
        .find(
          (strategy) =>
            strategy.strategy === "signed-key" &&
            strategy.provider === keyRemoved,
        )
    : undefined;

  return (
    <div className="area-page sources-page">
      <header className="page-header">
        <div>
          <h1>{t("pages.sources")}</h1>
          <p className="page-meta">
            {t("sourceCount", { count: connections.length })}
          </p>
        </div>
        {can(role, "connections:create") ? (
          <div className="page-actions">
            <Link
              href={`/workspaces/${workspaceId}/connections/new`}
              className="button primary"
            >
              {t("addConnection")}
            </Link>
          </div>
        ) : null}
      </header>
      <OAuthOutcomeBanner outcome={outcome} />
      <DisconnectResult revocation={disconnected} />
      {removedKey ? (
        <div className="notice page-alert" role="status">
          <p>
            {removedKey.providerName
              ? t("keyRemoved", { name: removedKey.providerName })
              : t("keyRemovedUnnamed")}{" "}
            {removedKey.setup?.url ? (
              <a href={removedKey.setup.url} target="_blank" rel="noreferrer">
                {removedKey.providerName
                  ? t("revokeIn", { name: removedKey.providerName })
                  : t("revokeAtProvider")}{" "}
                ↗
              </a>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>{t("connections")}</h2>
        {connections.length === 0 ? (
          <p className="muted">{t("noConnections")}</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("table.name")}</th>
                  <th>{t("table.connector")}</th>
                  <th>{t("table.health")}</th>
                  <th>{t("table.lastSuccess")}</th>
                  <th>{t("table.nextSync")}</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id}>
                    <td>
                      <Link
                        href={`/workspaces/${workspaceId}/connections/${connection.id}`}
                      >
                        {connection.name}
                      </Link>
                    </td>
                    <td className="muted">
                      {connection.connectorName} {connection.connectorVersion}
                    </td>
                    <td>
                      {connection.setupPending ? (
                        <Link
                          className="health-badge pending"
                          href={`/workspaces/${workspaceId}/connections/${connection.id}#finish-setup`}
                        >
                          {t("finishSetup")}
                        </Link>
                      ) : (
                        <HealthBadge health={connection.state.health} />
                      )}
                    </td>
                    <td className="muted">
                      {relativeTime(connection.state.lastSuccessAt, locale)}
                    </td>
                    <td className="muted">
                      {nextSyncLabel(connection.state, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can(role, "connections:create") ? null : (
          <p className="muted">{t("cannotCreateConnections")}</p>
        )}
      </div>
    </div>
  );
}
