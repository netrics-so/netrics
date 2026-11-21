import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { DisconnectResult } from "../connections/disconnect-result";
import { OAuthOutcomeBanner } from "../connections/oauth-outcome";
import { HealthBadge } from "../health-badge";
import { ViewerHint } from "../viewer-hint";
import "@/app/styles/sources.css";
import { ConnectedStrip } from "@/components/sources/connected-strip";
import { ConnectorCatalogue } from "@/components/sources/connector-catalogue";
import {
  listConnections,
  listConnectors,
  listCustomApiDefinitions,
  listProjects,
  listWorkspaces,
} from "@/lib/api";
import { connectorVersionLabel } from "@/lib/custom-api";
import { getLocale, getT } from "@/lib/i18n/server";
import { parseDisconnected, parseOAuthOutcome } from "@/lib/oauth-connection";
import {
  activeProjectName,
  navigationQuery,
  projectScope,
} from "@/lib/project-scope";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import { APPLE_ADS_PROVIDER, parseKeyRemoved } from "@/lib/signed-key";
import { connectorStandings } from "@/lib/sources";
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

/**
 * The workspace's sources (#302, design 3c #306): the connected strip, the
 * connector catalogue, and every connection's sync state in a table.
 */
export default async function SourcesPage({
  params,
  searchParams,
}: SourcesPageProps) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const outcome = parseOAuthOutcome(query.oauth);
  const disconnected = parseDisconnected(query);
  const keyRemoved = parseKeyRemoved(query);
  const { forwarded } = await requireSession();
  const locale = await getLocale();
  const t = await getT("workspace");
  const s = await getT("sources");
  const dashboardsT = await getT("dashboardsPage");

  const { workspaces } = await listWorkspaces(forwarded);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!membership) {
    notFound();
  }
  const role = membership.role;
  // The active project's connections (#573); the shell's source health
  // stays workspace-wide.
  const [{ connections }, { connectors }, { projects }, customApis] =
    await Promise.all([
      listConnections(
        forwarded,
        workspaceId,
        navigationQuery(projectScope(membership.activeProjectId, [])),
      ),
      listConnectors(forwarded),
      listProjects(forwarded, workspaceId),
      // The Custom API card offers "Connect existing" when there are some.
      listCustomApiDefinitions(forwarded, workspaceId).catch(() => ({
        definitions: [],
      })),
    ]);
  const projectName = activeProjectName(
    projectScope(membership.activeProjectId, projects),
    projects,
  );
  const canCreate = can(role, "connections:create");
  // After deleting a connection with an uploaded key: where to revoke it.
  const removedKey = keyRemoved
    ? connectors
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
            {projectName
              ? `${s("subtitle")} · ${dashboardsT("activeProjectMeta", { project: projectName })}`
              : s("subtitle")}
          </p>
        </div>
        {canCreate ? (
          <div className="page-actions">
            <Link
              href={`/workspaces/${workspaceId}/connections/new`}
              className="button primary"
            >
              {t("addConnection")}
            </Link>
          </div>
        ) : (
          <ViewerHint role={role} workspaceId={workspaceId} />
        )}
      </header>
      <OAuthOutcomeBanner outcome={outcome} />
      <DisconnectResult revocation={disconnected} />
      {removedKey ? (
        <div className="notice page-alert" role="status">
          {removedKey.provider === APPLE_ADS_PROVIDER ? (
            <p>
              {query.keyShared === "1"
                ? t("keyRemovedShared")
                : t("keyRemovedAppleAds")}{" "}
              {removedKey.setup?.url && query.keyShared !== "1" ? (
                <a href={removedKey.setup.url} target="_blank" rel="noreferrer">
                  {removedKey.providerName} ↗
                </a>
              ) : null}
            </p>
          ) : (
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
          )}
        </div>
      ) : null}

      <section className="sources-section" aria-labelledby="sources-connected">
        <h2 id="sources-connected" className="sources-heading">
          {s("connected")}
          <span className="sources-count">
            {t("sourceCount", { count: connections.length })}
          </span>
        </h2>
        {connections.length === 0 ? (
          <p className="muted">{t("noConnections")}</p>
        ) : (
          <ConnectedStrip
            workspaceId={workspaceId}
            connections={connections}
            connectors={connectors}
          />
        )}
      </section>

      <section className="sources-section" aria-labelledby="sources-catalogue">
        <h2 id="sources-catalogue" className="sources-heading">
          {s("catalogue")}
        </h2>
        {canCreate ? (
          <p className="page-meta sources-hint">{s("catalogueHint")}</p>
        ) : null}
        <ConnectorCatalogue
          workspaceId={workspaceId}
          connectors={connectors}
          standings={connectorStandings(connections)}
          mode={{ kind: "links", canCreate }}
          customApiDefinitionCount={customApis.definitions.length}
        />
      </section>

      <div className="card sources-table">
        <h2>{s("allConnections")}</h2>
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
                      {connection.connectorName}{" "}
                      {connectorVersionLabel(connection)}
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
                        <HealthBadge
                          health={connection.state.health}
                          rateLimitedUntil={connection.state.rateLimitedUntil}
                          connectorName={connection.connectorName}
                        />
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
        {canCreate ? null : (
          <p className="muted">{t("cannotCreateConnections")}</p>
        )}
      </div>
    </div>
  );
}
