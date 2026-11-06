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
  /** Page-session admissions per authenticated caller/release; zero disables pinned paging. */
  queryPageSessionsPerCaller: number | null;
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
  queryPageSessionsPerCaller: 10,
  querySnapshotSeconds: 86_400,
  preparedCacheSeconds: 86_400,
  maxRetentionDays: null,
};
/**
 * Rows one published source generation may hold. Every read of a raw
 * generation (preview, preparation, publication, query) loads at most
 * `queryRows`, so a larger generation could be stored but never used:
 * ingestion rejects it instead. `null` in both removes the bound.
 */
export function datasetGenerationRowLimit(
  policy: Pick<DataPolicy, "maxGenerationRows" | "queryRows">,
): number | null {
  const { maxGenerationRows, queryRows } = policy;
  if (maxGenerationRows === null) return queryRows;
  if (queryRows === null) return maxGenerationRows;
  return Math.min(maxGenerationRows, queryRows);
}
export function exceedsDataPolicy(
  value: number,
  maximum: number | null,
): boolean {
  return maximum !== null && value > maximum;
}
