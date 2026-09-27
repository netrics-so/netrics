import { z } from "zod";

const opaqueRecordSchema = z.record(z.string(), z.unknown());

export const connectionContextSchema = z.object({
  connectionId: z.string().min(1),
  config: opaqueRecordSchema,
  credentials: opaqueRecordSchema,
});
export type ConnectionContext = z.infer<typeof connectionContextSchema>;

export const checkResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().min(1).optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const resourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  metadata: opaqueRecordSchema.optional(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const syncModeSchema = z.enum(["backfill", "incremental"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

export const syncRequestSchema = z
  .object({
    mode: syncModeSchema,
    from: z.iso.datetime({ offset: false }),
    to: z.iso.datetime({ offset: false }),
    cursor: z.string().min(1).optional(),
    resources: z.array(z.string().min(1)).optional(),
  })
  .refine((request) => request.from < request.to, {
    message: "from must be before to",
  });
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const observationSchema = z.object({
  metricKey: z.string().min(1),
  sourceTimestamp: z.iso.datetime({ offset: false }),
  value: z.number().finite(),
  dimensions: z.record(z.string(), z.string()),
  sourceIdentity: z.string().min(1),
});
export type Observation = z.infer<typeof observationSchema>;

export const syncResultSchema = z.object({
  observations: z.array(observationSchema),
  nextCursor: z.string().min(1).optional(),
  done: z.boolean(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;
