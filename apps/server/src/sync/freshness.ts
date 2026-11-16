import { ContractViolationError } from "@netrics/connector-runtime";
import type {
  ConnectorManifest,
  FreshnessEntry,
  FreshnessStream,
} from "@netrics/connector-sdk";
import {
  listConnectionFreshness,
  recordConnectionFreshness,
  type ConnectionFreshnessRow,
  type Transaction,
} from "@netrics/database";
import { nextDueAfterSuccess } from "@netrics/domain";

/**
 * The resources a sync collects (the request's `resources`): the stored
 * selection, under a reserved config key. Undefined means every resource.
 * An explicit empty selection pauses collection, but only for a connector
 * that honors a selection; for others it means every resource.
 */
export function selectedResourcesOf(
  config: Record<string, unknown>,
  manifest: Pick<ConnectorManifest, "supportsResourceSelection">,
): string[] | undefined {
  const raw = config.resourceSelection;
  return Array.isArray(raw) &&
    (raw.length > 0 || manifest.supportsResourceSelection === true) &&
    raw.every((entry) => typeof entry === "string" && entry !== "")
    ? (raw as string[])
    : undefined;
}

/**
 * The stored rows that count (ADR 0025 §4): rows of streams the manifest
 * still declares, and of the connection entry or a selected resource
 * (every resource when none is selected). The rest is ignored on read.
 */
export function relevantFreshnessRows(
  rows: readonly ConnectionFreshnessRow[],
  streams: readonly FreshnessStream[] | undefined,
  selectedResources: readonly string[] | undefined,
): { row: ConnectionFreshnessRow; stream: FreshnessStream }[] {
  const declared = new Map((streams ?? []).map((s) => [s.key, s]));
  const selected = selectedResources ? new Set(selectedResources) : null;
  return rows.flatMap((row) => {
    const stream = declared.get(row.stream);
    if (!stream) return [];
    if (row.resource !== "" && selected && !selected.has(row.resource))
      return [];
    return [{ row, stream }];
  });
}

/**
 * Stores a succeeded run's freshness entries (ADR 0025 §4) in its final
 * transaction and returns the connection's next due time (§5): from the
 * stored rows of its periodic streams, else exactly now + interval.
 */
export async function recordFreshness(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    manifest: Pick<ConnectorManifest, "freshnessStreams">;
    entries: readonly FreshnessEntry[];
    selectedResources: readonly string[] | undefined;
    pollIntervalSeconds: number;
    now: Date;
  },
): Promise<Date> {
  const streams = input.manifest.freshnessStreams ?? [];
  const interval = {
    now: input.now,
    intervalSeconds: input.pollIntervalSeconds,
  };
  if (streams.length === 0) {
    // A connector without streams (SDK 0.2.12 and earlier) has no rows
    // that count, and runtime validation refused any entries it sent.
    return nextDueAfterSuccess({ ...interval, rows: [] });
  }
  if (input.entries.length > 0) {
    const declared = new Map(streams.map((s) => [s.key, s]));
    await recordConnectionFreshness(tx, {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      checkedAt: input.now,
      entries: input.entries.map((entry) => {
        const stream = declared.get(entry.stream);
        // The runtime validated the entries against the same manifest.
        if (!stream)
          throw new ContractViolationError(
            `undeclared freshness stream "${entry.stream}"`,
          );
        const dataThrough =
          stream.kind === "periodic" ? (entry.dataThrough ?? null) : null;
        return {
          stream: entry.stream,
          resource: entry.resource ?? "",
          dataThrough,
          timeZone:
            dataThrough === null
              ? null
              : (entry.timeZone ?? stream.timeZone ?? null),
          expectedFrom:
            stream.kind === "periodic" && entry.expectedFrom
              ? new Date(entry.expectedFrom)
              : null,
          nextExpectedAt:
            stream.kind === "periodic" && entry.nextExpectedAt
              ? new Date(entry.nextExpectedAt)
              : null,
        };
      }),
    });
  }
  const rows = relevantFreshnessRows(
    await listConnectionFreshness(tx, input.workspaceId, input.connectionId),
    streams,
    input.selectedResources,
  );
  return nextDueAfterSuccess({
    ...interval,
    rows: rows
      .filter(({ stream }) => stream.kind === "periodic")
      .map(({ row }) => ({
        expectedFrom: row.expectedFrom,
        nextExpectedAt: row.nextExpectedAt,
      })),
  });
}
