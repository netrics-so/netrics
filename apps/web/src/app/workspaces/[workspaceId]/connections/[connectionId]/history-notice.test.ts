import { describe, expect, it } from "vitest";

import type { ConnectionHistory } from "@netrics/contracts";

import { historyNotice } from "./history-notice";
import { de } from "@/messages/de";
import { en } from "@/messages/en";

// The history note on the connection page (#617, #787).

function history(
  overrides: Partial<ConnectionHistory> = {},
): ConnectionHistory {
  return {
    supportsBackfill: true,
    backfillDays: 365,
    backfill: "idle",
    backfillFailed: false,
    incompleteDatasets: [],
    reloadAvailableAt: null,
    ...overrides,
  };
}

const member = { setupPending: false, canReload: true };
const viewer = { setupPending: false, canReload: false };
const sales = [{ key: "sales", name: "Sales" }];

describe("the history note", () => {
  it("says nothing about a complete history", () => {
    expect(historyNotice(history(), member)).toBeNull();
    // A server from before #787 does not send backfillFailed.
    const { backfillFailed: _, ...older } = history();
    expect(historyNotice(older, member)).toBeNull();
  });

  it("says the history is loading while a backfill waits or runs", () => {
    for (const backfill of ["queued", "running"] as const) {
      expect(historyNotice(history({ backfill }), member)).toBe("loading");
    }
  });

  it("says the history is incomplete after a backfill that did not finish (#787)", () => {
    // A connector without datasets has nothing else to name.
    const dead = history({ backfillFailed: true });
    expect(historyNotice(dead, member)).toBe("failed");
    // Without the right to reload, the note does not point to it.
    expect(historyNotice(dead, viewer)).toBe("failedReadOnly");
    // The datasets of a failed backfill were not "added by an update".
    expect(
      historyNotice(
        history({ backfillFailed: true, incompleteDatasets: sales }),
        member,
      ),
    ).toBe("failed");
  });

  it("names datasets no backfill has read yet", () => {
    const partial = history({ incompleteDatasets: sales });
    expect(historyNotice(partial, member)).toBe("incomplete");
    expect(historyNotice(partial, viewer)).toBe("incompleteReadOnly");
  });

  it("has every note in English and German, the reload only where it can be used", () => {
    for (const catalog of [en, de]) {
      const text = catalog.connections.history;
      // The same note, plus the pointer to "Reload history".
      expect(text.failed.startsWith(text.failedReadOnly)).toBe(true);
      expect(text.failed.length).toBeGreaterThan(text.failedReadOnly.length);
    }
    expect(de.connections.history.failed).not.toBe(
      en.connections.history.failed,
    );
  });
});
