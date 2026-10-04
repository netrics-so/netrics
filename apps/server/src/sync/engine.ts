import { and, eq, sql } from "drizzle-orm";

import {
  ContractViolationError,
  executeCheck,
  executeDiscover,
  executeSync,
  redactSecrets,
  supportsResourceIcons,
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
  connectionResourcesDiscoveredAt,
  ingestAppReviews,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type ImageQuota,
  type OAuthAuthReason,
  type Transaction,
} from "@netrics/database";
import {
  IMAGE_QUOTA_DEFAULT_BYTES,
  IMAGE_QUOTA_DEFAULT_COUNT,
} from "@netrics/contracts";

import { decryptCredentials, type CredentialKeyring } from "../credentials.js";
import { refreshConnectionIcons } from "../images/resource-icons.js";
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
import {
  callWithSignedKey,
  SignedKeyRejectedError,
} from "../signed-keys/connector-auth.js";
import {
  createSignedKeyProviders,
  type SignedKey,
  type SignedKeyProviders,
} from "../signed-keys/registry.js";

/** First-ever incremental sync with no cursor and no last success. */
const INITIAL_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pagination bound: a connector paging forever is a contract violation. */
const MAX_PAGES = 100;
/**
 * Rows per observation INSERT: PostgreSQL binds at most 65,535 parameters in
 * one statement and a row binds six.
 */
const INSERT_BATCH_ROWS = 5_000;
/** How often a successful sync refreshes the resource names (#194). */
const RESOURCE_NAMES_REFRESH_MS = 24 * 60 * 60 * 1000;
/** The image quota when the host passes none (the contract's defaults). */
const DEFAULT_IMAGE_QUOTA: ImageQuota = {
  maxCount: IMAGE_QUOTA_DEFAULT_COUNT,
  maxBytes: IMAGE_QUOTA_DEFAULT_BYTES,
};

export interface SyncEngineDeps {
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  /** Clock for sync windows and state timestamps; defaults to the wall clock. */
  now?: () => Date;
  /** Access tokens for OAuth connections (ADR 0012). */
  oauthTokens?: OAuthTokenService;
  /** Default: the signed-key providers of this server (ADR 0014). */
  signedKeys?: SignedKeyProviders;
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
  /** The workspace image quota icons count against (#226). */
  imageQuota?: ImageQuota;
}

type ErrorClass = "auth" | "transient" | "contract";

interface StateRow {
  cursor: string | null;
  backfillJobId: string | null;
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
 * Upserts one page's observations. Identity is (connection, metric, series,
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
  // page repeats a key, the later value wins (as a later page's would).
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
  // A large page (a week of Search Console breakdowns) exceeds what one
  // statement may bind; batches share the page's transaction.
  let written = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const batch = await tx
      .insert(schema.observations)
      .values(rows.slice(start, start + INSERT_BATCH_ROWS))
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
    written += batch.length;
  }
  return written;
}

