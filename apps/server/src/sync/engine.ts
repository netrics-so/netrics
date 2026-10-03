import { and, eq, sql } from "drizzle-orm";

import {
  ContractViolationError,
  executeCheck,
  executeSync,
  redactSecrets,
  type ConnectorRegistry,
  type ExecuteOptions,
} from "@netrics/connector-runtime";
import {
  observationKey,
  type ConnectionContext,
  type Observation,
  type SyncMode,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import {
  schema,
  withWorkspace,
  type OAuthAuthReason,
  type Transaction,
} from "@netrics/database";

import { decryptCredentials, type CredentialKeyring } from "../credentials.js";
import {
  NonRetryableJobError,
  TerminalJobError,
  type JobHandler,
  type JobHandlerContext,
} from "../jobs/handlers.js";
import {
  callWithAccessToken,
  NeedsReauthorizationError,
  oauthStrategyFor,
} from "../oauth/connector-auth.js";
import { OAuthTokenError, type OAuthTokenService } from "../oauth/tokens.js";

/** First-ever incremental sync with no cursor and no last success. */
const INITIAL_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pagination bound: a connector paging forever is a contract violation. */
const MAX_PAGES = 100;

export interface SyncEngineDeps {
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  /** Clock for sync windows and state timestamps; defaults to the wall clock. */
  now?: () => Date;
  /** Access tokens for OAuth connections (ADR 0012). */
  oauthTokens?: OAuthTokenService;
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
}

type ErrorClass = "auth" | "transient" | "contract";

interface StateRow {
  cursor: string | null;
  lastSuccessAt: Date | null;
  pollIntervalSeconds: number;
}

/** error_message / last_error are persisted verbatim: redact and truncate. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 500);
}

function iso(date: Date): string {
  return date.toISOString();
}

/** Computes the requested window for this run from the persisted state. */
function computeWindow(
  mode: SyncMode,
  state: StateRow | null,
  now: Date,
  backfillDays: number,
): { from: Date; to: Date } {
  if (mode === "backfill") {
    return {
      from: new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000),
      to: now,
    };
  }
  const cursorTime = state?.cursor ? Date.parse(state.cursor) : Number.NaN;
  const from = Number.isNaN(cursorTime)
    ? (state?.lastSuccessAt ??
      new Date(now.getTime() - INITIAL_INCREMENTAL_WINDOW_MS))
    : new Date(cursorTime);
  return { from, to: now };
}

/**
 * Inserts observations with (connection_id, source_identity) idempotency and
 * returns how many rows were actually written (duplicates are skipped).
 */
/**
 * Upserts a run's observations. Identity is (connection, metric, series,
 * timestamp) with the series derived by the database from the dimensions
 * (ADR 0008): a changed value for an existing key is a provider revision and
 * replaces the stored one; an unchanged value is a no-op. Returns the number
 * of rows inserted or revised.
 */
async function ingestObservations(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    metricDefinitionIds: Map<string, string>;
    observations: Observation[];
  },
): Promise<number> {
  // One statement may not touch a key twice (ON CONFLICT DO UPDATE); when a
  // run repeats a key across pages, the later value wins.
  const latest = new Map<string, Observation>();
  for (const observation of input.observations) {
    latest.set(observationKey(observation), observation);
  }
  if (latest.size === 0) {
    return 0;
  }
  const rows = [...latest.values()].map((observation) => {
    const metricDefinitionId = input.metricDefinitionIds.get(
      observation.metricKey,
    );
    if (!metricDefinitionId) {
      // The runtime already validated the key against the manifest, so a
      // missing definition row means catalog corruption — a contract error.
      throw new ContractViolationError(
        `no metric definition row for "${observation.metricKey}"`,
      );
    }
    return {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      metricDefinitionId,
      sourceTimestamp: new Date(observation.sourceTimestamp),
      value: observation.value,
      dimensions: observation.dimensions,
    };
  });
  const written = await tx
    .insert(schema.observations)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.observations.connectionId,
        schema.observations.metricDefinitionId,
        schema.observations.seriesKey,
        schema.observations.sourceTimestamp,
      ],
      set: { value: sql`excluded.value`, ingestedAt: sql`now()` },
      setWhere: sql`${schema.observations.value} is distinct from excluded.value`,
    })
    .returning({ connectionId: schema.observations.connectionId });
  return written.length;
}

