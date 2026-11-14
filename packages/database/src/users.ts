import { and, eq } from "drizzle-orm";

import type { Db } from "./context.js";
import { withUserContext, withWorkspace } from "./context.js";
import * as schema from "./schema.js";

export type DomainUser = typeof schema.users.$inferSelect;

/** Looks up the installation-level domain user for a better-auth user id. */
export async function findUserByAuthUserId(
  db: Db,
  authUserId: string,
): Promise<DomainUser | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.authUserId, authUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(
  db: Db,
  userId: string,
): Promise<DomainUser | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Looks up an installation-level domain user by (unique) email. */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<DomainUser | null> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserts the domain user mirroring a freshly created auth user
 * (installation-level table, no tenant context needed). Idempotent: a
 * conflict on auth_user_id or email simply falls through to the select.
 */
export async function provisionDomainUser(
  db: Db,
  input: {
    authUserId: string;
    email: string;
    name?: string | null;
    /** The language the account was created in (ADR 0016). */
    locale?: string | null;
  },
): Promise<DomainUser> {
  const email = input.email.toLowerCase();
  const displayName = input.name?.trim() || email.split("@")[0] || email;
  await db
    .insert(schema.users)
    .values({
      authUserId: input.authUserId,
      email,
      displayName,
      locale: input.locale ?? null,
    })
    .onConflictDoNothing();
  const user = await findUserByAuthUserId(db, input.authUserId);
  if (!user) {
    throw new Error(
      `failed to provision domain user for auth user ${input.authUserId}`,
    );
  }
  return user;
}

/**
 * Sets a user's own language (null: follow the instance default and the
 * browser). Installation-level row, so the caller must pass the
 * authenticated user's id; nothing else is written.
 */
export async function setUserLocale(
  db: Db,
  userId: string,
  locale: string | null,
): Promise<DomainUser | null> {
  const rows = await db
    .update(schema.users)
    .set({ locale })
    .where(eq(schema.users.id, userId))
    .returning();
  return rows[0] ?? null;
}

export interface MembershipInfo {
  workspaceId: string;
  workspaceName: string;
  role: string;
  /**
   * The effective active project: the stored one, or null ("All") while the
   * stored project is archived. The stored choice is kept, so unarchiving
   * the project brings it back.
   */
  activeProjectId: string | null;
}

/**
 * Lists a user's memberships for workspace discovery (pre-tenant). The
 * membership rows are visible under a user-only context, but workspace names
 * are not (workspaces_select requires the workspace context), so each name is
 * fetched inside its own workspace context.
 */
export async function listMembershipsForUser(
  db: Db,
  userId: string,
): Promise<MembershipInfo[]> {
  const memberships = await withUserContext(db, { userId }, (tx) =>
    tx
      .select({
        workspaceId: schema.memberships.workspaceId,
        role: schema.memberships.role,
        activeProjectId: schema.memberships.activeProjectId,
      })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, userId)),
  );
  const result: MembershipInfo[] = [];
  for (const membership of memberships) {
    const resolved = await withWorkspace(
      db,
      { workspaceId: membership.workspaceId, userId },
      async (tx) => {
        const rows = await tx
          .select({ name: schema.workspaces.name })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, membership.workspaceId));
        const workspaceName = rows[0]?.name;
        if (workspaceName === undefined || membership.activeProjectId === null)
          return { workspaceName, activeProjectId: null };
        const projects = await tx
          .select({ archivedAt: schema.projects.archivedAt })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, membership.activeProjectId),
              eq(schema.projects.workspaceId, membership.workspaceId),
            ),
          );
        const project = projects[0];
        return {
          workspaceName,
          activeProjectId:
            project === undefined || project.archivedAt !== null
              ? null
              : membership.activeProjectId,
        };
      },
    );
    if (resolved.workspaceName !== undefined) {
      result.push({
        ...membership,
        workspaceName: resolved.workspaceName,
        activeProjectId: resolved.activeProjectId,
      });
    }
  }
  return result;
}
