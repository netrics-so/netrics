// One workspace deletion at a time per API process (#855).
//
// delete_workspace() puts all deletions of the installation in one order
// with an advisory lock (migration 0095). A deletion that waits there, or
// for work in its workspace, holds a database connection while it waits.
// Without this gate a burst of deletion requests would each take a
// connection from the API's pool and wait on it, and requests that have
// nothing to do with a deletion would wait for a free connection.
//
// So a deletion request takes this gate BEFORE it opens its transaction: at
// most one connection per API process ever waits for a deletion. Waiting
// here holds nothing but a timer. The database lock stays what makes
// deletions of several processes (and of anything else that calls the
// function) take turns.
//
// A request waits at most `budgetMs` in total: what is left when it gets
// the gate is the time its database waits may take (deleteWorkspace's
// `waitMs`), so the gate adds nothing to the 10 seconds a deletion may wait.
// A request that does not get the gate in time is told so and never takes a
// connection. That timeout is also what bounds the queue: nobody waits
// longer than the budget, whatever the holder does, and the holder's own
// waits end within its budget.

/** How long a deletion may wait in all: the gate, then the database. */
export const WORKSPACE_DELETION_BUDGET_MS = 10_000;

/** The gate was not free within the budget. */
export const DELETION_GATE_BUSY = Symbol("deletion gate busy");

export interface WorkspaceDeletionGate {
  /**
   * Runs `work` alone, with the milliseconds left of the budget, or answers
   * DELETION_GATE_BUSY without running it. The gate is released when `work`
   * settles, also when it throws.
   */
  run<T>(
    work: (remainingMs: number) => Promise<T>,
  ): Promise<T | typeof DELETION_GATE_BUSY>;
  /** Requests waiting for the gate (tests). */
  readonly waiting: number;
  /** Whether a request holds the gate (tests). */
  readonly held: boolean;
}

export function createWorkspaceDeletionGate(
  options: { budgetMs?: number } = {},
): WorkspaceDeletionGate {
  const budgetMs = options.budgetMs ?? WORKSPACE_DELETION_BUDGET_MS;
  let held = false;
  // In order of arrival; each entry hands the gate to its request.
  const queue: Array<() => void> = [];

  /** Resolves true with the gate held, false when the budget ran out. */
  function acquire(): Promise<boolean> {
    if (!held) {
      held = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = queue.indexOf(grant);
        if (at >= 0) queue.splice(at, 1);
        resolve(false);
      }, budgetMs);
      queue.push(grant);
    });
  }

  function release(): void {
    const next = queue.shift();
    // Handed over while held: no request can slip in between.
    if (next) next();
    else held = false;
  }

  return {
    async run(work) {
      const started = performance.now();
      if (!(await acquire())) return DELETION_GATE_BUSY;
      try {
        const remaining = Math.floor(budgetMs - (performance.now() - started));
        // Granted in the budget's last instant: no time for the database.
        if (remaining < 1) return DELETION_GATE_BUSY;
        return await work(remaining);
      } finally {
        release();
      }
    },
    get waiting() {
      return queue.length;
    },
    get held() {
      return held;
    },
  };
}
