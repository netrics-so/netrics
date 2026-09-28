import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@netrics/domain";

import { HealthBadge } from "../../health-badge";
import { ConnectionActions } from "./connection-actions";
import { EditConnectionForm } from "./edit-connection-form";
import {
  getConnection,
  getWorkspace,
  listConnectors,
  listObservations,
  listWorkspaces,
} from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ConnectionDetailPageProps {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}

function shortWindow(from: string, to: string): string {
  return `${from.slice(0, 10)} → ${to.slice(0, 10)}`;
}

export default async function ConnectionDetailPage({
  params,
}: ConnectionDetailPageProps) {
  const { workspaceId, connectionId } = await params;
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

  const [{ connectors }, { observations }] = await Promise.all([
    listConnectors(cookieHeader),
    listObservations(cookieHeader, workspaceId, connectionId, { limit: 100 }),
  ]);
  const connector = connectors.find((c) => c.id === connection.connectorId);
  const canUpdate = can(role, "connections:update");
  const authFailed = connection.state.authState === "auth_failed";
  const authMessage = syncRuns.find(
    (run) => run.errorClass === "auth",
  )?.errorMessage;

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

      {authFailed ? (
        <div className="error page-alert" role="alert">
          <p>
            <strong>
              Syncing is paused: this connection needs new credentials.
            </strong>{" "}
            {authMessage ?? ""}
          </p>
          <p>
            {canUpdate ? (
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
          <span className="value">{connection.state.authState}</span>
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
          <span className="value">
            {relativeTime(connection.state.nextDueAt)}
          </span>
        </div>
        <div className="row">
          <span className="label">Poll interval</span>
          <span className="value">
            every {connection.state.pollIntervalSeconds} seconds
          </span>
        </div>
        <div className="row">
          <span className="label">Credentials</span>
          <span className="value">
            {connection.hasCredentials ? "stored" : "none"}
          </span>
        </div>
        <ConnectionActions
          workspaceId={workspaceId}
          connectionId={connection.id}
          connectionName={connection.name}
          canUpdate={can(role, "connections:update")}
          canDelete={can(role, "connections:delete")}
        />
      </div>

      {canUpdate ? (
        <div className="card" id="edit-connection">
          <h2>Edit connection</h2>
          <EditConnectionForm
            workspaceId={workspaceId}
            connection={connection}
            connector={connector}
          />
        </div>
      ) : null}

      <div className="card">
        <h2>Sync runs</h2>
        {syncRuns.length === 0 ? (
          <p className="muted">
            No sync runs yet — the initial backfill is queued.
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
                <th>Day</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((observation) => (
                <tr
                  key={`${observation.metricKey}/${observation.seriesKey}/${observation.sourceTimestamp}`}
                >
                  <td>{observation.metricKey}</td>
                  <td className="muted">
                    {observation.dimensions.resource ?? "—"}
                  </td>
                  <td className="muted">
                    {observation.sourceTimestamp.slice(0, 10)}
                  </td>
                  <td>{observation.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
