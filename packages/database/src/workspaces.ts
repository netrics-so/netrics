import { and, desc, eq } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import { createWorkspaceInTransaction } from "./context.js";
import * as schema from "./schema.js";

export type Membership = typeof schema.memberships.$inferSelect;
export type Project = typeof schema.projects.$inferSelect;
export type Workspace = typeof schema.workspaces.$inferSelect;
export type AuditEvent = typeof schema.auditEvents.$inferSelect;

export interface AuditEventInput {
  workspaceId: string | null;
  actorUserId: string | null;
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit event inside an existing transaction, so the audit row is
 * atomic with the mutation it records.
 */
export async function insertAuditEvent(
  tx: Transaction,
  event: AuditEventInput,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    workspaceId: event.workspaceId,
    actorUserId: event.actorUserId,
    action: event.action,
    target: event.target ?? "",
    metadata: event.metadata ?? {},
  });
}

/**
 * Appends an installation-level audit event (workspace_id NULL, e.g.
 * auth.login). The audit_events INSERT policy has no tenant requirement, so
 * no context is needed.
 */
export async function insertInstallationAuditEvent(
  db: Db,
  event: Omit<AuditEventInput, "workspaceId">,
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    workspaceId: null,
    actorUserId: event.actorUserId,
    action: event.action,
    target: event.target ?? "",
    metadata: event.metadata ?? {},
  });
}

/**
 * Creates a workspace with `ownerUserId` as owner and records
 * workspace.created, all in one transaction (create_workspace() adopts the
 * new workspace as the transaction's tenant context).
 */
export async function createWorkspaceWithOwner(
  db: Db,
  input: { name: string; ownerUserId: string },
): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const workspaceId = await createWorkspaceInTransaction(tx, input);
    await insertAuditEvent(tx, {
      workspaceId,
      actorUserId: input.ownerUserId,
      action: "workspace.created",
      target: workspaceId,
      metadata: { name: input.name },
    });
    const workspace = await findWorkspace(tx, workspaceId);
    if (!workspace) {
      throw new Error("create_workspace left no readable workspace row");
    }
    return workspace;
  });
}

export async function findWorkspace(
  tx: Transaction,
  workspaceId: string,
): Promise<Workspace | null> {
  const rows = await tx
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function renameWorkspace(
  tx: Transaction,
  workspaceId: string,
  name: string,
): Promise<Workspace | null> {
  const rows = await tx
    .update(schema.workspaces)
    .set({ name })
    .where(eq(schema.workspaces.id, workspaceId))
    .returning();
  return rows[0] ?? null;
}

export async function findMembership(
  tx: Transaction,
  workspaceId: string,
  userId: string,
): Promise<Membership | null> {
  const rows = await tx
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.workspaceId, workspaceId),
        eq(schema.memberships.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface MemberDetails {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: Date;
}

/**
 * Lists members with their installation-level user details. Runs inside a
 * workspace context; users has no RLS, so the join is tenant-safe (only
 * members of the current workspace are returned).
 */
export async function listMembers(
  tx: Transaction,
  workspaceId: string,
): Promise<MemberDetails[]> {
  return tx
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.memberships.role,
      createdAt: schema.memberships.createdAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, workspaceId));
}

export async function addMembership(
  tx: Transaction,
  input: { workspaceId: string; userId: string; role: string },
): Promise<Membership> {
  const rows = await tx
    .insert(schema.memberships)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("membership insert returned no row");
  }
  return row;
}

export async function updateMembershipRole(
  tx: Transaction,
  input: { workspaceId: string; userId: string; role: string },
): Promise<Membership | null> {
  const rows = await tx
    .update(schema.memberships)
    .set({ role: input.role })
    .where(
      and(
        eq(schema.memberships.workspaceId, input.workspaceId),
        eq(schema.memberships.userId, input.userId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function deleteMembership(
  tx: Transaction,
  input: { workspaceId: string; userId: string },
): Promise<boolean> {
  const rows = await tx
    .delete(schema.memberships)
    .where(
      and(
        eq(schema.memberships.workspaceId, input.workspaceId),
        eq(schema.memberships.userId, input.userId),
      ),
    )
    .returning({ id: schema.memberships.id });
  return rows.length > 0;
}

export async function setActiveProject(
  tx: Transaction,
  input: { workspaceId: string; userId: string; projectId: string | null },
): Promise<void> {
  await tx
    .update(schema.memberships)
    .set({ activeProjectId: input.projectId })
    .where(
      and(
        eq(schema.memberships.workspaceId, input.workspaceId),
        eq(schema.memberships.userId, input.userId),
      ),
    );
}

export async function createProject(
  tx: Transaction,
  input: { workspaceId: string; name: string },
): Promise<Project> {
  const rows = await tx
    .insert(schema.projects)
    .values({ workspaceId: input.workspaceId, name: input.name })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("project insert returned no row");
  }
  return row;
}

export async function listProjects(
  tx: Transaction,
  workspaceId: string,
): Promise<Project[]> {
  return tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.workspaceId, workspaceId))
    .orderBy(schema.projects.createdAt);
}

export async function findProject(
  tx: Transaction,
  workspaceId: string,
  projectId: string,
): Promise<Project | null> {
  const rows = await tx
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function renameProject(
  tx: Transaction,
  input: { workspaceId: string; projectId: string; name: string },
): Promise<Project | null> {
  const rows = await tx
    .update(schema.projects)
    .set({ name: input.name })
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function deleteProject(
  tx: Transaction,
  input: { workspaceId: string; projectId: string },
): Promise<boolean> {
  const rows = await tx
    .delete(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: schema.projects.id });
  return rows.length > 0;
}

export async function listAuditEvents(
  tx: Transaction,
  workspaceId: string,
  limit = 100,
): Promise<AuditEvent[]> {
  return tx
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.workspaceId, workspaceId))
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(limit);
}
