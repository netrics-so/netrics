import type {
  ConnectorDatasetStaging,
  ConnectorManifest,
  DatasetPage,
  DatasetStageWriter,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";
import {
  DatasetStoreError,
  DatasetStageUnavailableError,
  abortConnectorStage,
  appendConnectorStagePages,
  beginConnectorStage,
  commitConnectorStage,
  findConnectorStage,
  matchConnectorStage,
  prepareConnectorStagePages,
  readConnectorStagePage,
  withWorkspace,
  type Db,
  type Transaction,
} from "@netrics/database";
import { ContractViolationError } from "@netrics/connector-runtime";
import type { DataPolicy } from "@netrics/domain";

/** Compressed bytes `put` stores per append transaction. */
const PUT_APPEND_BYTES = 8 * 1024 * 1024;

/**
 * Host binds scope once; connector-controlled keys never choose another tenant.
 * Drafts (ADR 0024) belong to this connector call: when its signal aborts,
 * open drafts are discarded and their writers refuse further calls.
 */
export function createDatasetStaging(input: {
  db: Db;
  workspaceId: string;
  connectionId: string;
  manifest: ConnectorManifest;
  clock?: () => Date;
  policyDefaults?: DataPolicy;
  signal: AbortSignal;
}): ConnectorDatasetStaging {
  const scope = {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    connectorId: input.manifest.id,
    clock: input.clock ?? (() => new Date()),
    policyDefaults: input.policyDefaults,
  };
  const contract = (error: unknown): never => {
    if (
      error instanceof DatasetStoreError &&
      !(error instanceof DatasetStageUnavailableError)
    )
      throw new ContractViolationError(error.code);
    throw error;
  };
  const transaction = async <T>(call: (tx: Transaction) => Promise<T>) => {
    input.signal.throwIfAborted();
    try {
      return await withWorkspace(input.db, scope, async (tx) => {
        input.signal.throwIfAborted();
        const result = await call(tx);
        input.signal.throwIfAborted();
        return result;
      });
    } catch (error) {
      return contract(error);
    }
  };
  const definitionOf = (datasetKey?: string, schemaVersion?: number) => {
    const definition = input.manifest.datasets?.find(
      (d) => d.key === datasetKey && d.version === schemaVersion,
    );
    if (!definition) throw new Error("Undeclared staged source dataset");
    return definition;
  };
  const prepare = (
    pages: DatasetPage[],
    definition: SourceDatasetDefinition,
  ) => {
    try {
      return prepareConnectorStagePages(pages, definition);
    } catch (error) {
      return contract(error);
    }
  };

  // Drafts this call has open; discarded when the call ends or is aborted.
  const open = new Set<string>();
  const discard = async (id: string) => {
    open.delete(id);
    // Cleanup runs after an abort too, so it ignores the call's signal. A
    // failure leaves the draft to expire within CONNECTOR_STAGE_DRAFT_TTL_MS.
    await withWorkspace(input.db, scope, (tx) =>
      abortConnectorStage(tx, scope, id),
    ).catch(() => undefined);
  };
  input.signal.addEventListener(
    "abort",
    () => {
      for (const id of [...open]) void discard(id);
    },
    { once: true },
  );

  type Prepared = ReturnType<typeof prepareConnectorStagePages>;
  /** A draft writer over already prepared (validated, compressed) pages. */
  const draft = async (key: string, definition: SourceDatasetDefinition) => {
    const { id } = await transaction((tx) =>
      beginConnectorStage(tx, scope, { key }, definition),
    );
    open.add(id);
    // The signal may have fired while the draft was being created.
    if (input.signal.aborted) {
      await discard(id);
      input.signal.throwIfAborted();
    }
    let state: "open" | "busy" | "closed" = "open";
    const step = async <T>(call: () => Promise<T>): Promise<T> => {
      if (state !== "open" || !open.has(id))
        throw new ContractViolationError("dataset_stage_closed");
      state = "busy";
      try {
        const result = await call();
        state = "open";
        return result;
      } catch (error) {
        // Any failed step ends the draft: nothing partial stays behind.
        state = "closed";
        await discard(id);
        throw error;
      }
    };
    return {
      append: (pages: () => Prepared) =>
        step(async () => {
          const prepared = pages();
          await transaction((tx) =>
            appendConnectorStagePages(tx, scope, id, prepared, input.signal),
          );
        }),
      commit: async (metadata: unknown) => {
        const stage = await step(() =>
          transaction((tx) =>
            commitConnectorStage(tx, scope, id, metadata, input.signal),
          ),
        );
        state = "closed";
        open.delete(id);
        return stage;
      },
      abort: async () => {
        state = "closed";
        if (open.has(id)) await discard(id);
      },
    };
  };

  const begin = async (value: {
    key: string;
    datasetKey: string;
    schemaVersion: number;
  }): Promise<DatasetStageWriter> => {
    const definition = definitionOf(value.datasetKey, value.schemaVersion);
    const writer = await draft(value.key, definition);
    return {
      append: (pages) => writer.append(() => prepare(pages, definition)),
      commit: ({ metadata }) => writer.commit(metadata),
      abort: writer.abort,
    };
  };

  return {
    get: (key) => transaction((tx) => findConnectorStage(tx, scope, key)),
    getPage: (id, key) =>
      transaction((tx) => readConnectorStagePage(tx, scope, id, key)),
    begin,
    // A convenience over begin/append/commit with the same visibility: the
    // stage is readable only once every page is stored.
    put: async (value) => {
      const first = value.pages[0];
      const definition = definitionOf(first?.datasetKey, first?.schemaVersion);
      const prepared = prepare(value.pages, definition);
      const existing = await transaction((tx) =>
        matchConnectorStage(tx, scope, value, definition),
      );
      if (existing) return existing;
      const writer = await draft(value.key, definition);
      try {
        // Pages go in batches of bounded compressed size, each batch one
        // append transaction.
        let batch: Prepared = [],
          bytes = 0;
        for (const page of prepared) {
          if (
            batch.length &&
            bytes + page.payloadGzip.byteLength > PUT_APPEND_BYTES
          ) {
            const pages = batch;
            await writer.append(() => pages);
            batch = [];
            bytes = 0;
          }
          batch.push(page);
          bytes += page.payloadGzip.byteLength;
        }
        const last = batch;
        await writer.append(() => last);
        return await writer.commit(value.metadata);
      } catch (error) {
        await writer.abort();
        throw error;
      }
    },
  };
}
