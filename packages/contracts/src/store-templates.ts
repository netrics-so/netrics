import { z } from "zod";
const app = z.strictObject({
  connectionId: z.uuid(),
  appId: z.string().trim().min(1).max(65536),
});
export const storeTemplateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  connections: z.array(z.uuid()).min(1),
  groups: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().trim().min(1).max(100),
        apps: z.array(app).min(1),
      }),
    )
    .default([]),
  appScope: app.optional(),
});
export type StoreTemplateRequest = z.infer<typeof storeTemplateRequestSchema>;
export const storeTemplateResultSchema = z.object({
  dashboardId: z.uuid(),
  mappingDatasetId: z.uuid(),
  productDatasetId: z.uuid(),
  models: z.object({
    downloads: z.uuid(),
    proceeds: z.uuid(),
    ratings: z.uuid(),
  }),
  preparationIds: z.array(z.uuid()),
});
export type StoreTemplateResult = z.infer<typeof storeTemplateResultSchema>;
export const storeTemplateOptionsSchema = z.object({
  connections: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      connectorId: z.enum(["app-store-connect", "google-play"]),
      setupPending: z.boolean(),
      apps: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
export type StoreTemplateOptions = z.infer<typeof storeTemplateOptionsSchema>;
