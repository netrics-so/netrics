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
