import { describe, expect, it } from "vitest";

import {
  can,
  canManageMember,
  type WorkspaceAction,
  type WorkspaceRole,
} from "./authorization.js";

const ALL_ACTIONS: WorkspaceAction[] = [
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

const EXPECTED: Record<WorkspaceRole, Record<WorkspaceAction, boolean>> = {
  owner: {
    "workspace:view": true,
    "workspace:rename": true,
    "members:view": true,
    "members:add": true,
    "members:change-role": true,
    "members:remove": true,
    "projects:view": true,
    "projects:create": true,
    "projects:rename": true,
    "projects:delete": true,
    "audit:view": true,
  },
  admin: {
    "workspace:view": true,
    "workspace:rename": true,
    "members:view": true,
    "members:add": true,
    "members:change-role": true,
    "members:remove": true,
    "projects:view": true,
    "projects:create": true,
    "projects:rename": true,
    "projects:delete": true,
    "audit:view": true,
  },
  editor: {
    "workspace:view": true,
    "workspace:rename": false,
    "members:view": true,
    "members:add": false,
    "members:change-role": false,
    "members:remove": false,
    "projects:view": true,
    "projects:create": true,
    "projects:rename": true,
    "projects:delete": false,
    "audit:view": false,
  },
  viewer: {
    "workspace:view": true,
    "workspace:rename": false,
    "members:view": true,
    "members:add": false,
    "members:change-role": false,
    "members:remove": false,
    "projects:view": true,
    "projects:create": false,
    "projects:rename": false,
    "projects:delete": false,
    "audit:view": false,
  },
};

const ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

describe("can", () => {
  for (const role of ROLES) {
    it(`grants ${role} exactly the documented actions`, () => {
      for (const action of ALL_ACTIONS) {
        expect(can(role, action), `${role} -> ${action}`).toBe(
          EXPECTED[role][action],
        );
      }
    });
  }
});

describe("canManageMember", () => {
  it("denies editors and viewers any member management", () => {
    for (const actorRole of ["editor", "viewer"] as const) {
      for (const targetRole of ROLES) {
        expect(canManageMember(actorRole, targetRole, "add")).toBe(false);
        expect(
          canManageMember(actorRole, targetRole, "change-role", "viewer"),
        ).toBe(false);
        expect(canManageMember(actorRole, targetRole, "remove")).toBe(false);
      }
    }
  });

  it("lets owners manage any member and grant any role", () => {
    for (const targetRole of ROLES) {
      expect(canManageMember("owner", targetRole, "add")).toBe(true);
      expect(canManageMember("owner", targetRole, "change-role", "owner")).toBe(
        true,
      );
      expect(
        canManageMember("owner", targetRole, "change-role", "viewer"),
      ).toBe(true);
      expect(canManageMember("owner", targetRole, "remove")).toBe(true);
    }
  });

  it("lets admins manage admin/editor/viewer members", () => {
    for (const targetRole of ["admin", "editor", "viewer"] as const) {
      expect(canManageMember("admin", targetRole, "add")).toBe(true);
      expect(
        canManageMember("admin", targetRole, "change-role", "editor"),
      ).toBe(true);
      expect(canManageMember("admin", targetRole, "remove")).toBe(true);
    }
  });

  it("forbids admins from touching owners", () => {
    expect(canManageMember("admin", "owner", "change-role", "viewer")).toBe(
      false,
    );
    expect(canManageMember("admin", "owner", "remove")).toBe(false);
  });

  it("forbids admins from granting the owner role", () => {
    expect(canManageMember("admin", "owner", "add")).toBe(false);
    expect(canManageMember("admin", "editor", "change-role", "owner")).toBe(
      false,
    );
  });
});
