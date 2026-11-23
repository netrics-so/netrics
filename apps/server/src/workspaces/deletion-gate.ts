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
// A request has ONE deadline, an instant fixed when it arrives at the gate:
// `budgetMs` later. The gate and the wait for a pooled connection are given
// up at that instant, and delete_workspace() starts nothing after it (see
// deleteWithinDeadline in routes/workspaces.ts and migration 0095 for what
// exactly is guaranteed). A request that does not get the gate by its
// deadline is told so and takes no connection for the deletion. The
// deadline is also what bounds the queue: nobody waits here longer. The
// gate itself is held until the holder's work settles, which can be after
// the holder's deadline (its transaction still waiting for a connection).

/** From reaching the gate to the deadline of a deletion request. */
export const WORKSPACE_DELETION_BUDGET_MS = 10_000;

/** The gate was not free within the budget. */
export const DELETION_GATE_BUSY = Symbol("deletion gate busy");

/** The instant by which a deletion request must have started deleting. */
export interface DeletionDeadline {
  /** Whole milliseconds left; 0 or less once it has passed. */
  remainingMs(): number;
}

export interface WorkspaceDeletionGate {
  /**
   * Runs `work` alone, with the request's deadline, or answers
   * DELETION_GATE_BUSY without running it when the gate is not free by
   * then. The gate is released when `work` settles, also when it throws.
   */
  run<T>(
    work: (deadline: DeletionDeadline) => Promise<T>,
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

  /** Resolves true with the gate held, false when the deadline passed. */
  function acquire(deadline: DeletionDeadline): Promise<boolean> {
    if (!held) {
      held = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          const at = queue.indexOf(grant);
          if (at >= 0) queue.splice(at, 1);
          resolve(false);
        },
        Math.max(0, deadline.remainingMs()),
      );
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
      const at = performance.now() + budgetMs;
      const deadline: DeletionDeadline = {
        remainingMs: () => Math.floor(at - performance.now()),
      };
      if (!(await acquire(deadline))) return DELETION_GATE_BUSY;
      try {
        // Granted in the last instant: no time left for anything.
        if (deadline.remainingMs() < 1) return DELETION_GATE_BUSY;
        return await work(deadline);
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
