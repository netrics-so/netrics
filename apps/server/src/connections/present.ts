import type {
  ConnectionAuthReason,
  ConnectionAuthState,
  ConnectionFreshnessStream,
  ConnectionHealth,
  ConnectionSignedKeyView,
  ConnectionStateView,
} from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  DEFAULT_LOCALE,
  isFreshnessLate,
  isFreshnessOverdue,
  localizedFreshnessStreamName,
  localizedManifest,
  type Locale,
} from "@netrics/domain";
import type {
  ConnectionFreshnessRow,
  ConnectionStateRow,
  ConnectionWithState,
  SyncRunRow,
} from "@netrics/database";

import { customApiNeedsNoSecrets } from "../custom-api/connections.js";
import { connectorFor } from "../custom-api/connectors.js";
import {
  relevantFreshnessRows,
  selectedResourcesOf,
} from "../sync/freshness.js";

// Shapes connection rows into API responses. Credentials never leave the
// database row: responses only say whether there are any.

const DEFAULT_POLL_INTERVAL_SECONDS = 300;

export function toStateView(
  state: ConnectionStateRow | null,
  now: Date = new Date(),
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
    // Only while it holds (#781): a past reset means nothing.
    rateLimitedUntil:
      state?.rateLimitedUntil && state.rateLimitedUntil > now
        ? state.rateLimitedUntil.toISOString()
        : null,
  };
}

/**
 * What a custom-api connection runs (milestone 13): the definition, its
 * pinned version and the environment, by id and name. Null for bundled
 * connectors.
 */
function presentCustomApi(
  loaded: ConnectionWithState,
  resolved: ReturnType<typeof connectorFor>,
) {
  const pinned = loaded.customApi;
  if (!pinned) return null;
  const environment = resolved?.customApi?.definition.environments.find(
    (entry) => entry.id === pinned.environmentId,
  );
  const definition = resolved?.customApi?.definition;
  const currentVersion = pinned.currentVersion ?? pinned.version;
  return {
    definitionId: pinned.definitionId,
    version: pinned.version,
    environmentId: pinned.environmentId,
    environmentName: environment?.name ?? pinned.environmentId,
    currentVersion,
    // Offered, never applied by itself (#808).
    updateAvailable: currentVersion > pinned.version,
    // A login method with secrets but none stored: an update dropped them
    // (other hosts or another method), so the login is entered again.
    loginMissing:
      definition !== undefined &&
      !customApiNeedsNoSecrets(definition) &&
      loaded.row.credentialsEncrypted == null,
    // The method and body of each stream (ADR 0030 §2): templates only,
    // never a rendered value or a secret.
    requests: (definition?.streams ?? []).map((stream) => {
      const body = stream.request.body;
      return {
        stream: stream.key,
        name: stream.name,
        method: stream.request.method ?? "GET",
        path: stream.request.path,
        body:
          body === undefined
            ? null
            : body.kind === "json"
              ? {
                  kind: "json" as const,
                  value: body.value,
                  readOnlyConfirmed: body.readOnlyConfirmed === true,
                }
              : {
                  kind: "graphql" as const,
                  query: body.query,
                  variables: body.variables,
                },
      };
    }),
  };
}

export function presentConnection(
  registry: ConnectorRegistry,
  loaded: ConnectionWithState,
  /** The language of the connector's name (#257). */
  locale: Locale = DEFAULT_LOCALE,
) {
  const { row, state, oauth } = loaded;
  const resolved = connectorFor(registry, loaded);
  const manifest = resolved?.manifest;
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
    customApi: presentCustomApi(loaded, resolved),
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
    errorCode: run.errorCode,
    observationsWritten: run.observationsWritten,
  };
}

/**
 * The connector's freshness streams with the connection's stored rows
 * (ADR 0025), for the connection's page: declared streams in manifest
 * order, rows of selected resources only, the connection entry first.
 */
export function presentFreshness(
  registry: ConnectorRegistry,
  row: ConnectionWithState["row"],
  rows: readonly ConnectionFreshnessRow[],
  locale: Locale = DEFAULT_LOCALE,
): ConnectionFreshnessStream[] {
  const manifest = registry.get(row.connectorId)?.manifest;
  const streams = manifest?.freshnessStreams ?? [];
  if (!manifest || streams.length === 0) return [];
  const relevant = relevantFreshnessRows(
    rows,
    streams,
    selectedResourcesOf(row.config as Record<string, unknown>, manifest),
  );
  return streams.map((stream) => ({
    key: stream.key,
    name: localizedFreshnessStreamName(manifest, stream, locale),
    kind: stream.kind,
    period: stream.period ?? "day",
    entries: relevant
      .filter((entry) => entry.stream.key === stream.key)
      .map(({ row: stored }) => ({
        resource: stored.resource === "" ? null : stored.resource,
        dataThrough: stored.dataThrough,
        nextExpectedAt: stored.nextExpectedAt?.toISOString() ?? null,
        checkedAt: stored.checkedAt.toISOString(),
        advancedAt: stored.advancedAt?.toISOString() ?? null,
        late: isFreshnessLate(stored),
        overdue: isFreshnessOverdue(stored),
      })),
  }));
}
