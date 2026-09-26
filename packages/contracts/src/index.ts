import { z } from "zod";

export const processRoleSchema = z.enum(["api", "worker", "scheduler"]);
export type ProcessRole = z.infer<typeof processRoleSchema>;

export const workspaceRoleSchema = z.enum([
  "owner",
  "admin",
  "editor",
  "viewer",
]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const versionInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1),
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;

export const healthLiveResponseSchema = z
  .object({
    status: z.literal("ok"),
    role: processRoleSchema,
    uptimeSeconds: z.number().nonnegative(),
  })
  .extend(versionInfoSchema.shape);
export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

export const databaseStatusSchema = z.enum(["up", "down"]);
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;

export const healthReadyResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    role: processRoleSchema,
    database: databaseStatusSchema,
    checkedAt: z.iso.datetime(),
  })
  .extend(versionInfoSchema.shape);
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string().min(1),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const bootstrapRequestSchema = z.object({
  workspaceName: z.string().trim().min(1).max(100),
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const bootstrapResponseSchema = z.object({
  workspace: z.object({
    id: z.uuid(),
    name: z.string().min(1),
  }),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string().min(1),
    displayName: z.string().min(1),
  }),
  memberships: z.array(
    z.object({
      workspaceId: z.uuid(),
      workspaceName: z.string().min(1),
      role: workspaceRoleSchema,
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

const nameSchema = z.string().trim().min(1).max(100);

export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceRequestSchema = z.object({ name: nameSchema });
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;

export const renameWorkspaceRequestSchema = z.object({ name: nameSchema });
export type RenameWorkspaceRequest = z.infer<
  typeof renameWorkspaceRequestSchema
>;

export const workspaceResponseSchema = z.object({
  workspace: workspaceSchema,
});
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1),
      role: workspaceRoleSchema,
      activeProjectId: z.uuid().nullable(),
    }),
  ),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  email: z.string().min(1),
  displayName: z.string().min(1),
  role: workspaceRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const memberResponseSchema = z.object({ member: memberSchema });
export type MemberResponse = z.infer<typeof memberResponseSchema>;

export const memberListResponseSchema = z.object({
  members: z.array(memberSchema),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

export const addMemberRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>;

export const updateMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<
  typeof updateMemberRoleRequestSchema
>;

export const setActiveProjectRequestSchema = z.object({
  projectId: z.uuid().nullable(),
});
export type SetActiveProjectRequest = z.infer<
  typeof setActiveProjectRequestSchema
>;

export const activeProjectResponseSchema = z.object({
  activeProjectId: z.uuid().nullable(),
});
export type ActiveProjectResponse = z.infer<typeof activeProjectResponseSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({ name: nameSchema });
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const renameProjectRequestSchema = z.object({ name: nameSchema });
export type RenameProjectRequest = z.infer<typeof renameProjectRequestSchema>;

export const projectResponseSchema = z.object({ project: projectSchema });
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const auditEventSchema = z.object({
  id: z.uuid(),
  action: z.string().min(1),
  actorUserId: z.uuid().nullable(),
  target: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventListResponseSchema = z.object({
  events: z.array(auditEventSchema),
});
export type AuditEventListResponse = z.infer<
  typeof auditEventListResponseSchema
>;
