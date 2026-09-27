import { eq, sql } from "drizzle-orm";

import {
  ContractViolationError,
  executeCheck,
  executeSync,
  redactSecrets,
  type ConnectorRegistry,
} from "@netrics/connector-runtime";
import type { SyncMode, SyncRequest } from "@netrics/connector-sdk";
import { schema, withWorkspace, type Transaction } from "@netrics/database";

import { decryptCredentials } from "../credentials.js";
import {
  NonRetryableJobError,
  TerminalJobError,
  type JobHandler,
  type JobHandlerContext,
} from "../jobs/handlers.js";
import { upsertConnectorCatalog } from "./catalog.js";

/** Backfills always request the window [now - 90 days, now). */
const BACKFILL_WINDOW_DAYS = 90;
/** First-ever incremental sync with no cursor and no last success. */
const INITIAL_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pagination bound: a connector paging forever is a contract violation. */
const MAX_PAGES = 100;

export interface SyncEngineDeps {
  registry: ConnectorRegistry;
  appEncryptionKey: string;
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
): { from: Date; to: Date } {
  if (mode === "backfill") {
    return {
      from: new Date(
        now.getTime() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ),
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
async function ingestObservations(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    metricDefinitionIds: Map<string, string>;
    observations: Array<{
      metricKey: string;
      sourceTimestamp: string;
      value: number;
      dimensions: Record<string, string>;
      sourceIdentity: string;
    }>;
  },
): Promise<number> {
  if (input.observations.length === 0) {
    return 0;
  }
  const rows = input.observations.map((observation) => {
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
      sourceIdentity: observation.sourceIdentity,
    };
  });
  const inserted = await tx
    .insert(schema.observations)
    .values(rows)
    .onConflictDoNothing({
      target: [
        schema.observations.connectionId,
        schema.observations.sourceIdentity,
      ],
    })
    .returning({ id: schema.observations.id });
  return inserted.length;
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
  const now = new Date();
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
      })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId))
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
  const connection = {
    ...loaded.connection,
    config: loaded.connection.config as Record<string, unknown>,
  };
  const state = loaded.state;

  const window = computeWindow(mode, state, now);
  const pollIntervalSeconds =
    state?.pollIntervalSeconds ??
    deps.registry.get(connection.connectorId)?.manifest
      .minRefreshIntervalSeconds ??
    300;

  /** Records a failed sync_run + connection_state in a fresh transaction. */
  const recordFailure = async (
    errorClass: ErrorClass,
    error: unknown,
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
        const statePatch =
          errorClass === "auth"
            ? { authState: "auth_failed" }
            : errorClass === "transient"
              ? { authState: "outage" }
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

  // Decrypt credentials; a broken envelope needs operator attention, not a
  // retry loop — classified as contract.
  let credentials: Record<string, unknown>;
  try {
    credentials = connection.credentialsEncrypted
      ? (JSON.parse(
          decryptCredentials(
            connection.credentialsEncrypted.toString("utf8"),
            deps.appEncryptionKey,
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

  // Step 2: credential check. ok:false is terminal until the user repairs
  // credentials (auth_failed; the scheduler skips such connections and the
  // credential-update flow resets the state). A thrown check is a retryable
  // provider failure.
  let check;
  try {
    check = await executeCheck(connector, context);
  } catch (error) {
    await recordFailure("transient", error);
    throw error;
  }
  if (!check.ok) {
    const error = new Error(check.message ?? "credential check failed");
    await recordFailure("auth", error);
    throw new TerminalJobError(safeMessage(error));
  }

  // Step 3: sync + ingest + cursor advance + success, atomically. Contract
  // violations and provider failures roll the whole attempt back.
  try {
    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      // First-use safety net: catalog sync runs at startup, but upserting
      // here keeps the run self-healing (idempotent).
      await upsertConnectorCatalog(tx, manifest);
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

      const [syncRun] = await tx
        .insert(schema.syncRuns)
        .values({
          workspaceId,
          connectionId,
          mode,
          requestedFrom: window.from,
          requestedTo: window.to,
          cursorBefore: state?.cursor ?? null,
          attempt,
          status: "running",
          startedAt: now,
        })
        .returning({ id: schema.syncRuns.id });
      if (!syncRun) {
        throw new Error("sync_run insert returned no row");
      }

      let observationsWritten = 0;
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
          };
          const result = await executeSync(connector, context, request);
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
          observationsWritten += await ingestObservations(tx, {
            workspaceId,
            connectionId,
            metricDefinitionIds,
            observations: result.observations,
          });
          cursor = result.nextCursor;
          done = result.done;
        }
        finalCursor = cursor ?? iso(window.to);
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
          consecutiveFailures: 0,
        })
        .onConflictDoUpdate({
          target: schema.connectionState.connectionId,
          set: {
            lastSuccessAt: now,
            nextDueAt: new Date(now.getTime() + pollIntervalSeconds * 1000),
            cursor: finalCursor,
            authState: "ok",
            consecutiveFailures: 0,
          },
        });
      await tx
        .update(schema.syncRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          cursorAfter: finalCursor,
          observationsWritten,
        })
        .where(eq(schema.syncRuns.id, syncRun.id));
    });
  } catch (error) {
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
