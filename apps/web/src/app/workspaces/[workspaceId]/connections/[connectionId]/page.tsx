import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { HealthBadge } from "../../health-badge";
import { FinishSetup } from "../finish-setup";
import { OAuthOutcomeBanner } from "../oauth-outcome";
import { ReconnectBanner } from "../reconnect-banner";
import { SearchConsoleSettings } from "../search-console-settings";
import { ConnectionActions } from "./connection-actions";
import { EditConnectionForm } from "./edit-connection-form";
import { AppStoreAnalyticsPanel } from "./app-store-analytics-panel";
import { AppStoreReviewsPanel } from "./app-store-reviews-panel";
import { SignedKeyPanel } from "./signed-key-panel";
import {
  getConnection,
  getWorkspace,
  listConnectors,
  listObservations,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { getLocale, getT } from "@/lib/i18n/server";
import {
  parseOAuthOutcome,
  providerName,
  SEARCH_CONSOLE_CONNECTOR_ID,
} from "@/lib/oauth-connection";
import { observationBreakdown } from "@/lib/format-metric";
import { formatReportingDay } from "@/lib/app-store-analytics";
import { intervalLabel, relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import {
  APP_STORE_CONNECT_CONNECTOR_ID,
  APP_STORE_CONNECT_DOCS_URL,
  latestReportingDay,
  signedKeyStrategyOf,
} from "@/lib/signed-key";
import { nextSyncLabel } from "@/lib/sync-schedule";

export const dynamic = "force-dynamic";

interface ConnectionDetailPageProps {
  params: Promise<{ workspaceId: string; connectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function shortWindow(from: string, to: string): string {
  return `${from.slice(0, 10)} → ${to.slice(0, 10)}`;
}

export default async function ConnectionDetailPage({
  params,
  searchParams,
}: ConnectionDetailPageProps) {
  const { workspaceId, connectionId } = await params;
  const query = await searchParams;
  const { cookieHeader } = await requireSession();
  const locale = await getLocale();
  const t = await getT("connections.detail");
  const health = await getT("health");

  const [{ workspaces }, workspaceResult, detail] = await Promise.all([
    listWorkspaces(cookieHeader),
    getWorkspace(cookieHeader, workspaceId),
    getConnection(cookieHeader, workspaceId, connectionId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership || !detail) {
    notFound();
  }
  const role = membership.role;
  const { connection, syncRuns } = detail;

  const [{ connectors }, { observations }, { metrics }] = await Promise.all([
    listConnectors(cookieHeader),
    listObservations(cookieHeader, workspaceId, connectionId, { limit: 100 }),
    listWorkspaceMetrics(cookieHeader, workspaceId),
  ]);
  // Metric names for the observations table (the key stays in the tooltip).
  const metricNames = new Map(
    metrics
      .filter((metric) => metric.connectionId === connectionId)
      .map((metric) => [metric.key, metric.name]),
  );
  // Breakdown dimension names in the viewer's language, from the API.
  const dimensionNames: Record<string, string> = Object.assign(
    {},
    ...metrics
      .filter((metric) => metric.connectionId === connectionId)
      .map((metric) => metric.dimensionNames),
  );
  const connector = connectors.find((c) => c.id === connection.connectorId);
  const canUpdate = can(role, "connections:update");
  const authFailed = connection.state.authState === "auth_failed";
  // A sync can only fail until the grant is reconnected (the API refuses it).
  const needsReconnect = connection.state.authState === "needs_reauthorization";
  const authMessage = syncRuns.find(
    (run) => run.errorClass === "auth",
  )?.errorMessage;
  const oauth = connection.oauth;
  const searchConsole = connection.connectorId === SEARCH_CONSOLE_CONNECTOR_ID;
  const returnPath = `/workspaces/${workspaceId}/connections/${connection.id}`;
  // A connection with an uploaded key (ADR 0014): rotation and revocation.
  const keyStrategy = oauth ? null : signedKeyStrategyOf(connector);
  const keyName = keyStrategy?.providerName ?? connection.connectorName;
  const appStore = connection.connectorId === APP_STORE_CONNECT_CONNECTOR_ID;
  const latestDay = appStore ? latestReportingDay(observations) : null;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });

  return (
    <>
      <h1>{connection.name}</h1>
      <p className="subtitle">
        {connection.connectorName} {connection.connectorVersion} ·{" "}
        <HealthBadge health={connection.state.health} />
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}`}>{t("back")}</Link>
      </p>

      <OAuthOutcomeBanner
        outcome={parseOAuthOutcome(query.oauth)}
        {...(oauth ? { provider: oauth.provider } : {})}
      />
      {query.setup === "finished" && !connection.setupPending ? (
        <div className="notice page-alert" role="status">
          {t("setupFinished")}
        </div>
      ) : null}

      {connection.setupPending ? (
        <FinishSetup
          workspaceId={workspaceId}
          connection={connection}
          connector={connector}
          canUpdate={canUpdate}
          returnPath={returnPath}
        />
      ) : (
        <ReconnectBanner
          workspaceId={workspaceId}
          connection={connection}
          canUpdate={canUpdate}
          returnPath={returnPath}
        />
      )}

      {authFailed ? (
        <div className="error page-alert" role="alert">
          <p>
            <strong>{t("pausedCredentials")}</strong> {authMessage ?? ""}
          </p>
          <p>
            {keyStrategy ? (
              canUpdate ? (
                <>
                  <a href="#replace-key">
                    {t("uploadNewKey", { name: keyName })}
                  </a>{" "}
                  {t("uploadNewKeyDetail")}
                </>
              ) : (
                t("askUploadKey", { name: keyName })
              )
            ) : oauth ? (
              searchConsole ? (
                t("restoreSearchConsole")
              ) : (
                t("checkProviderPermissions")
              )
            ) : canUpdate ? (
              <>
                <a href="#edit-connection">{t("enterToken")}</a>{" "}
                {t("enterTokenDetail")}
              </>
            ) : (
              t("askUpdateCredentials")
            )}
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>{t("health")}</h2>
        <div className="row">
          <span className="label">{t("authState")}</span>
          <span className="value">
            {health(`authStates.${connection.state.authState}`)}
          </span>
        </div>
        <div className="row">
          <span className="label">{t("consecutiveFailures")}</span>
          <span className="value">{connection.state.consecutiveFailures}</span>
        </div>
        <div className="row">
          <span className="label">{t("lastSuccess")}</span>
          <span className="value">
            {relativeTime(connection.state.lastSuccessAt, locale)}
          </span>
        </div>
        <div className="row">
          <span className="label">{t("nextSync")}</span>
          <span className="value">
            {nextSyncLabel(connection.state, locale)}
          </span>
        </div>
        <div className="row">
          <span className="label">{t("pollInterval")}</span>
          <span className="value">
            {intervalLabel(connection.state.pollIntervalSeconds, locale)}
          </span>
        </div>
        {oauth ? (
          <div className="row">
            <span className="label">
              {t("providerAccount", { provider: providerName(oauth.provider) })}
            </span>
            <span className="value">
              {oauth.accountEmail
                ? t("connectedAs", { email: oauth.accountEmail })
                : t("connected")}
            </span>
          </div>
        ) : (
          <div className="row">
            <span className="label">{t("credentials")}</span>
            <span className="value">
              {connection.hasCredentials
                ? t("credentialsStored")
                : t("credentialsNone")}
            </span>
          </div>
        )}
        <ConnectionActions
          workspaceId={workspaceId}
          connectionId={connection.id}
          connectionName={connection.name}
          oauthProvider={oauth?.provider ?? null}
          signedKey={
            keyStrategy
              ? {
                  provider: keyStrategy.provider,
                  providerName: keyName,
                  revokeUrl: keyStrategy.setup?.url ?? null,
                  keyId:
                    connection.signedKey?.fields.find(
                      (field) => field.key === "keyId",
                    )?.value ?? null,
                }
              : null
          }
          canSync={!connection.setupPending && !needsReconnect}
          canUpdate={canUpdate}
          canDelete={can(role, "connections:delete")}
        />
      </div>

      {keyStrategy ? (
        <SignedKeyPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          signedKey={connection.signedKey}
          hasCredentials={connection.hasCredentials}
          authFailed={authFailed}
          canUpdate={canUpdate}
        />
      ) : null}

      {appStore && keyStrategy && !connection.setupPending ? (
        <AppStoreAnalyticsPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          issuerId={
            connection.signedKey?.fields.find(
              (field) => field.key === "issuerId",
            )?.value ?? null
          }
          canUpdate={canUpdate}
          authFailed={authFailed}
        />
      ) : null}

      {appStore && keyStrategy && !connection.setupPending ? (
        <AppStoreReviewsPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          canUpdate={canUpdate}
        />
      ) : null}

      {appStore ? (
        <div className="card">
          <h2>{t("appStoreAbout")}</h2>
          <div className="row">
            <span className="label">{t("latestReportingDay")}</span>
            <span className="value">
              {latestDay ? formatReportingDay(latestDay, locale) : t("noneYet")}
            </span>
          </div>
          <p className="muted">
            {t("appStoreTiming")}{" "}
            <a
              href={APP_STORE_CONNECT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("moreAboutConnector")}
            </a>
          </p>
        </div>
      ) : null}

      {searchConsole ? (
        <div className="card">
          <h2>{t("searchConsoleAbout")}</h2>
          <p className="muted">{t("searchConsoleTiming")}</p>
          <p className="muted">
            {t("searchConsolePrivacy")}{" "}
            <a
              href="https://github.com/netrics-so/netrics/blob/main/docs/connectors/google-search-console.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("moreAboutConnector")}
            </a>
          </p>
        </div>
      ) : null}

      {canUpdate && !connection.setupPending ? (
        <div className="card" id="edit-connection">
          <h2>{t("editConnection")}</h2>
          {searchConsole ? (
            <SearchConsoleSettings
              workspaceId={workspaceId}
              connection={connection}
              connectorName={connector?.name ?? connection.connectorName}
              mode="edit"
            />
          ) : (
            <EditConnectionForm
              workspaceId={workspaceId}
              connection={connection}
              connector={connector}
            />
          )}
        </div>
      ) : null}

      <div className="card">
        <h2>{t("syncRuns")}</h2>
        {syncRuns.length === 0 ? (
          <p className="muted">
            {connection.setupPending ? t("nothingSyncs") : t("noRuns")}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("runs.status")}</th>
                <th>{t("runs.mode")}</th>
                <th>{t("runs.window")}</th>
                <th>{t("runs.observations")}</th>
                <th>{t("runs.attempt")}</th>
                <th>{t("runs.error")}</th>
                <th>{t("runs.started")}</th>
                <th>{t("runs.finished")}</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.map((run) => (
                <tr key={run.id}>
                  <td>{t(`runStatus.${run.status}`)}</td>
                  <td>{t(`runMode.${run.mode}`)}</td>
                  <td className="muted">
                    {shortWindow(run.requestedFrom, run.requestedTo)}
                  </td>
                  <td>{run.observationsWritten}</td>
                  <td>{run.attempt}</td>
                  <td className="muted">
                    {run.errorClass
                      ? `${run.errorClass}: ${run.errorMessage ?? ""}`
                      : "—"}
                  </td>
                  <td className="muted">
                    {relativeTime(run.startedAt, locale)}
                  </td>
                  <td className="muted">
                    {relativeTime(run.finishedAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>{t("latestObservations")}</h2>
        {observations.length === 0 ? (
          <p className="muted">{t("noObservations")}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("observations.metric")}</th>
                <th>{t("observations.resource")}</th>
                <th>{t("observations.breakdown")}</th>
                <th>{t("observations.day")}</th>
                <th>{t("observations.value")}</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((observation) => (
                <tr
                  key={`${observation.metricKey}/${observation.seriesKey}/${observation.sourceTimestamp}`}
                >
                  <td title={observation.metricKey}>
                    {metricNames.get(observation.metricKey) ??
                      observation.metricKey}
                  </td>
                  <td
                    className="muted"
                    title={
                      observation.resourceName
                        ? observation.dimensions.resource
                        : undefined
                    }
                  >
                    {observation.resourceName ??
                      observation.dimensions.resource ??
                      "—"}
                  </td>
                  <td>
                    {observationBreakdown(observation.dimensions).map(
                      ([dimension, value]) => (
                        <div key={dimension}>
                          <span className="muted">
                            {dimensionNames[dimension] ?? dimension}
                          </span>{" "}
                          {value}
                        </div>
                      ),
                    )}
                  </td>
                  <td className="muted nowrap">
                    {observation.sourceTimestamp.slice(0, 10)}
                  </td>
                  <td className="nowrap">
                    {numbers.format(observation.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
