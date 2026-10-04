import type {
  ConnectionAuthReason,
  ConnectionAuthState,
  ConnectionHealth,
  ConnectionSignedKeyView,
  ConnectionStateView,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  DEFAULT_LOCALE,
  localizedManifest,
  type Locale,
} from "@netrics/domain";
import type {
  ConnectionStateRow,
  ConnectionWithState,
  SyncRunRow,
} from "@netrics/database";

// Shapes connection rows into API responses. Credentials never leave the
// database row: responses only say whether there are any.

const DEFAULT_POLL_INTERVAL_SECONDS = 300;

export function toStateView(
  state: ConnectionStateRow | null,
): ConnectionStateView {
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
    authReason:
      authState === "needs_reauthorization"
        ? ((state?.authReason as ConnectionAuthReason | null) ?? null)
        : null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    nextDueAt: state?.nextDueAt?.toISOString() ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    pollIntervalSeconds:
      state?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

export function presentConnection(
  registry: ConnectorRegistry,
  { row, state, oauth }: ConnectionWithState,
  /** The language of the connector's name (#257). */
  locale: Locale = DEFAULT_LOCALE,
) {
  const manifest = registry.get(row.connectorId)?.manifest;
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorName: manifest
      ? localizedManifest(manifest, locale).name
      : row.connectorId,
    connectorVersion: manifest?.version ?? "unknown",
    projectId: row.projectId,
    hasCredentials: row.credentialsEncrypted != null,
    // The linked account only; token material never leaves the database.
    oauth: oauth
      ? {
          provider: oauth.provider,
          accountEmail: oauth.accountEmail,
          grantedScopes: [...oauth.grantedScopes],
        }
      : null,
    setupPending: row.setupPending,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: toStateView(state),
  };
}

export function presentConnectionDetail(
  registry: ConnectorRegistry,
  loaded: ConnectionWithState,
  /** The stored signed key's non-secret fields (ADR 0014), if any. */
  signedKey: ConnectionSignedKeyView | null = null,
  locale: Locale = DEFAULT_LOCALE,
) {
  // Strip the reserved resource-selection key from the echoed config; it is
  // an engine concern, not a manifest config property.
  const { resourceSelection: _resourceSelection, ...config } = loaded.row
    .config as Record<string, unknown>;
  return {
    ...presentConnection(registry, loaded, locale),
    config,
    signedKey,
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