/**
 * One sync run. Transaction structure (milestone invariants: cursor advances
 * only with committed observations; failed runs stay visible):
 *
 *  1. A short tenant transaction loads the connection + state (the connector
 *     id decides the registry lookup; a missing row under RLS means a
 *     cross-workspace job and is rejected as a contract error).
 *  2. The credential check runs outside any transaction.
 *  3. Pages are fetched one at a time outside any transaction. Each non-final
 *     page commits in its own short tenant transaction together with its
 *     nextCursor as the checkpoint (#145): the run holds one page in memory,
 *     never the whole window, and the cursor never passes data that is not
 *     committed. The final page commits with the run's cursor, the success
 *     state and the succeeded sync_run in one transaction.
 *  4. Failures are then recorded in a fresh tenant transaction (failed
 *     sync_run with what earlier pages committed + connection_state) before
 *     the job error propagates. A retry (or the next run) starts at the
 *     checkpoint; re-sent observations are idempotent upserts. A new
 *     backfill job ignores the stored cursor and reads the whole window;
 *     once it has checkpointed, its retries resume from there (#153).
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
        backfillJobId: schema.connectionState.backfillJobId,
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
  /**
   * Where this run starts (#153). An incremental run continues from the
   * stored cursor. A backfill reads the connector's whole window: fresh, it
   * ignores the stored cursor (a later incremental sync's position, or the
   * checkpoint of an earlier backfill); a retried or reclaimed attempt of
   * the same job finds its own id next to the cursor and resumes from its
   * checkpoint (#145). Every checkpoint of a backfill records the job's id.
   */
  const fresh = mode === "backfill" && state?.backfillJobId !== job.id;
  const startCursor = fresh ? null : (state?.cursor ?? null);
  const backfillMarker = mode === "backfill" ? { backfillJobId: job.id } : {};

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

  /**
   * What this attempt has committed so far: pages before the final one are
   * checkpointed as they complete, so a failed run reports them.
   */
  const progress = {
    pagesCommitted: 0,
    observationsWritten: 0,
    cursor: startCursor,
  };

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
          cursorBefore: startCursor,
          // The checkpoint the next attempt resumes from, when pages
          // committed before the failure.
          cursorAfter: progress.pagesCommitted > 0 ? progress.cursor : null,
          attempt,
          status: "failed",
          startedAt: now,
          finishedAt: new Date(),
          errorClass,
          errorMessage: message,
          observationsWritten: progress.observationsWritten,
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

  // Signed-key connections (ADR 0014): the stored key is read here and
  // each connector call gets a freshly signed token; the key never reaches
  // the connector. A stored key that no longer parses needs a new upload.
  let signedKey: SignedKey | undefined;
  const signedKeys = deps.signedKeys ?? createSignedKeyProviders();
  const signedKeyProvider = oauthStrategy
    ? undefined
    : signedKeys.providerFor(manifest, credentials);
  if (signedKeyProvider) {
    const parsed = signedKeys.parse(signedKeyProvider, credentials);
    if (!parsed.ok) {
      const error = new Error(
        `The stored ${signedKeyProvider.name} key cannot be used: ${parsed.message}`,
      );
      await recordFailure("auth", error);
      throw new TerminalJobError(safeMessage(error));
    }
    signedKey = parsed.value;
    credentials = {};
  }

  const context = {
    connectionId,
    config: connection.config,
    credentials,
  };
  const binding = { workspaceId, connectionId };

  /**
   * Runs one connector call with this connection's credentials: stored
   * credentials, for OAuth a valid access token (one retry with a refreshed
   * token after a provider 401), or for a signed key a freshly signed token
   * (no retry: a refusal means the key must be replaced).
   */
  const callConnector = <T>(
    call: (context: ConnectionContext, options: ExecuteOptions) => Promise<T>,
    rejected?: (value: T) => boolean,
  ): Promise<T> =>
    signedKey
      ? callWithSignedKey({
          key: signedKey,
          ...(deps.executeOptions ? { options: deps.executeOptions } : {}),
          call: (tokenCredentials, options) =>
            call({ ...context, credentials: { ...tokenCredentials } }, options),
          ...(rejected ? { rejected } : {}),
        })
      : oauthStrategy
        ? callWithAccessToken({
            tokens: deps.oauthTokens,
            binding,
            requiredScopes: oauthStrategy.scopes,
            ...(deps.executeOptions ? { options: deps.executeOptions } : {}),
            call: (oauthCredentials, options) =>
              call(
                { ...context, credentials: { ...oauthCredentials } },
                options,
              ),
            ...(rejected ? { rejected } : {}),
          })
        : call(context, deps.executeOptions ?? {});

  /**
   * Records an OAuth token failure or a refused signed key; returns the
   * error to throw, or null when the error is not one.
   */
  const authFailure = async (error: unknown): Promise<Error | null> => {
    if (error instanceof SignedKeyRejectedError) {
      // auth_failed with the provider's "upload a new key" message; the
      // scheduler skips the connection until new credentials arrive.
      await recordFailure("auth", error);
      return new TerminalJobError(error.message);
    }
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
    const authError = await authFailure(error);
    if (authError) {
      throw authError;
    }
    await recordFailure("transient", error);
    throw error;
  }
  if (!check.ok) {
    const error = new Error(check.message ?? "credential check failed");
    await recordFailure("auth", error);
    throw new TerminalJobError(safeMessage(error));
  }

  // Step 3: fetch pages from the provider OUTSIDE any transaction (no
  // database connection waits on external I/O), bounded by MAX_PAGES, and
  // commit each one as it arrives (see the run's doc comment).
  try {
    let metricDefinitionIds: Map<string, string> | null = null;
    /** Upserts one page's observations in the given tenant transaction. */
    const ingestPage = async (
      tx: Transaction,
      observations: Observation[],
    ): Promise<number> => {
      if (observations.length === 0) {
        return 0;
      }
      // Catalog rows come from the deploy-time migrate step (read-only for
      // the app role); no row lock on the shared connector row here.
      metricDefinitionIds ??= new Map(
        (
          await tx
            .select({
              id: schema.metricDefinitions.id,
              key: schema.metricDefinitions.key,
            })
            .from(schema.metricDefinitions)
            .where(eq(schema.metricDefinitions.connectorId, manifest.id))
        ).map((row) => [row.key, row.id]),
      );
      return ingestObservations(tx, {
        workspaceId,
        connectionId,
        metricDefinitionIds,
        observations,
      });
    };

    /**
     * Stores the review text of one page (ADR 0019 §11) in the page's
     * transaction. Only while the connection's credentials are the ones
     * this run started with: a reviews key removed (and its reviews
     * deleted) during the run must not bring them back. The row lock
     * orders this against that removal.
     */
    const ingestReviews = async (
      tx: Transaction,
      result: Pick<SyncResult, "reviews" | "reviewWindows">,
    ): Promise<void> => {
      const reviews = result.reviews ?? [];
      const windows = result.reviewWindows ?? [];
      if (reviews.length === 0 && windows.length === 0) {
        return;
      }
      const [current] = await tx
        .select({ credentials: schema.connections.credentialsEncrypted })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.id, connectionId),
            eq(schema.connections.workspaceId, workspaceId),
          ),
        )
        .for("share");
      const started = connection.credentialsEncrypted;
      const unchanged =
        current?.credentials != null &&
        started != null &&
        current.credentials.equals(started);
      if (!unchanged) {
        log.info("review text not stored: the connection's keys changed");
        return;
      }
      await ingestAppReviews(tx, {
        workspaceId,
        connectionId,
        reviews,
        windows,
        now,
      });
    };

    let finalObservations: Observation[] = [];
    let finalReviews: Pick<SyncResult, "reviews" | "reviewWindows"> = {};
    let finalCursor = startCursor;
    if (window.from < window.to) {
      let cursor = startCursor ?? undefined;
      for (let page = 1; ; page += 1) {
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
        if (result.done) {
          finalObservations = result.observations;
          finalReviews = result;
          finalCursor = result.nextCursor ?? iso(window.to);
          break;
        }
        const nextCursor = result.nextCursor;
        if (!nextCursor) {
          throw new ContractViolationError(
            `connector "${manifest.id}" returned done=false without a nextCursor`,
          );
        }
        if (nextCursor === cursor) {
          throw new ContractViolationError(
            `connector "${manifest.id}" returned a non-advancing cursor`,
          );
        }
        // Checkpoint: the page's observations and the cursor after them
        // commit together, so the cursor never passes uncommitted data.
        const written = await withWorkspace(
          appDb,
          { workspaceId },
          async (tx) => {
            const count = await ingestPage(tx, result.observations);
            await ingestReviews(tx, result);
            await tx
              .insert(schema.connectionState)
              .values({
                connectionId,
                workspaceId,
                pollIntervalSeconds,
                cursor: nextCursor,
                ...backfillMarker,
              })
              .onConflictDoUpdate({
                target: schema.connectionState.connectionId,
                set: { cursor: nextCursor, ...backfillMarker },
              });
            return count;
          },
        );
        progress.pagesCommitted += 1;
        progress.observationsWritten += written;
        progress.cursor = nextCursor;
        cursor = nextCursor;
      }
    }

    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      const observationsWritten =
        progress.observationsWritten +
        (await ingestPage(tx, finalObservations));
      await ingestReviews(tx, finalReviews);

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
          ...backfillMarker,
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
            ...backfillMarker,
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
        cursorBefore: startCursor,
        cursorAfter: finalCursor,
        attempt,
        status: "succeeded",
        startedAt: now,
        finishedAt: new Date(),
        observationsWritten,
      });
    });
  } catch (error) {
    const authError = await authFailure(error);
    if (authError) {
      throw authError;
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

  // Step 4 (#194): the names of the connection's resources (apps,
  // projects, properties), so a tile of one resource can show its name.
  // At most daily, after the data is committed, and best effort: a failed
  // discover is logged and never fails the run.
  let refreshIcons = false;
  try {
    const discoveredAt = await withWorkspace(appDb, { workspaceId }, (tx) =>
      connectionResourcesDiscoveredAt(tx, workspaceId, connectionId),
    );
    if (
      !discoveredAt ||
      now.getTime() - discoveredAt.getTime() >= RESOURCE_NAMES_REFRESH_MS
    ) {
      const resources = await callConnector((callContext, options) =>
        executeDiscover(connector, callContext, options),
      );
      await withWorkspace(appDb, { workspaceId }, (tx) =>
        upsertConnectionResources(tx, {
          workspaceId,
          connectionId,
          resources,
          now,
        }),
      );
      refreshIcons = true;
    }
  } catch (error) {
    log.warn({ err: safeMessage(error) }, "resource names not refreshed");
  }

  // Step 5 (#226): the resource icons the workspace uses (app icons), with
  // the names, so at most daily. Best effort as well.
  if (refreshIcons && supportsResourceIcons(connector)) {
    try {
      await refreshConnectionIcons({
        db: appDb,
        quota: deps.imageQuota ?? DEFAULT_IMAGE_QUOTA,
        workspaceId,
        connectionId,
        connector,
        run: (call) => callConnector(call),
        now,
        log: (message) => log.warn(message),
      });
    } catch (error) {
      log.warn({ err: safeMessage(error) }, "resource icons not refreshed");
    }
  }
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
