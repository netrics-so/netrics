import type {
  ConnectionAuthState,
  ConnectionHealth,
  ConnectionStateView,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  ConnectionRow,
  ConnectionStateRow,
  SyncRunRow,
} from "@netrics/database";

// Shapes connection rows into API responses. Credentials never leave the
// database row: responses only say whether there are any.

const DEFAULT_POLL_INTERVAL_SECONDS = 300;

function toStateView(state: ConnectionStateRow | null): ConnectionStateView {
  const authState: ConnectionAuthState = state
    ? (state.authState as ConnectionAuthState)
    : "ok";
  // A failure wins over "pending": a token rejected before the first
  // successful sync must still show that it needs attention.
  const health: ConnectionHealth =
    authState !== "ok" ? authState : state?.lastSuccessAt ? "ok" : "pending";
  return {
    health,
    authState,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    nextDueAt: state?.nextDueAt?.toISOString() ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    pollIntervalSeconds:
      state?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

export function presentConnection(
  registry: ConnectorRegistry,
  row: ConnectionRow,
  state: ConnectionStateRow | null,
) {
  const manifest = registry.get(row.connectorId)?.manifest;
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorName: manifest?.name ?? row.connectorId,
    connectorVersion: manifest?.version ?? "unknown",
    projectId: row.projectId,
    hasCredentials: row.credentialsEncrypted != null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: toStateView(state),
  };
}

export function presentConnectionDetail(
  registry: ConnectorRegistry,
  row: ConnectionRow,
  state: ConnectionStateRow | null,
) {
  // Strip the reserved resource-selection key from the echoed config; it is
  // an engine concern, not a manifest config property.
  const { resourceSelection: _resourceSelection, ...config } =
    row.config as Record<string, unknown>;
  return {
    ...presentConnection(registry, row, state),
    config,
  };
}

export function presentSyncRun(run: SyncRunRow) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    requestedFrom: run.requestedFrom.toISOString(),
    requestedTo: run.requestedTo.toISOString(),
    cursorBefore: run.cursorBefore,
    cursorAfter: run.cursorAfter,
    attempt: run.attempt,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    errorClass: run.errorClass,
    errorMessage: run.errorMessage,
    observationsWritten: run.observationsWritten,
  };
}
