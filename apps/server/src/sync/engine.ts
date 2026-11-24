import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DataPolicy } from "@netrics/domain";

import {
  ContractViolationError,
  CredentialHostMismatchError,
  executeCheck,
  executeDiscover,
  executeSync,
  redactSecrets,
  supportsResourceIcons,
  type ConnectorRegistry,
  type ExecuteOptions,
} from "@netrics/connector-runtime";
import {
  ConnectorError,
  isErrorCode,
  observationKey,
  RateLimitedError,
  type ConnectionContext,
  type Observation,
  type SyncMode,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import {
  connectionCustomApi,
  connectionResourcesDiscoveredAt,
  connectorStageProvenance,
  customApiPinColumns,
  customApiPinJoin,
  datasetVersions,
  ingestAppReviews,
  ingestDatasetPage,
  receiveEmptySourceDataset,
  intersectDatasetVersions,
  queueDatasetBackfill,
  recordStreamRecords,
  DatasetStoreError,
  DatasetStageUnavailableError,
  resolveDataPolicy,
  retryOnSerializationFailure,
  schema,
  upsertConnectionResources,
  withWorkspace,
  type ImageQuota,
  type OAuthAuthReason,
  type Transaction,
  notDraftConnection,
  rethrowWorkspaceGone,
} from "@netrics/database";
import {
  CUSTOM_API_IMAGE_QUOTA_DEFAULT_BYTES,
  CUSTOM_API_IMAGE_QUOTA_DEFAULT_COUNT,
  IMAGE_QUOTA_DEFAULT_BYTES,
  IMAGE_QUOTA_DEFAULT_COUNT,
} from "@netrics/contracts";

import {
  CUSTOM_API_SKIPPED_FIELDS,
  CUSTOM_API_SKIPPED_LOG,
  readSkippedLogFields,
} from "@netrics/connector-sdk/custom-api";
import {
  CUSTOM_API_AUTH_ERROR,
  CUSTOM_API_CONNECTOR_ID,
  CUSTOM_API_LIMIT_ERROR,
} from "@netrics/connectors/custom-api";

import { decryptCredentials, type CredentialKeyring } from "../credentials.js";
import { callOptionsFor, connectorFor } from "../custom-api/connectors.js";
import { ingestCustomApiImages } from "../images/custom-api-images.js";
import { refreshConnectionIcons } from "../images/resource-icons.js";
import {
  NonRetryableJobError,
  ContinueJobError,
  DeferJobError,
  TerminalJobError,
  type JobHandler,
  type JobHandlerContext,
} from "../jobs/handlers.js";
import {
  callWithAccessToken,
  NeedsReauthorizationError,
  connectionOAuthProvider,
  requiredOAuthScopes,
} from "../oauth/connector-auth.js";
import {
  customOAuthFailureMessage,
  customEnvelopeDigest,
  OAuthTokenError,
  type OAuthTokenService,
} from "../oauth/tokens.js";
import {
  callWithSignedKey,
  SignedKeyRejectedError,
} from "../signed-keys/connector-auth.js";
import {
  createSignedKeyProviders,
  SignedKeyExchangeError,
  type SignedKey,
  type SignedKeyProviders,
} from "../signed-keys/registry.js";
import {
  createSignedKeyTokenStore,
  type SignedKeyTokenStore,
} from "../signed-keys/token-store.js";

import { recordFreshness, selectedResourcesOf } from "./freshness.js";
import { createDatasetStaging } from "./staging.js";

/** First-ever incremental sync with no cursor and no last success. */
const INITIAL_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Rows per observation INSERT: PostgreSQL binds at most 65,535 parameters in
 * one statement and a row binds six.
 */
const INSERT_BATCH_ROWS = 5_000;
/** How often a successful sync refreshes the resource names (#194). */
const RESOURCE_NAMES_REFRESH_MS = 24 * 60 * 60 * 1000;
/** The custom API item image quota when the host passes none (#809). */
const DEFAULT_CUSTOM_API_IMAGE_QUOTA: ImageQuota = {
  maxCount: CUSTOM_API_IMAGE_QUOTA_DEFAULT_COUNT,
  maxBytes: CUSTOM_API_IMAGE_QUOTA_DEFAULT_BYTES,
};
/** The image quota when the host passes none (the contract's defaults). */
const DEFAULT_IMAGE_QUOTA: ImageQuota = {
  maxCount: IMAGE_QUOTA_DEFAULT_COUNT,
  maxBytes: IMAGE_QUOTA_DEFAULT_BYTES,
};

export interface SyncEngineDeps {
  dataPolicy?: DataPolicy;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  /** Clock for sync windows and state timestamps; defaults to the wall clock. */
  now?: () => Date;
  /** Access tokens for OAuth connections (ADR 0012). */
  oauthTokens?: OAuthTokenService;
  /** Default: the signed-key providers of this server (ADR 0014). */
  signedKeys?: SignedKeyProviders;
  /**
   * Default: the cached exchanged tokens of signed-key connections over the
   * job's database (ADR 0020 §2).
   */
  signedKeyTokens?: SignedKeyTokenStore;
  /** Tests only: options for every connector call (e.g. local egress). */
  executeOptions?: ExecuteOptions;
  /**
   * Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS): private hosts the
   * custom-api connector may reach. Never given to bundled connectors.
   */
  customApiPrivateHosts?: readonly string[];
  /** The workspace image quota icons count against (#226). */
  imageQuota?: ImageQuota;
  /** The workspace quota of custom API item images (#809). */
  customApiImageQuota?: ImageQuota;
}

type ErrorClass = "auth" | "transient" | "contract" | "budget";

/**
 * Bounds of a provider's reset (#781): never sooner than a few seconds (a
 * reset in the past or right now), never later than a day (a provider's
 * clock or header gone wrong must not park a connection for weeks).
 */
const MIN_RATE_LIMIT_WAIT_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000;
/**
 * Jitter added to a reset: a tenth of the wait, at most a minute, so the
 * connections of one provider account do not all return at the same second.
 */
const MAX_RATE_LIMIT_JITTER_MS = 60_000;

/** When a rate-limited connection runs again: the bounded reset plus jitter. */
export function rateLimitedRunAt(
  retryAt: string,
  now: Date,
  random: () => number = Math.random,
): Date {
  const wait = Math.min(
    Math.max(Date.parse(retryAt) - now.getTime(), MIN_RATE_LIMIT_WAIT_MS),
    MAX_RATE_LIMIT_WAIT_MS,
  );
  const jitter =
    random() * Math.min(MAX_RATE_LIMIT_JITTER_MS, Math.max(1_000, wait / 10));
  return new Date(now.getTime() + wait + Math.floor(jitter));
}

/**
 * Dataset store failures that are not the connector's fault. Storage
 * failures (the store redacts every database error, including
 * serialization failures, deadlocks, timeouts and lost connections, to
 * dataset_storage_failed: its code, and for conflicts only the SQLSTATE)
 * and a refresh superseded by a concurrent newer one are retried like an
 * outage. A conflict reaches this only once the ingestion transaction's own
 * retries (ingestTransaction) are exhausted.
 */
const TRANSIENT_DATASET_ERRORS = new Set([
  "dataset_storage_failed",
  "dataset_refresh_superseded",
]);
/**
 * Quotas and size limits of the data policy: the job ends without retries
 * until space is freed or the policy changes (the next scheduled sync tries
 * again), recorded as "budget" rather than a connector contract failure.
 */
const BUDGET_DATASET_ERRORS = new Set([
  "dataset_workspace_quota",
  "dataset_source_quota",
  "dataset_refresh_limit",
  "dataset_generation_limit",
]);

/** A dataset page that does not fit the workspace's data policy. */
class DatasetBudgetError extends Error {
  constructor(code: string) {
    super(`Data storage limit reached (${code})`);
    this.name = "DatasetBudgetError";
  }
}

interface StateRow {
  cursor: string | null;
  nextFrom: Date | null;
  backfillJobId: string | null;
  lastSuccessAt: Date | null;
  pollIntervalSeconds: number;
  rateLimitedUntil: Date | null;
}

/** error_message / last_error are persisted verbatim: redact and truncate. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message)).slice(0, 500);
}

/**
 * The stable reason code of a failure, stored next to its message (#795):
 * a refused signed key's (the provider definition names it) or a
 * connector's (ConnectorError, SDK 0.2.18). Null for any other error, and
 * for a code that is not well formed: a code is a fixed word, never text.
 */
function errorCodeOf(error: unknown): string | null {
  const code =
    error instanceof SignedKeyRejectedError || error instanceof ConnectorError
      ? error.code
      : undefined;
  return isErrorCode(code) ? code : null;
}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * Computes the requested window for this run from the persisted state. The
 * cursor plays no part (#758): it is opaque, and an incremental window
 * starts where the last success said the next one does (next_from), else at
 * the last success.
 */
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
  const from =
    state?.nextFrom ??
    state?.lastSuccessAt ??
    new Date(now.getTime() - INITIAL_INCREMENTAL_WINDOW_MS);
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
  requestedMode: SyncMode,
  deps: SyncEngineDeps,
): Promise<void> {
  let mode = requestedMode;
  const { job, appDb, logger } = ctx;
  const workspaceId = job.workspaceId;
  const connectionId = job.connectionId;
  if (!workspaceId || !connectionId) {
    throw new NonRetryableJobError(
      `contract: ${job.kind} requires workspace and connection identity`,
    );
  }
  const attempt = job.attempts + 1;
  const clock = deps.now ?? (() => new Date());
  const now = clock();
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
        customApiEnvironmentId: schema.connections.customApiEnvironmentId,
        pin: customApiPinColumns,
      })
      .from(schema.connections)
      .leftJoin(
        schema.connectionOAuth,
        and(
          eq(schema.connectionOAuth.connectionId, schema.connections.id),
          eq(schema.connectionOAuth.workspaceId, workspaceId),
        ),
      )
      .leftJoin(
        schema.customApiDefinitionVersions,
        customApiPinJoin(workspaceId),
      )
      .where(
        and(
          eq(schema.connections.id, connectionId),
          eq(schema.connections.workspaceId, workspaceId),
          notDraftConnection(),
        ),
      )
      .limit(1);
    if (!connection) {
      return null;
    }
    const [state] = await tx
      .select({
        cursor: schema.connectionState.cursor,
        nextFrom: schema.connectionState.nextFrom,
        backfillJobId: schema.connectionState.backfillJobId,
        backfillJobDatasets: schema.connectionState.backfillJobDatasets,
        lastSuccessAt: schema.connectionState.lastSuccessAt,
        pollIntervalSeconds: schema.connectionState.pollIntervalSeconds,
        rateLimitedUntil: schema.connectionState.rateLimitedUntil,
      })
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId))
      .limit(1);
    const { policy } = await resolveDataPolicy(
      tx,
      workspaceId,
      deps.dataPolicy,
    );
    return { connection, state: state ?? null, policy };
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
  const { pin, customApiEnvironmentId, ...connectionRow } = loaded.connection;
  const connection = {
    ...connectionRow,
    config: loaded.connection.config as Record<string, unknown>,
  };
  /**
   * The connector this connection runs (ADR 0027): the registry's for a
   * bundled connector, one built from the pinned definition for custom-api.
   */
  const resolved = connectorFor(deps.registry, {
    row: { connectorId: connection.connectorId },
    customApi: connectionCustomApi(customApiEnvironmentId, pin),
  });
  // A connector without backfills (HTTP checks, #874) only reads what is
  // there now: the backfill job a new connection (or a finished setup)
  // queues for every connector runs as its first incremental sync instead
  // of failing the contract. Operator backfills refuse such connectors
  // before they queue anything.
  if (mode === "backfill" && resolved && !resolved.manifest.supportsBackfill) {
    mode = "incremental";
  }
  const state = loaded.state;
  // The provider's limit is used up (#781): no job of the connection asks
  // it before the reset. This one waits too, without a run or a retry.
  if (state?.rateLimitedUntil && state.rateLimitedUntil > now) {
    log.info(
      { until: iso(state.rateLimitedUntil) },
      "sync waits for the provider's rate limit",
    );
    throw new DeferJobError(
      state.rateLimitedUntil,
      `The provider's rate limit is used up until ${iso(state.rateLimitedUntil)}.`,
    );
  }
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
  /**
   * The datasets this backfill job reads (#617): taken when it starts, from
   * the connector this worker runs; a resumed attempt keeps only those its
   * own connector still declares at the same version (a deploy may have
   * changed them between attempts). Stored next to the job's id with every
   * checkpoint; its success records exactly these, never what a later
   * worker declares but earlier pages never read.
   */
  const declaredNow = datasetVersions(resolved?.manifest.datasets);
  const backfillDatasets =
    mode !== "backfill"
      ? null
      : fresh
        ? declaredNow
        : intersectDatasetVersions(
            state?.backfillJobDatasets ?? {},
            declaredNow,
          );
  const backfillMarker =
    mode === "backfill"
      ? { backfillJobId: job.id, backfillJobDatasets: backfillDatasets }
      : {};

  let window = computeWindow(
    mode,
    state,
    now,
    resolved?.manifest.backfillDays ?? 0,
  );
  const continuation = (
    job.payload as { continuation?: { syncWindow?: unknown } } | null
  )?.continuation?.syncWindow;
  if (continuation !== undefined) {
    const saved = continuation as {
      mode?: unknown;
      from?: unknown;
      to?: unknown;
    } | null;
    if (
      !saved ||
      saved.mode !== mode ||
      typeof saved.from !== "string" ||
      typeof saved.to !== "string" ||
      !Number.isFinite(Date.parse(saved.from)) ||
      !Number.isFinite(Date.parse(saved.to)) ||
      Date.parse(saved.from) >= Date.parse(saved.to)
    ) {
      throw new NonRetryableJobError(
        "contract: invalid sync continuation window",
      );
    }
    window = { from: new Date(saved.from), to: new Date(saved.to) };
  }
  /**
   * A succeeded backfill read the whole window into its datasets (#617):
   * merged into the record the automatic backfill of added datasets
   * compares against. Datasets it did not read keep their entry.
   */
  const backfillRecordInsert =
    backfillDatasets !== null ? { backfilledDatasets: backfillDatasets } : {};
  const backfillRecordSet =
    backfillDatasets !== null
      ? {
          backfilledDatasets: sql`coalesce(${schema.connectionState.backfilledDatasets}, '{}'::jsonb) || ${JSON.stringify(backfillDatasets)}::jsonb`,
        }
      : {};
  const pollIntervalSeconds =
    state?.pollIntervalSeconds ??
    resolved?.manifest.minRefreshIntervalSeconds ??
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

  /**
   * Records a failed sync_run + connection_state in a fresh transaction.
   * With `envelopeDigest` (a custom OAuth client refused, #825) the auth
   * state changes only while that envelope is still stored: a client
   * replaced meanwhile (PATCH credentials) stays as the PATCH left it.
   */
  const recordFailure = async (
    errorClass: ErrorClass,
    error: unknown,
    authReason?: OAuthAuthReason,
    envelopeDigest?: string | null,
  ): Promise<void> => {
    const message = safeMessage(error);
    const errorCode = errorCodeOf(error);
    try {
      await withWorkspace(appDb, { workspaceId }, async (tx) => {
        let replaced = false;
        if (envelopeDigest) {
          // The connection row lock the client change writes under.
          const [row] = await tx
            .select({ envelope: schema.connections.credentialsEncrypted })
            .from(schema.connections)
            .where(
              and(
                eq(schema.connections.workspaceId, workspaceId),
                eq(schema.connections.id, connectionId),
              ),
            )
            .for("update");
          replaced =
            !row?.envelope ||
            customEnvelopeDigest(row.envelope) !== envelopeDigest;
        }
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
          errorCode,
          observationsWritten: progress.observationsWritten,
        });
        const statePatch = {
          ...(replaced
            ? {}
            : authReason
              ? { authState: "needs_reauthorization", authReason }
              : errorClass === "auth"
                ? { authState: "auth_failed", authReason: null }
                : errorClass === "transient"
                  ? { authState: "outage", authReason: null }
                  : {}),
          // A backfill that failed read part of its window at most: no
          // history start is claimed until one succeeds (#378), and the
          // history counts as incomplete once no attempt is left (#787).
          ...(mode === "backfill"
            ? { historyFrom: null, backfillFailedAt: new Date() }
            : {}),
        };
        // A refusal of a replaced client is no failure of the connection
        // as it is now: its failure count stays as the change left it, so
        // the source does not read as an outage (#829).
        const failures = replaced
          ? {}
          : {
              consecutiveFailures: sql`${schema.connectionState.consecutiveFailures} + 1`,
            };
        if (Object.keys(statePatch).length + Object.keys(failures).length > 0)
          await tx
            .insert(schema.connectionState)
            .values({
              connectionId,
              workspaceId,
              pollIntervalSeconds,
              consecutiveFailures: replaced ? 0 : 1,
              ...statePatch,
            })
            .onConflictDoUpdate({
              target: schema.connectionState.connectionId,
              set: { ...statePatch, ...failures },
            });
      });
    } catch (recordingError) {
      rethrowWorkspaceGone(recordingError);
      log.error(
        { err: safeMessage(recordingError) },
        "failed to record sync failure",
      );
    }
    log.warn(
      { errorClass, ...(errorCode ? { errorCode } : {}), err: message },
      "sync run failed",
    );
  };

  /**
   * The provider's request limit is used up until a known reset (#781): no
   * failure and no outage. Records the run as rate_limited (with what
   * earlier pages committed). The provider answered, so a streak of
   * failures before it is over: the failure count goes back to 0 and an
   * outage to ok (the status board reads both, #721); other auth states
   * stay. Moves every waiting job of the connection to the reset. Returns the
   * error that puts this job back to wait: a backfill, or a run that
   * committed pages, keeps its window as a continuation, so it resumes
   * from its checkpoint and holds the connection until it is done.
   */
  const rateLimited = async (error: RateLimitedError): Promise<Error> => {
    const runAt = rateLimitedRunAt(error.retryAt, new Date());
    const runAtSql = sql`${iso(runAt)}::timestamptz`;
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
          cursorAfter: progress.pagesCommitted > 0 ? progress.cursor : null,
          attempt,
          status: "failed",
          startedAt: now,
          finishedAt: new Date(),
          errorClass: "rate_limited",
          errorMessage: message,
          observationsWritten: progress.observationsWritten,
        });
        await tx
          .insert(schema.connectionState)
          .values({
            connectionId,
            workspaceId,
            pollIntervalSeconds,
            rateLimitedUntil: runAt,
            nextDueAt: runAt,
            consecutiveFailures: 0,
          })
          .onConflictDoUpdate({
            target: schema.connectionState.connectionId,
            set: {
              rateLimitedUntil: runAt,
              nextDueAt: sql`greatest(coalesce(${schema.connectionState.nextDueAt}, ${runAtSql}), ${runAtSql})`,
              authState: sql`case when ${schema.connectionState.authState} = 'outage' then 'ok' else ${schema.connectionState.authState} end`,
              consecutiveFailures: 0,
            },
          });
        // The skipped records of the pages committed before the limit.
        await saveRecordSkips(tx);
        await tx
          .update(schema.jobs)
          .set({
            runAt: sql`greatest(${schema.jobs.runAt}, ${runAtSql})`,
          })
          .where(
            and(
              eq(schema.jobs.workspaceId, workspaceId),
              eq(schema.jobs.connectionId, connectionId),
              ne(schema.jobs.id, job.id),
              inArray(schema.jobs.kind, [
                "connection.sync",
                "connection.backfill",
              ]),
              inArray(schema.jobs.status, ["pending", "continuing"]),
            ),
          );
      });
    } catch (recordingError) {
      rethrowWorkspaceGone(recordingError);
      log.error(
        { err: safeMessage(recordingError) },
        "failed to record rate limit",
      );
    }
    log.warn(
      { retryAt: error.retryAt, runAt: iso(runAt), err: message },
      "sync rate limited by the provider",
    );
    const holdWindow = mode === "backfill" || progress.pagesCommitted > 0;
    return new DeferJobError(
      runAt,
      message,
      holdWindow
        ? { syncWindow: { mode, from: iso(window.from), to: iso(window.to) } }
        : undefined,
    );
  };

  // Registry lookup: an unknown connector id means catalog drift — permanent.
  const registered = resolved;
  if (!registered) {
    const error = new Error(
      `contract: no connector registered for "${connection.connectorId}"`,
    );
    await recordFailure("contract", error);
    throw new NonRetryableJobError(error.message);
  }
  const { connector, manifest } = registered;

  // Optional resource subset (stored in config under a reserved key so it
  // cannot clash with manifest config properties, whose validation rejects
  // additionalProperties before this merge happens). Never configured means
  // every resource. For a connector that honors a selection, an explicit
  // empty one means collection is paused: the connector receives
  // `resources: []` and collects no resource-scoped data, while the
  // credential check still runs and the run succeeds (the connection stays
  // healthy; the dashboard shows it as paused).
  const selectedResources = selectedResourcesOf(connection.config, manifest);

  if (mode === "backfill" && !manifest.supportsBackfill) {
    const error = new Error(
      `contract: connector "${manifest.id}" does not support backfill`,
    );
    await recordFailure("contract", error);
    throw new NonRetryableJobError(error.message);
  }

  // OAuth connections (ADR 0012): the connector receives a short-lived
  // access token per call; the refresh token never leaves the host.
  // Custom APIs (#805) with an OAuth login always go through the token
  // service, under provider "custom", even before their first grant.
  const oauthProvider = connectionOAuthProvider(
    registered,
    connection.oauthProvider,
  );
  const oauthScopes = oauthProvider
    ? requiredOAuthScopes(registered, oauthProvider)
    : undefined;
  const oauthStrategy = oauthScopes ? { scopes: oauthScopes } : undefined;
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
    rethrowWorkspaceGone(error);
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
  // Providers with a token exchange cache the exchanged token per
  // connection; others sign per call and never touch the store.
  const signedKeyCache = signedKey?.exchanges
    ? (
        deps.signedKeyTokens ??
        createSignedKeyTokenStore({
          db: appDb,
          credentialKeyring: deps.credentialKeyring,
          logger: log,
        })
      ).forConnection(binding)
    : undefined;

  // Connector log lines (SDK 0.2.14, #638), already sanitized by the
  // runtime, attributed to this connection, run (jobId) and attempt.
  const connectorLog = log.child({ source: "connector" });
  // A custom API's skipped records of this job, per stream (#834 review):
  // its "records skipped" lines, kept for the connection page. Only
  // streams of the pinned definition and paths of their fields count.
  const customApiStreams = new Map(
    (registered.customApi?.definition.streams ?? []).map((stream) => [
      stream.key,
      new Set(stream.fields.map((field) => field.path)),
    ]),
  );
  type Skips = Map<string, { skipped: number; byPath: Map<string, number> }>;
  const recordSkips: Skips = new Map();
  /**
   * The skips of the sync call running now; null outside sync calls (a
   * check reads the first page too, and must not count). Merged into
   * recordSkips only when the call answered, so a failed call's page,
   * never committed, never counts.
   */
  let callSkips: Skips | null = null;
  const mergeSkips = (into: Skips, from: Skips) => {
    for (const [stream, part] of from) {
      const total = into.get(stream) ?? {
        skipped: 0,
        byPath: new Map<string, number>(),
      };
      total.skipped += part.skipped;
      for (const [path, count] of part.byPath)
        total.byPath.set(path, (total.byPath.get(path) ?? 0) + count);
      into.set(stream, total);
    }
  };
  const countSkips = (
    connectorId: string,
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ) => {
    if (
      callSkips === null ||
      connectorId !== CUSTOM_API_CONNECTOR_ID ||
      message !== CUSTOM_API_SKIPPED_LOG ||
      typeof fields.stream !== "string"
    )
      return;
    const paths = customApiStreams.get(fields.stream);
    const read = readSkippedLogFields(fields);
    if (!paths || !read) return;
    mergeSkips(
      callSkips,
      new Map([
        [
          fields.stream,
          {
            skipped: read.skipped,
            byPath: new Map(
              [...read.byPath].filter(([path]) => paths.has(path)),
            ),
          },
        ],
      ]),
    );
  };
  /**
   * Writes the skipped records counted since the last commit, in the
   * transaction that commits their pages (#834 re-review): every page
   * checkpoint, a continuation, a rate limit and the run's end. The summary
   * is the last run's, a failed one included, as far as that run committed
   * pages. A job that is no continuation replaces it with its first write;
   * every other write adds to it, so a continued or rate-limited run counts
   * every page once, and a retried attempt (read again from the start)
   * too. Every write moves each stream's checkedAt to this job, also for a
   * stream without new skips. Call skipsCommitted() once the transaction
   * committed.
   */
  let skipsWritten = false;
  // Only a continuation keeps its window, and the custom API connector
  // resumes a cursor only for the same window: a retried attempt (a new
  // window) reads its stream again from the first page, so it starts over
  // too, even from a stored checkpoint.
  const startsOver = continuation === undefined;
  const saveRecordSkips = async (tx: Transaction) => {
    const add = skipsWritten || !startsOver;
    for (const streamKey of customApiStreams.keys()) {
      const total = recordSkips.get(streamKey);
      await recordStreamRecords(tx, {
        workspaceId,
        connectionId,
        streamKey,
        checkedAt: now,
        skipped: total?.skipped ?? 0,
        skippedFields: Object.fromEntries(total?.byPath ?? []),
        add,
        maxFields: CUSTOM_API_SKIPPED_FIELDS,
      });
    }
  };
  const skipsCommitted = () => {
    if (customApiStreams.size === 0) return;
    recordSkips.clear();
    skipsWritten = true;
  };
  const executeOptions: ExecuteOptions = callOptionsFor(
    registered,
    {
      ...deps.executeOptions,
      log: ({ level, connector: connectorId, message, fields }) => {
        countSkips(connectorId, message, fields);
        connectorLog[level]({ connector: connectorId, fields }, message);
      },
    },
    {
      credentials,
      config: connection.config,
      privateHosts: deps.customApiPrivateHosts ?? [],
    },
  );
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
          ...(signedKeyCache ? { cache: signedKeyCache } : {}),
          options: executeOptions,
          call: (tokenCredentials, options) =>
            call({ ...context, credentials: { ...tokenCredentials } }, options),
          ...(rejected ? { rejected } : {}),
        })
      : oauthStrategy
        ? callWithAccessToken({
            tokens: deps.oauthTokens,
            binding,
            requiredScopes: oauthStrategy.scopes,
            options: executeOptions,
            call: (oauthCredentials, options) =>
              call(
                { ...context, credentials: { ...oauthCredentials } },
                registered.customApi
                  ? {
                      ...options,
                      // The minted token is a secret of this call too.
                      redactValues: [
                        ...(options.redactValues ?? []),
                        oauthCredentials.accessToken,
                        `Bearer ${oauthCredentials.accessToken}`,
                      ],
                    }
                  : options,
              ),
            ...(rejected ? { rejected } : {}),
          })
        : call(context, executeOptions);

  /**
   * Records an OAuth token failure or a refused signed key; returns the
   * error to throw, or null when the error is not one.
   */
  const authFailure = async (error: unknown): Promise<Error | null> => {
    if (error instanceof CredentialHostMismatchError) {
      // Stored credentials bound to another host than the configuration
      // names (#884 review 2): only new credentials, in a new connection,
      // help. auth_failed with its reason code; no retries.
      await recordFailure("auth", error);
      return new TerminalJobError(error.message);
    }
    if (error instanceof SignedKeyRejectedError) {
      // auth_failed with the provider's "upload a new key" message; the
      // scheduler skips the connection until new credentials arrive.
      await recordFailure("auth", error);
      return new TerminalJobError(error.message);
    }
    if (error instanceof SignedKeyExchangeError) {
      // rejected never gets here (callWithSignedKey makes it a refused
      // key); the message names status and error code only.
      if (error.kind === "configuration") {
        await recordFailure("contract", error);
        return new NonRetryableJobError(safeMessage(error));
      }
      await recordFailure("transient", error);
      return error;
    }
    if (error instanceof NeedsReauthorizationError) {
      await recordFailure("auth", error, error.reason);
      return new TerminalJobError(error.message);
    }
    if (error instanceof OAuthTokenError) {
      const custom = customOAuthFailureMessage(error);
      if (custom) {
        // A custom API's client was refused, lacks scopes, or was entered
        // for other hosts: only new client credentials help (auth_failed).
        const refused = new Error(custom);
        await recordFailure("auth", refused, undefined, error.envelopeDigest);
        return new TerminalJobError(refused.message);
      }
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
    if (error instanceof RateLimitedError) throw await rateLimited(error);
    const authError = await authFailure(error);
    if (authError) {
      throw authError;
    }
    await recordFailure("transient", error);
    throw error;
  }
  if (!check.ok) {
    // The check's reason code is recorded with its message (#795).
    const message = check.message ?? "credential check failed";
    const error = isErrorCode(check.code)
      ? new ConnectorError(message, check.code)
      : new Error(message);
    await recordFailure("auth", error);
    throw new TerminalJobError(safeMessage(error));
  }

  // Step 2b (#782): only for a connector that declares its discovery cheap
  // and safe before the first sync (discoversBeforeFirstSync, SDK 0.2.19);
  // every other connector's first run makes the same calls as ever. A
  // connection that has never synced successfully and has no resource
  // names yet learns them before the pages are read, so pickers and tables
  // can name its resources while a long first backfill runs or waits for a
  // provider limit. Strictly additive: the names are provisional (they
  // never count as a discovery), and step 4 discovers after the sync
  // exactly as it does without this step. Best effort, except a provider
  // limit with a known reset, which defers the run before any page is
  // asked for.
  if (manifest.discoversBeforeFirstSync && !state?.lastSuccessAt) {
    try {
      const discoveredAt = await withWorkspace(appDb, { workspaceId }, (tx) =>
        connectionResourcesDiscoveredAt(tx, workspaceId, connectionId),
      );
      if (!discoveredAt) {
        const resources = await callConnector((callContext, options) =>
          executeDiscover(connector, callContext, options),
        );
        await withWorkspace(appDb, { workspaceId }, (tx) =>
          upsertConnectionResources(tx, {
            workspaceId,
            connectionId,
            resources,
            now,
            provisional: true,
          }),
        );
      }
    } catch (error) {
      rethrowWorkspaceGone(error);
      if (error instanceof RateLimitedError) throw await rateLimited(error);
      log.warn({ err: safeMessage(error) }, "resource names not discovered");
    }
  }

  // Step 3: fetch pages from the provider OUTSIDE any transaction (no
  // database connection waits on external I/O), bounded by the configured sync page budget, and
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
            notDraftConnection(),
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

    const ingestDatasets = async (
      tx: Transaction,
      result: Pick<SyncResult, "datasetPages">,
    ) => {
      for (const page of result.datasetPages ?? []) {
        const definition = manifest.datasets?.find(
          (item) => item.key === page.datasetKey,
        );
        if (!definition)
          throw new ContractViolationError("Undeclared source dataset");
        try {
          await ingestDatasetPage(tx, {
            workspaceId,
            connectionId,
            definition,
            page,
            now,
            policyDefaults: deps.dataPolicy,
            clock,
            ...(page.stagingId || page.stagingPageKey
              ? {
                  retainedSource: await connectorStageProvenance(
                    tx,
                    {
                      workspaceId,
                      connectionId,
                      connectorId: manifest.id,
                      clock,
                      policyDefaults: deps.dataPolicy,
                    },
                    page,
                  ),
                }
              : {}),
          });
        } catch (error) {
          if (error instanceof DatasetStageUnavailableError) throw error;
          if (error instanceof DatasetStoreError) {
            // Source retention can expire after provenance was checked, while
            // waiting on ingestion's lock. Rebuild from the durable checkpoint.
            if (
              page.stagingId &&
              (error.code === "dataset_replay_unavailable" ||
                error.code === "dataset_refresh_expired")
            )
              throw new DatasetStageUnavailableError();
            // The store's error carries only its code, and for conflicts
            // only the SQLSTATE: nothing else of the database error reaches
            // logs or sync_runs.
            if (TRANSIENT_DATASET_ERRORS.has(error.code)) throw error;
            if (BUDGET_DATASET_ERRORS.has(error.code))
              throw new DatasetBudgetError(error.code);
            throw new ContractViolationError(error.code);
          }
          throw error;
        }
      }
    };
    /**
     * One ingestion transaction (a page's checkpoint or the final commit),
     * run again on a serialization failure or deadlock (#604), with the
     * data service's backoff (#598). Before, a conflict failed the job as a
     * transient dataset_storage_failed and the whole run was retried later.
     * The body only stores what the connector already returned: every
     * provider call happens before it, so a retry fetches nothing again.
     * An exhausted retry rethrows the last error, handled as before.
     */
    const ingestTransaction = <T>(body: (tx: Transaction) => Promise<T>) =>
      retryOnSerializationFailure(
        () => withWorkspace(appDb, { workspaceId }, body),
        {
          onRetry: (_error, index, delayMs) =>
            log.info(
              { attempt: index + 1, delayMs },
              "sync ingestion conflicted, retrying",
            ),
        },
      );
    /**
     * Datasets the finished run checked completely (SDK 0.2.12, #666): one
     * without rows yet is stored as received and empty, not left pending.
     * Never replaces stored rows. Errors are classified as a page's are.
     */
    const receiveDatasets = async (
      tx: Transaction,
      result: Pick<SyncResult, "receivedDatasets">,
    ) => {
      for (const key of new Set(result.receivedDatasets ?? [])) {
        const definition = manifest.datasets?.find((item) => item.key === key);
        if (!definition)
          throw new ContractViolationError("Undeclared source dataset");
        try {
          await receiveEmptySourceDataset(tx, {
            workspaceId,
            connectionId,
            definition,
            now,
            policyDefaults: deps.dataPolicy,
            clock,
          });
        } catch (error) {
          if (error instanceof DatasetStoreError) {
            if (TRANSIENT_DATASET_ERRORS.has(error.code)) throw error;
            if (BUDGET_DATASET_ERRORS.has(error.code))
              throw new DatasetBudgetError(error.code);
            throw new ContractViolationError(error.code);
          }
          throw error;
        }
      }
    };
    let finalDatasetPages: Pick<
      SyncResult,
      "datasetPages" | "receivedDatasets"
    > = {};
    let finalObservations: Observation[] = [];
    let finalReviews: Pick<SyncResult, "reviews" | "reviewWindows"> = {};
    let finalFreshness: NonNullable<SyncResult["freshness"]> = [];
    let finalCursor = startCursor;
    /**
     * Where the next incremental window starts (#758): the connector's
     * nextFrom, else this window's end. A run with an empty window keeps
     * its start.
     */
    let finalNextFrom = window.from;
    if (window.from < window.to) {
      let cursor = startCursor ?? undefined;
      for (let page = 1; ; page += 1) {
        if (
          loaded.policy.syncPagesPerRun !== null &&
          page > loaded.policy.syncPagesPerRun
        ) {
          await withWorkspace(appDb, { workspaceId }, async (tx) => {
            await tx.insert(schema.syncRuns).values({
              workspaceId,
              connectionId,
              mode,
              requestedFrom: window.from,
              requestedTo: window.to,
              cursorBefore: startCursor,
              cursorAfter: progress.cursor,
              attempt,
              status: "continued",
              startedAt: now,
              finishedAt: new Date(),
              observationsWritten: progress.observationsWritten,
            });
            await saveRecordSkips(tx);
          });
          throw new ContinueJobError({
            syncWindow: { mode, from: iso(window.from), to: iso(window.to) },
          });
        }
        const request: SyncRequest = {
          mode,
          from: iso(window.from),
          to: iso(window.to),
          ...(cursor ? { cursor } : {}),
          ...(selectedResources ? { resources: selectedResources } : {}),
        };
        const skipsOfCall: Skips = new Map();
        callSkips = skipsOfCall;
        let result: SyncResult;
        try {
          result = await callConnector((callContext, options) =>
            executeSync(connector, callContext, request, {
              ...options,
              datasetStaging: (signal) =>
                createDatasetStaging({
                  db: appDb,
                  workspaceId,
                  connectionId,
                  manifest,
                  clock,
                  policyDefaults: deps.dataPolicy,
                  signal,
                }),
            }),
          );
        } finally {
          callSkips = null;
        }
        mergeSkips(recordSkips, skipsOfCall);
        if (result.done) {
          finalObservations = result.observations;
          finalDatasetPages = result;
          finalReviews = result;
          finalFreshness = result.freshness ?? [];
          finalCursor = result.nextCursor ?? null;
          finalNextFrom = result.nextFrom
            ? new Date(result.nextFrom)
            : window.to;
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
        const written = await ingestTransaction(async (tx) => {
          const count = await ingestPage(tx, result.observations);
          // Datasets first: they take the workspace ingestion lock, and
          // retention updates take that lock before the connection row
          // that ingestReviews share-locks. Same order, no deadlock.
          await ingestDatasets(tx, result);
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
          await saveRecordSkips(tx);
          return count;
        });
        skipsCommitted();
        progress.pagesCommitted += 1;
        progress.observationsWritten += written;
        progress.cursor = nextCursor;
        cursor = nextCursor;
      }
    }

    // A succeeded backfill read its whole window: the connection's history
    // starts there (#378), for empty widget windows that read 0.
    const historyRecord =
      mode === "backfill"
        ? { historyFrom: window.from, backfillFailedAt: null }
        : {};
    await ingestTransaction(async (tx) => {
      const observationsWritten =
        progress.observationsWritten +
        (await ingestPage(tx, finalObservations));
      // Datasets before reviews: lock order as in the page transaction.
      await ingestDatasets(tx, finalDatasetPages);
      await receiveDatasets(tx, finalDatasetPages);
      await ingestReviews(tx, finalReviews);
      // Freshness (ADR 0025 §4) commits with lastSuccessAt and the cursor,
      // and the next sync follows from the stored rows (§5).
      const nextDueAt = await recordFreshness(tx, {
        workspaceId,
        connectionId,
        manifest,
        entries: finalFreshness,
        selectedResources,
        pollIntervalSeconds,
        now,
      });

      // Cursor advancement commits in this same transaction as the
      // observation inserts — never without them.
      await tx
        .insert(schema.connectionState)
        .values({
          connectionId,
          workspaceId,
          pollIntervalSeconds,
          lastSuccessAt: now,
          nextDueAt,
          cursor: finalCursor,
          nextFrom: finalNextFrom,
          ...backfillMarker,
          ...backfillRecordInsert,
          ...historyRecord,
          authState: "ok",
          authReason: null,
          consecutiveFailures: 0,
          rateLimitedUntil: null,
        })
        .onConflictDoUpdate({
          target: schema.connectionState.connectionId,
          set: {
            lastSuccessAt: now,
            nextDueAt,
            cursor: finalCursor,
            nextFrom: finalNextFrom,
            ...backfillMarker,
            ...backfillRecordSet,
            ...historyRecord,
            authState: "ok",
            authReason: null,
            consecutiveFailures: 0,
            rateLimitedUntil: null,
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
      await saveRecordSkips(tx);
    });
  } catch (error) {
    if (error instanceof ContinueJobError) throw error;
    if (error instanceof RateLimitedError) throw await rateLimited(error);
    const authError = await authFailure(error);
    if (authError) {
      throw authError;
    }
    if (error instanceof DatasetBudgetError) {
      await recordFailure("budget", error);
      throw new TerminalJobError(safeMessage(error));
    }
    // The custom-api connector's run limits and refusals (ADR 0027), by
    // name: the runtime's redaction keeps the name, not the class. A limit
    // keeps what earlier pages committed; the stored cursor lets the next
    // run go on.
    if (error instanceof Error && error.name === CUSTOM_API_LIMIT_ERROR) {
      await recordFailure("budget", error);
      throw new TerminalJobError(safeMessage(error));
    }
    if (error instanceof Error && error.name === CUSTOM_API_AUTH_ERROR) {
      await recordFailure("auth", error);
      throw new TerminalJobError(safeMessage(error));
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

  // #617: a connector update that adds a dataset (or changes one's schema
  // version) leaves the connection's history of it to incremental runs.
  // After a succeeded incremental run, queue one backfill for it. Best
  // effort: a failure is logged and the next run asks again.
  if (
    mode === "incremental" &&
    manifest.supportsBackfill &&
    (manifest.datasets?.length ?? 0) > 0
  ) {
    try {
      const outcome = await withWorkspace(appDb, { workspaceId }, (tx) =>
        queueDatasetBackfill(tx, {
          workspaceId,
          connectionId,
          connectorId: manifest.id,
          declared: datasetVersions(manifest.datasets),
        }),
      );
      if (outcome.queued) {
        log.info(
          { datasets: outcome.datasets, jobId: outcome.jobId },
          "backfill queued for datasets without history",
        );
      } else if (outcome.reason === "workspace_busy") {
        log.info(
          { datasets: outcome.datasets },
          "backfill for datasets without history waits for another backfill in the workspace",
        );
      }
    } catch (error) {
      rethrowWorkspaceGone(error);
      log.warn(
        { err: safeMessage(error) },
        "datasets without history not checked",
      );
    }
  }

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
    rethrowWorkspaceGone(error);
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
      rethrowWorkspaceGone(error);
      log.warn({ err: safeMessage(error) }, "resource icons not refreshed");
    }
  }

  // Step 6 (#809): a custom API's item images, the newest items' of each
  // image stream, after every succeeded run. Best effort: a failed or
  // skipped image is counted on its stream and never fails the run.
  if (registered.customApi) {
    try {
      await ingestCustomApiImages({
        db: appDb,
        workspaceId,
        connectionId,
        resolved: registered,
        run: (call) => callConnector(call),
        quota: deps.customApiImageQuota ?? DEFAULT_CUSTOM_API_IMAGE_QUOTA,
        now,
        log: (message, fields) => log.info(fields ?? {}, message),
      });
    } catch (error) {
      rethrowWorkspaceGone(error);
      log.warn({ err: safeMessage(error) }, "item images not stored");
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
