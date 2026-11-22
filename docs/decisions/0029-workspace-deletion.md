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

Two deletions by one user each hold only their own workspace's fence, so
the count is serialised by a second advisory lock, on the user, taken before
the fence. Before, because a deletion that waits for it must not hold a
fence, which stalls a workspace. Only `delete_workspace()` takes it, once
per transaction: whoever waits for a user lock holds nothing, and whoever
holds one waits only for a fence, whose other holders never ask for a user
lock. Invitation acceptance and workspace creation do not take it: they
only add memberships, and a deletion that misses one refuses where it could
have passed.

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
- The lock keys are 32-bit hashes: two workspaces (or users) that share one
  only wait for each other's deletion.
