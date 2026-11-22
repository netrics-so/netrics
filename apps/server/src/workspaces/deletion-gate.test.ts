import { describe, expect, it } from "vitest";

import {
  createWorkspaceDeletionGate,
  DELETION_GATE_BUSY,
} from "./deletion-gate.js";

/** A promise settled from outside. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("the workspace deletion gate (#855)", () => {
  it("runs one at a time, in order of arrival", async () => {
    const deletions = createWorkspaceDeletionGate();
    const order: string[] = [];
    const first = gate();
    const second = gate();
    const a = deletions.run(async () => {
      order.push("a starts");
      await first.opened;
      order.push("a ends");
      return "a";
    });
    const b = deletions.run(async () => {
      order.push("b starts");
      await second.opened;
      return "b";
    });
    const c = deletions.run(async () => {
      order.push("c starts");
      return "c";
    });
    expect(deletions.held).toBe(true);
    expect(deletions.waiting).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["a starts"]);
    first.open();
    expect(await a).toBe("a");
    expect(deletions.waiting).toBe(1);
    second.open();
    expect(await b).toBe("b");
    expect(await c).toBe("c");
    expect(order).toEqual(["a starts", "a ends", "b starts", "c starts"]);
    expect(deletions.held).toBe(false);
    expect(deletions.waiting).toBe(0);
  });

  it("is released when the work throws, and when it is refused", async () => {
    const deletions = createWorkspaceDeletionGate();
    await expect(
      deletions.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(deletions.held).toBe(false);
    // A waiter gets the gate from a holder that threw.
    const hold = gate();
    const failing = deletions.run(async () => {
      await hold.opened;
      throw new Error("failed late");
    });
    const next = deletions.run(async () => "next");
    expect(deletions.waiting).toBe(1);
    hold.open();
    await expect(failing).rejects.toThrow("failed late");
    expect(await next).toBe("next");
    expect(deletions.held).toBe(false);
  });

  it("gives up after the budget without running, and leaves the queue", async () => {
    const deletions = createWorkspaceDeletionGate({ budgetMs: 40 });
    const hold = gate();
    const holder = deletions.run(async (deadline) => {
      const granted = deadline.remainingMs();
      await hold.opened;
      return granted;
    });
    let ran = 0;
    const waiters = Array.from({ length: 5 }, () =>
      deletions.run(async () => {
        ran += 1;
      }),
    );
    expect(deletions.waiting).toBe(5);
    expect(await Promise.all(waiters)).toEqual(
      Array.from({ length: 5 }, () => DELETION_GATE_BUSY),
    );
    expect(ran).toBe(0);
    expect(deletions.waiting).toBe(0);
    // The holder still has it, and got the whole budget.
    expect(deletions.held).toBe(true);
    hold.open();
    const granted = (await holder) as number;
    expect(granted).toBeLessThanOrEqual(40);
    expect(granted).toBeGreaterThanOrEqual(30);
    expect(deletions.held).toBe(false);
    expect(await deletions.run(async () => "free again")).toBe("free again");
  });

  it("measures a waiter against the deadline fixed on arrival, not a new one", async () => {
    const deletions = createWorkspaceDeletionGate({ budgetMs: 10_000 });
    const hold = gate();
    const holder = deletions.run(() => hold.opened);
    const waiter = deletions.run(async (deadline) => deadline.remainingMs());
    const started = performance.now();
    // Real time passes while it waits (a timer, not a sleep for a state).
    await new Promise((resolve) => setTimeout(resolve, 60));
    hold.open();
    await holder;
    const remaining = (await waiter) as number;
    const waited = performance.now() - started;
    expect(remaining).toBeLessThanOrEqual(10_000 - 55);
    expect(remaining).toBeGreaterThanOrEqual(Math.floor(10_000 - waited - 20));
  });
});
