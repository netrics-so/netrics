import type { WorkspaceRole } from "@netrics/contracts";

export type { WorkspaceRole } from "@netrics/contracts";

export type WorkspaceAction =
  | "workspace:view"
  | "workspace:rename"
  | "members:view"
  | "members:add"
  | "members:change-role"
  | "members:remove"
  | "projects:view"
  | "projects:create"
  | "projects:rename"
  | "projects:delete"
  | "audit:view";

const ALL_ACTIONS: readonly WorkspaceAction[] = [
  "workspace:view",
  "workspace:rename",
  "members:view",
  "members:add",
  "members:change-role",
  "members:remove",
  "projects:view",
  "projects:create",
  "projects:rename",
  "projects:delete",
  "audit:view",
];

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<WorkspaceAction>> = {
  owner: new Set(ALL_ACTIONS),
  admin: new Set(ALL_ACTIONS),
  editor: new Set([
    "workspace:view",
    "members:view",
    "projects:view",
    "projects:create",
    "projects:rename",
  ]),
  viewer: new Set(["workspace:view", "members:view", "projects:view"]),
};

export function can(role: WorkspaceRole, action: WorkspaceAction): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

export type MemberManagementAction = "add" | "change-role" | "remove";

/**
 * Rules for managing another member's membership, layered on top of can():
 * - only owners and admins manage members at all;
 * - only an owner may touch an existing owner's membership (change or remove);
 * - only an owner may grant the owner role (on add or role change).
 * For "add", `targetRole` is the role being granted (no membership exists
 * yet); for "change-role", `newRole` is the role being granted.
 * Self-removal (leaving a workspace) is not governed here — any member may
 * remove themselves; the database's last-owner trigger is the backstop.
 */
export function canManageMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  action: MemberManagementAction,
  newRole?: WorkspaceRole,
): boolean {
  if (actorRole !== "owner" && actorRole !== "admin") {
    return false;
  }
  if (action !== "add" && targetRole === "owner" && actorRole !== "owner") {
    return false;
  }
  const grantedRole = action === "add" ? targetRole : newRole;
  if (grantedRole === "owner" && actorRole !== "owner") {
    return false;
  }
  return true;
}
