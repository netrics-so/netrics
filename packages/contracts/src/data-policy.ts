import { z } from "zod";
import { DEFAULT_DATA_POLICY } from "@netrics/domain";
const ceiling = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const cacheCeiling = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
/** null removes a policy ceiling; omitted keys inherit the instance default. */
export const dataPolicyOverrideSchema = z.strictObject({
  maxWorkspaceBytes: ceiling.optional(),
  maxConnectorStagingBytes: cacheCeiling.optional(),
  maxGenerationRows: ceiling.optional(),
  maxGenerationBytes: ceiling.optional(),
  maxRefreshPages: ceiling.optional(),
  syncPagesPerRun: ceiling.optional(),
  maxSources: ceiling.optional(),
  maxPreparations: ceiling.optional(),
  maxModels: ceiling.optional(),
  maxPreparedBytes: ceiling.optional(),
  maxPreparedGenerationBytes: ceiling.optional(),
  queryRows: ceiling.optional(),
  queryOperations: ceiling.optional(),
  queryOutputBytes: ceiling.optional(),
  queryTimeoutMs: ceiling.optional(),
  querySnapshotCount: cacheCeiling.optional(),
  queryPageSessionsPerCaller: cacheCeiling.optional(),
  querySnapshotSeconds: cacheCeiling.optional(),
  preparedCacheSeconds: ceiling.optional(),
  maxRetentionDays: ceiling.optional(),
});
export const dataPolicySchema = dataPolicyOverrideSchema.required();
export const dataPolicyResponseSchema = z.object({
  policy: dataPolicySchema,
  overrides: dataPolicyOverrideSchema,
});
export function parseDataPolicyDefaults(input: unknown = {}) {
  return { ...DEFAULT_DATA_POLICY, ...dataPolicyOverrideSchema.parse(input) };
}