/**
 * One sync run. Transaction structure (milestone invariants: cursor advances
 * only with committed observations; failed runs stay visible):
 *
 *  1. A short tenant transaction loads the connection + state (the connector
 *     id decides the registry lookup; a missing row under RLS means a
 *     cross-workspace job and is rejected as a contract error).
 *  2. The credential check runs outside any transaction.
 *  3. Connector sync, ingestion, cursor advancement, state update, and the
 *     sync_run success all commit in ONE tenant transaction. Any failure
 *     rolls the whole attempt back — zero observations, untouched cursor.
 *  4. Failures are then recorded in a fresh tenant transaction (failed
 *     sync_run + connection_state) before the job error propagates.
 */
async function runSync(
  ctx: JobHandlerContext,
  mode: SyncMode,
  deps: SyncEngineDeps,
): Promise<void> {
  const { job, appDb, logger } = ctx;
  const workspaceId = job.workspaceId;
  const connectionId = job.connectionId;
  if (!workspaceId || !connectionId) {
    throw new NonRetryableJobError(
      `contract: ${job.kind} requires workspace and connection identity`,
    );
  }
  const attempt = job.attempts + 1;
  const now = deps.now?.() ?? new Date();
  const log = logger.child({ connectionId, mode, attempt });

  // Step 1: load connection + state under the job's tenant context.
  const loaded = await withWorkspace(appDb, { workspaceId }, async (tx) => {
    const [connection] = await tx
      .select({
        id: schema.connections.id,
        workspaceId: schema.connections.workspaceId,
        connectorId: schema.connections.connectorId,
        config: schema.connections.config,
        credentialsEncrypted: schema.connections.credentialsEncrypted,
        setupPending: schema.connections.setupPending,
        oauthProvider: schema.connectionOAuth.provider,
      })
      .from(schema.connections)
      .leftJoin(
        schema.connectionOAuth,
        and(
          eq(schema.connectionOAuth.connectionId, schema.connections.id),
          eq(schema.connectionOAuth.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(schema.connections.id, connectionId),
          eq(schema.connections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!connection) {
      return null;
    }
    const [state] = await tx
      .select({
        cursor: schema.connectionState.cursor,
        lastSuccessAt: schema.connectionState.lastSuccessAt,
        pollIntervalSeconds: schema.connectionState.pollIntervalSeconds,
      })
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId))
      .limit(1);
    return { connection, state: state ?? null };
  });

  // Belt-and-braces: RLS already hides cross-workspace rows (a tampered job
  // sees "not found"), but reject an explicit mismatch too.
  if (!loaded || loaded.connection.workspaceId !== workspaceId) {
    throw new NonRetryableJobError(
      "contract: connection not found in the job's workspace",
    );
  }
  // A connection whose setup is pending (ADR 0012: created by an OAuth
  // callback, no config yet) is never synced: the scheduler does not see it
  // (no next_due_at) and the API refuses manual syncs; a job that still
  // reaches it ends here without a run or a state change.
  if (loaded.connection.setupPending) {
    log.info("sync skipped: connection setup is pending");
    return;
  }
  const connection = {
    ...loaded.connection,
    config: loaded.connection.config as Record<string, unknown>,
  };
  const state = loaded.state;

  // Optional resource subset chosen at creation time (stored in config under
  // a reserved key so it cannot clash with manifest config properties, whose
  // validation rejects additionalProperties before this merge happens).
  const rawSelection = connection.config.resourceSelection;
  const selectedResources =
    Array.isArray(rawSelection) &&
    rawSelection.length > 0 &&
    rawSelection.every((entry) => typeof entry === "string" && entry !== "")
      ? (rawSelection as string[])
      : undefined;

  const window = computeWindow(
    mode,
    state,
    now,
    deps.registry.get(connection.connectorId)?.manifest.backfillDays ?? 0,
  );
  const pollIntervalSeconds =
    state?.pollIntervalSeconds ??
    deps.registry.get(connection.connectorId)?.manifest
      .minRefreshIntervalSeconds ??
    300;

  /** Records a failed sync_run + connection_state in a fresh transaction. */
  const recordFailure = async (
    errorClass: ErrorClass,
    error: unknown,
    authReason?: OAuthAuthReason,
  ): Promise<void> => {
    const message = safeMessage(error);
    try {
      await withWorkspace(appDb, { workspaceId }, async (tx) => {
        await tx.insert(schema.syncRuns).values({
          workspaceId,
          connectionId,
          mode,
          requestedFrom: window.from,
          requestedTo: window.to,
          cursorBefore: state?.cursor ?? null,
          attempt,
          status: "failed",
          startedAt: now,
          finishedAt: new Date(),
          errorClass,
          errorMessage: message,
          observationsWritten: 0,
        });
        const statePatch = authReason
          ? { authState: "needs_reauthorization", authReason }
          : errorClass === "auth"
            ? { authState: "auth_failed", authReason: null }
            : errorClass === "transient"
              ? { authState: "outage", authReason: null }
              : {};
        await tx
          .insert(schema.connectionState)
          .values({
            connectionId,
            workspaceId,
            pollIntervalSeconds,
            consecutiveFailures: 1,
            ...statePatch,
          })
          .onConflictDoUpdate({
            target: schema.connectionState.connectionId,
            set: {
              ...statePatch,
              consecutiveFailures: sql`${schema.connectionState.consecutiveFailures} + 1`,
            },
          });
      });
    } catch (recordingError) {
      log.error(
        { err: safeMessage(recordingError) },
        "failed to record sync failure",
      );
    }
    log.warn({ errorClass, err: message }, "sync run failed");
  };

  // Registry lookup: an unknown connector id means catalog drift — permanent.
  const registered = deps.registry.get(connection.connectorId);
  if (!registered) {
    const error = new Error(
      `contract: no connector registered for "${connection.connectorId}"`,
    );
    await recordFailure("contract", error);
    throw new NonRetryableJobError(error.message);
  }
  const { connector, manifest } = registered;

  if (mode === "backfill" && !manifest.supportsBackfill) {
    const error = new Error(
      `contract: connector "${manifest.id}" does not support backfill`,
    );
    await recordFailure("contract", error);
    throw new NonRetryableJobError(error.message);
  }

  // OAuth connections (ADR 0012): the connector receives a short-lived
  // access token per call; the refresh token never leaves the host.
  const oauthProvider = connection.oauthProvider;
  const oauthStrategy = oauthProvider
    ? oauthStrategyFor(manifest, oauthProvider)
    : undefined;
  if (oauthProvider && !oauthStrategy) {
    const error = new Error(
      `contract: connector "${manifest.id}" has no oauth2 strategy for provider "${oauthProvider}"`,
    );
    await recordFailure("contract", error);
    throw new NonRetryableJobError(error.message);
  }

  // Decrypt credentials; a broken envelope needs operator attention, not a
  // retry loop — classified as contract.
  let credentials: Record<string, unknown>;
  try {
    credentials = oauthStrategy
      ? {}
      : connection.credentialsEncrypted
        ? (JSON.parse(
            decryptCredentials(
              connection.credentialsEncrypted.toString("utf8"),
              deps.credentialKeyring,
              { workspaceId: connection.workspaceId, connectionId },
            ),
          ) as Record<string, unknown>)
        : {};
  } catch (error) {
    await recordFailure("contract", error);
    throw new NonRetryableJobError(safeMessage(error));
  }

  const context = {
    connectionId,
    config: connection.config,
    credentials,
  };
  const binding = { workspaceId, connectionId };

  /**
   * Runs one connector call with this connection's credentials: stored
   * credentials, or for OAuth a valid access token (one retry with a
   * refreshed token after a provider 401).
   */
  const callConnector = <T>(
    call: (context: ConnectionContext, options: ExecuteOptions) => Promise<T>,
    rejected?: (value: T) => boolean,
  ): Promise<T> =>
    oauthStrategy
      ? callWithAccessToken({
          tokens: deps.oauthTokens,
          binding,
          requiredScopes: oauthStrategy.scopes,
          ...(deps.executeOptions ? { options: deps.executeOptions } : {}),
          call: (oauthCredentials, options) =>
            call({ ...context, credentials: { ...oauthCredentials } }, options),
          ...(rejected ? { rejected } : {}),
        })
      : call(context, deps.executeOptions ?? {});

  /**
   * Records an OAuth token failure; returns the error to throw, or null
   * when the error is not one.
   */
  const oauthFailure = async (error: unknown): Promise<Error | null> => {
    if (error instanceof NeedsReauthorizationError) {
      await recordFailure("auth", error, error.reason);
      return new TerminalJobError(error.message);
    }
    if (error instanceof OAuthTokenError) {
      if (error.kind === "configuration") {
        await recordFailure("contract", error);
        return new NonRetryableJobError(safeMessage(error));
      }
      await recordFailure("transient", error);
      return error;
    }
    return null;
  };

  // Step 2: credential check. ok:false is terminal until the user repairs
  // credentials (auth_failed; the scheduler skips such connections and the
  // credential-update flow resets the state). A thrown check is a retryable
  // provider failure.
  let check;
  try {
    check = await callConnector(
      (callContext, options) => executeCheck(connector, callContext, options),
      (result) => !result.ok,
    );
  } catch (error) {
    const oauthError = await oauthFailure(error);
    if (oauthError) {
      throw oauthError;
    }
    await recordFailure("transient", error);
    throw error;
  }
  if (!check.ok) {
    const error = new Error(check.message ?? "credential check failed");
    await recordFailure("auth", error);
    throw new TerminalJobError(safeMessage(error));
  }

  // Step 3: fetch every page from the provider OUTSIDE any transaction (no
  // database connection waits on external I/O), bounded by MAX_PAGES. Then
  // step 4 commits ingest + cursor advance + success in ONE short tenant
  // transaction: all or nothing, as before.
  try {
    const pages: SyncResult[] = [];
    let finalCursor = state?.cursor ?? null;
    if (window.from < window.to) {
      let cursor = state?.cursor ?? undefined;
      let done = false;
      for (let page = 1; !done; page += 1) {
        if (page > MAX_PAGES) {
          throw new ContractViolationError(
            `connector "${manifest.id}" paged more than ${MAX_PAGES} times without finishing`,
          );
        }
        const request: SyncRequest = {
          mode,
          from: iso(window.from),
          to: iso(window.to),
          ...(cursor ? { cursor } : {}),
          ...(selectedResources ? { resources: selectedResources } : {}),
        };
        const result = await callConnector((callContext, options) =>
          executeSync(connector, callContext, request, options),
        );
        if (!result.done && !result.nextCursor) {
          throw new ContractViolationError(
            `connector "${manifest.id}" returned done=false without a nextCursor`,
          );
        }
        if (!result.done && result.nextCursor === cursor) {
          throw new ContractViolationError(
            `connector "${manifest.id}" returned a non-advancing cursor`,
          );
        }
        pages.push(result);
        cursor = result.nextCursor;
        done = result.done;
      }
      finalCursor = cursor ?? iso(window.to);
    }

    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      // Catalog rows come from the deploy-time migrate step (read-only for
      // the app role); no row lock on the shared connector row here.
      const definitions = await tx
        .select({
          id: schema.metricDefinitions.id,
          key: schema.metricDefinitions.key,
        })
        .from(schema.metricDefinitions)
        .where(eq(schema.metricDefinitions.connectorId, manifest.id));
      const metricDefinitionIds = new Map(
        definitions.map((row) => [row.key, row.id]),
      );

      let observationsWritten = 0;
      for (const result of pages) {
        observationsWritten += await ingestObservations(tx, {
          workspaceId,
          connectionId,
          metricDefinitionIds,
          observations: result.observations,
        });
      }

      // Cursor advancement commits in this same transaction as the
      // observation inserts — never without them.
      await tx
        .insert(schema.connectionState)
        .values({
          connectionId,
          workspaceId,
          pollIntervalSeconds,
          lastSuccessAt: now,
          nextDueAt: new Date(now.getTime() + pollIntervalSeconds * 1000),
          cursor: finalCursor,
          authState: "ok",
          authReason: null,
          consecutiveFailures: 0,
        })
        .onConflictDoUpdate({
          target: schema.connectionState.connectionId,
          set: {
            lastSuccessAt: now,
            nextDueAt: new Date(now.getTime() + pollIntervalSeconds * 1000),
            cursor: finalCursor,
            authState: "ok",
            authReason: null,
            consecutiveFailures: 0,
          },
        });
      await tx.insert(schema.syncRuns).values({
        workspaceId,
        connectionId,
        mode,
        requestedFrom: window.from,
        requestedTo: window.to,
        cursorBefore: state?.cursor ?? null,
        cursorAfter: finalCursor,
        attempt,
        status: "succeeded",
        startedAt: now,
        finishedAt: new Date(),
        observationsWritten,
      });
    });
  } catch (error) {
    const oauthError = await oauthFailure(error);
    if (oauthError) {
      throw oauthError;
    }
    const errorClass: ErrorClass =
      error instanceof ContractViolationError ? "contract" : "transient";
    await recordFailure(errorClass, error);
    if (error instanceof ContractViolationError) {
      throw new NonRetryableJobError(safeMessage(error));
    }
    throw error;
  }

  log.info(
    { mode, window: { from: iso(window.from), to: iso(window.to) } },
    "sync run succeeded",
  );
}

/** Registers both connection sync job kinds against the same engine. */
export function createSyncJobHandlers(
  deps: SyncEngineDeps,
): Record<string, JobHandler> {
  return {
    "connection.sync": (ctx) => runSync(ctx, "incremental", deps),
    "connection.backfill": (ctx) => runSync(ctx, "backfill", deps),
  };
}
