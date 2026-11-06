/** Product quotas are deployment/tier policy, separate from bounded wire formats. */
export interface DataPolicy {
  /** Retained raw dataset pages and records; execution caches have separate budgets. */
  maxWorkspaceBytes: number | null;
  /** Live connector staging per workspace; zero refuses new cache admissions. */
  maxConnectorStagingBytes: number | null;
  maxGenerationRows: number | null;
  maxGenerationBytes: number | null;
  maxRefreshPages: number | null;
  syncPagesPerRun: number | null;
  maxSources: number | null;
  maxPreparations: number | null;
  maxModels: number | null;
  maxPreparedBytes: number | null;
  maxPreparedGenerationBytes: number | null;
  queryRows: number | null;
  queryOperations: number | null;
  queryOutputBytes: number | null;
  queryTimeoutMs: number | null;
  querySnapshotCount: number | null;
  querySnapshotSeconds: number | null;
  preparedCacheSeconds: number | null;
  /** Optional tier ceiling; a source may request shorter retention. */
  maxRetentionDays: number | null;
}
export const DEFAULT_DATA_POLICY: Readonly<DataPolicy> = {
  maxWorkspaceBytes: null,
  maxConnectorStagingBytes: 134_217_728,
  maxGenerationRows: null,
  maxGenerationBytes: null,
  maxRefreshPages: null,
  syncPagesPerRun: 100,
  maxSources: null,
  maxPreparations: null,
  maxModels: null,
  maxPreparedBytes: null,
  maxPreparedGenerationBytes: null,
  queryRows: 100_000,
  queryOperations: 5_000_000,
  queryOutputBytes: 134_217_728,
  queryTimeoutMs: 15_000,
  querySnapshotCount: 100,
  querySnapshotSeconds: 86_400,
  preparedCacheSeconds: 86_400,
  maxRetentionDays: null,
};
export function exceedsDataPolicy(
  value: number,
  maximum: number | null,
): boolean {
  return maximum !== null && value > maximum;
}
