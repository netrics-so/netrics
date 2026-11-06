import type {
  ConnectorDatasetStaging,
  ConnectorManifest,
} from "@netrics/connector-sdk";
import {
  DatasetStoreError,
  DatasetStageUnavailableError,
  findConnectorStage,
  readConnectorStagePage,
  storeConnectorStage,
  withWorkspace,
  type Db,
  type Transaction,
} from "@netrics/database";
import { ContractViolationError } from "@netrics/connector-runtime";
import type { DataPolicy } from "@netrics/domain";

/** Host binds scope once; connector-controlled keys never choose another tenant. */
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
      if (
        error instanceof DatasetStoreError &&
        !(error instanceof DatasetStageUnavailableError)
      )
        throw new ContractViolationError(error.code);
      throw error;
    }
  };
  return {
    get: (key) => transaction((tx) => findConnectorStage(tx, scope, key)),
    getPage: (id, key) =>
      transaction((tx) => readConnectorStagePage(tx, scope, id, key)),
    put: (value) =>
      transaction((tx) => {
        const definition = input.manifest.datasets?.find(
          (d) =>
            d.key === value.pages[0]?.datasetKey &&
            d.version === value.pages[0]?.schemaVersion,
        );
        if (!definition) throw new Error("Undeclared staged source dataset");
        return storeConnectorStage(tx, scope, value, definition, input.signal);
      }),
  };
}
