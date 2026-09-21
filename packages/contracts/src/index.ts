import { z } from "zod";

export const processRoleSchema = z.enum(["api", "worker", "scheduler"]);
export type ProcessRole = z.infer<typeof processRoleSchema>;

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
