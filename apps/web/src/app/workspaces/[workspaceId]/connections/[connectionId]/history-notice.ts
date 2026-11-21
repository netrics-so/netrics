import type { ConnectionHistory } from "@netrics/contracts";

/** The message of the history note, under `connections.history`. */
export type HistoryNotice =
  "loading" | "failed" | "failedReadOnly" | "incomplete" | "incompleteReadOnly";

/**
 * The note about a connection's history on its page, if any:
 *
 * - a backfill waits or runs (#617): still loading;
 * - the last backfill ended without reading its window (#787), e.g. with
 *   its retries used up: incomplete, whatever the connector stores;
 * - datasets no backfill has read yet (added by a connector update): they
 *   hold partial history.
 *
 * `canReload`: the reader may use "Reload history", so the note points to it.
 */
export function historyNotice(
  history: ConnectionHistory,
  options: { setupPending: boolean; canReload: boolean },
): HistoryNotice | null {
  if (options.setupPending) {
    return history.incompleteDatasets.length > 0
      ? options.canReload
        ? "incomplete"
        : "incompleteReadOnly"
      : null;
  }
  if (history.backfill !== "idle") return "loading";
  if (history.backfillFailed) {
    return options.canReload ? "failed" : "failedReadOnly";
  }
  if (history.incompleteDatasets.length > 0) {
    return options.canReload ? "incomplete" : "incompleteReadOnly";
  }
  return null;
}
