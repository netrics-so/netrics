# 0029 — Workspace deletion: two steps behind a fence on every tenant transaction

Status: accepted (2026-11-22; [#839](https://github.com/netrics-so/netrics/issues/839),
[#855](https://github.com/netrics-so/netrics/issues/855)).

## Context

An owner deletes a workspace. Access has to end at once and for everyone,
but the data cannot go in the same request: a workspace can hold millions of
rows, and OAuth grants are revoked with calls to providers, which do not
belong in a transaction. Meanwhile requests, jobs, the scheduler's tick and
screens act for the workspace, and none of them may write after the
deletion what it decided before it (an invitation, a membership, a job, a
token).

## Decision

### 1. Two steps

`delete_workspace()` (migrations 0094, 0095) ends every way into the
workspace in one transaction: it marks the workspace deleted
(`workspaces.deleted_at`), removes memberships and invitations, revokes
screens and their tokens, ends waiting and running jobs, clears the sync
schedule, and queues a `workspace.purge` job. The request answers after
that. The job removes the data in small transactions that only delete, so it
can be repeated and resumes after a crash: connections one by one through
the code of "Delete connection" (which revokes OAuth grants), then the
larger tables, then the workspace row, whose foreign keys cascade to the
rest. The scheduler queues a new purge for a deleted workspace that has
none. There is no way back from the first step.

### 2. The fence

Every tenant transaction (`withWorkspace`, by default) and every
`SECURITY DEFINER` function that acts for a workspace outside one calls
`workspace_fence()` before anything else for that workspace: a
transaction-level advisory lock in shared mode, then the workspace's state.
`delete_workspace()` takes the same lock exclusively, waiting at most 10
seconds (then 409 `workspace_busy`, nothing deleted). So work either holds
the fence first, and the deletion waits for its commit and removes what it
wrote, or it gets the fence afterwards and finds the workspace deleted.

- Shared holders do not block each other, and the lock writes nothing and
  works in read-only transactions. A row lock on the workspace row was
  rejected: it writes to that row on every request.
- Both sides take the fence as their first lock for the workspace, so they
  cannot deadlock.
- Repeatable-read and serializable transactions read the state from their
  snapshot, which may be older than a deletion they waited for; they also
  lock the workspace row `FOR SHARE`, which fails on a changed row.
- Triggers refuse new memberships, invitations, connections, screens,
  pairings, tokens, OAuth flows and jobs for a deleted workspace (SQLSTATE
  `WS001`): the backstop for a path that forgot the fence.

### 3. One answer

Work for a deleted workspace, and for one that is purged, fails with
`WorkspaceDeletedError` / `WS001`: 404 `workspace_not_found` in the API, 401
for a screen, a job ends without retries. A `catch` in `apps/server` that
turns unknown errors into something else starts with
`rethrowWorkspaceGone(error)`; `workspace-gone-catches.test.ts` finds those
that do not.

### 4. An owner's only workspace stays

`delete_workspace()` refuses (SQLSTATE `WS002`, 409 `workspace_last`) when
the deleting owner is a member, in any role, of no other workspace that is
not deleted. Only the deleting owner counts: other members may be left
without a workspace and are offered to create one.

Two deletions can each rely on the workspace the other one deletes: one
user deleting their last two workspaces at once, or two co-owners of the
same two workspaces each deleting a different one. Each holds only its own
workspace's fence and would count the other workspace as live. So all
deletions of the installation run in one order: a second advisory lock with
a fixed key, taken before the fence. The second deletion waits, then counts
what the first left, and the outcome is always one the deletions could have
produced one after the other.

- One lock, not one per user: a deletion changes the eligibility of every
  member of its workspace, and deletions are rare and short. The price is
  that they do not run side by side; one that waits for work in its
  workspace holds the others up until its deadline (below) at most.
- Before the fence, because a deletion that waits for the lock must not hold
  an exclusive fence, which stalls a workspace.
- No deadlock: only `delete_workspace()` takes it, once per transaction,
  before any other lock. Whoever waits for it holds nothing; whoever holds
  it stands where a deletion stood before (waiting for its fence, then
  working under it), and nothing it can wait for ever asks for this lock.
- Invitation acceptance and workspace creation do not take it: they only
  add memberships, and a deletion that misses one refuses where it could
  have passed.
- A deletion that waits in the database holds a connection. So the API
  queues deletion requests in its own process before it opens a
  transaction (`apps/server/src/workspaces/deletion-gate.ts`): one deletion
  at a time per process, in order of arrival, and a burst keeps at most one
  connection of a process's pool waiting. The gate is an economy, not the
  guarantee: the database lock is what orders deletions of several API
  processes.
- **One deadline.** A deletion request has one instant, 10 seconds after it
  reaches the gate, and everything it waits for is measured against that
  instant instead of getting time of its own: the gate, a free connection
  (the pool has no limit on that wait, so the request is answered at the
  deadline and its transaction, when it gets a connection, does nothing),
  and in `delete_workspace()` every lock: the deletion lock, the fence, and
  the row locks of each statement, for example a job a worker is finishing.
  The function is told what is left (`app.workspace_delete_wait_ms`, which
  can only shorten its own 10 seconds) and sets `lock_timeout` from the
  remaining time before each statement that can wait; the API also sets
  `statement_timeout` for the call, because a statement that works rather
  than waits cannot be bounded from inside it. When the deadline passes the
  answer is `workspace_busy` and nothing is deleted, then or later; in
  particular no deletion holds the deletion lock past its deadline. The
  deadline is also what bounds the gate's queue; there is no limit on its
  length.
- Removing a member is not ordered with deletions. An owner who is removed
  from their other workspace while they delete this one can be left without
  a workspace. Not covered.

### 5. What is recorded

Two installation-level audit events (`workspace_id` NULL, invisible to
tenants, kept and pruned like all audit events): `workspace.deleted` with
the actor, the workspace's id, name and counts, and `workspace.purged`. The
workspace's own audit events go with it.

## Consequences

- New code that acts for a workspace goes through `withWorkspace` or takes
  the fence itself; a new table with `workspace_id` needs a cascade from
  `workspaces` (a test checks). Removing the fence later would mean proving
  every such path safe again, which is why this is written down.
- Every tenant transaction makes one more function call, in the statement
  that already sets its context.
- A deleted workspace cannot be restored by the application. Backups are not
  rewritten.
- The fence's key is a 32-bit hash of the workspace id: two workspaces that
  share one only wait for each other's deletion.
