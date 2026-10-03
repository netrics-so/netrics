import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { AUTH_STATE_LABELS, HealthBadge } from "../../health-badge";
import { FinishSetup } from "../finish-setup";
import { OAuthOutcomeBanner } from "../oauth-outcome";
import { ReconnectBanner } from "../reconnect-banner";
import { SearchConsoleSettings } from "../search-console-settings";
import { ConnectionActions } from "./connection-actions";
import { EditConnectionForm } from "./edit-connection-form";
import { AppStoreAnalyticsPanel } from "./app-store-analytics-panel";
import { SignedKeyPanel } from "./signed-key-panel";
import {
  getConnection,
  getWorkspace,
  listConnectors,
  listObservations,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import {
  parseOAuthOutcome,
  providerName,
  SEARCH_CONSOLE_CONNECTOR_ID,
} from "@/lib/oauth-connection";
import { observationBreakdown } from "@/lib/format-metric";
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

  return (
    <>
      <h1>{connection.name}</h1>
      <p className="subtitle">
        {connection.connectorName} {connection.connectorVersion} ·{" "}
        <HealthBadge health={connection.state.health} />
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}`}>Back to workspace</Link>
      </p>

      <OAuthOutcomeBanner
        outcome={parseOAuthOutcome(query.oauth)}
        {...(oauth ? { provider: oauth.provider } : {})}
      />
      {query.setup === "finished" && !connection.setupPending ? (
        <div className="notice page-alert" role="status">
          Setup finished. The first sync is queued and reads up to 16 months
          back; new data then arrives every few hours.
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
            <strong>
              Syncing is paused: this connection needs new credentials.
            </strong>{" "}
            {authMessage ?? ""}
          </p>
          <p>
            {keyStrategy ? (
              canUpdate ? (
                <>
                  <a href="#replace-key">Upload a new {keyName} key</a>. netrics
                  checks it first; saving it restarts syncing right away, and
                  the data collected so far is kept.
                </>
              ) : (
                `Ask a workspace owner, admin or editor to upload a new ${keyName} key.`
              )
            ) : oauth ? (
              searchConsole ? (
                "Restore the account's permission for the property in Search Console, or choose another property below."
              ) : (
                "Check the account's permissions at the provider, or change the settings below."
              )
            ) : canUpdate ? (
              <>
                <a href="#edit-connection">Enter a new token below</a>. Saving
                it restarts syncing right away; the data collected so far is
                kept.
              </>
            ) : (
              "Ask a workspace owner or admin to update the credentials."
            )}
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>Health</h2>
        <div className="row">
          <span className="label">Auth state</span>
          <span className="value">
            {AUTH_STATE_LABELS[connection.state.authState]}
          </span>
        </div>
        <div className="row">
          <span className="label">Consecutive failures</span>
          <span className="value">{connection.state.consecutiveFailures}</span>
        </div>
        <div className="row">
          <span className="label">Last success</span>
          <span className="value">
            {relativeTime(connection.state.lastSuccessAt)}
          </span>
        </div>
        <div className="row">
          <span className="label">Next sync due</span>
          <span className="value">{nextSyncLabel(connection.state)}</span>
        </div>
        <div className="row">
          <span className="label">Poll interval</span>
          <span className="value">
            {intervalLabel(connection.state.pollIntervalSeconds)}
          </span>
        </div>
        {oauth ? (
          <div className="row">
            <span className="label">
              {providerName(oauth.provider)} account
            </span>
            <span className="value">
              {oauth.accountEmail
                ? `Connected as ${oauth.accountEmail}`
                : "Connected"}
            </span>
          </div>
        ) : (
          <div className="row">
            <span className="label">Credentials</span>
            <span className="value">
              {connection.hasCredentials ? "stored" : "none"}
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

      {appStore ? (
        <div className="card">
          <h2>About App Store Connect data</h2>
          <div className="row">
            <span className="label">Latest reporting day</span>
            <span className="value">
              {latestReportingDay(observations) ?? "None yet"}
            </span>
          </div>
          <p className="muted">
            Sales arrive the next morning, Pacific Time (Apple publishes a
            day&apos;s report by about 8 a.m. PT); App Store analytics follow
            about two days later. Reporting days are Pacific Time days, not your
            workspace&apos;s time zone. Proceeds are kept in each currency Apple
            reports.{" "}
            <a
              href={APP_STORE_CONNECT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              More about the connector
            </a>
          </p>
        </div>
      ) : null}

      {searchConsole ? (
        <div className="card">
          <h2>About Search Console data</h2>
          <p className="muted">
            Search Console data appears with a 2–3 day delay; the newest days
            are filled in once Google finalises them, so today and yesterday are
            usually empty. Click-through rate and average position are daily
            values: over several days they are not added up.
          </p>
          <p className="muted">
            Search Console leaves out rare queries to protect searchers&apos;
            privacy (anonymized queries), and a breakdown keeps only its top
            rows per day, so breakdowns add up to less than the totals.{" "}
            <a
              href="https://github.com/netrics-so/netrics/blob/main/docs/connectors/google-search-console.md"
              target="_blank"
              rel="noreferrer"
            >
              More about the connector
            </a>
          </p>
        </div>
      ) : null}

      {canUpdate && !connection.setupPending ? (
        <div className="card" id="edit-connection">
          <h2>Edit connection</h2>
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
        <h2>Sync runs</h2>
        {syncRuns.length === 0 ? (
          <p className="muted">
            {connection.setupPending
              ? "Nothing syncs until the setup is finished."
              : "No sync runs yet — the initial backfill is queued."}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Mode</th>
                <th>Window</th>
                <th>Observations</th>
                <th>Attempt</th>
                <th>Error</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.status}</td>
                  <td>{run.mode}</td>
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
                  <td className="muted">{relativeTime(run.startedAt)}</td>
                  <td className="muted">{relativeTime(run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Latest observations</h2>
        {observations.length === 0 ? (
          <p className="muted">No observations ingested yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Resource</th>
                <th>Breakdown</th>
                <th>Day</th>
                <th>Value</th>
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
                  <td className="muted">
                    {observation.dimensions.resource ?? "—"}
                  </td>
                  <td>
                    {observationBreakdown(observation.dimensions).map(
                      ([dimension, value]) => (
                        <div key={dimension}>
                          <span className="muted">{dimension}</span> {value}
                        </div>
                      ),
                    )}
                  </td>
                  <td className="muted nowrap">
                    {observation.sourceTimestamp.slice(0, 10)}
                  </td>
                  <td className="nowrap">{observation.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
