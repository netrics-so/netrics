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
  /**
   * The project the dashboard, preparations and models start in (#573);
   * not an archived one.
   */
  projectId: z.uuid().nullable().optional(),
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

/** Added, changed and removed parts of one kind. */
const storeTemplateCountsSchema = z.object({
  added: z.number().int().min(0),
  changed: z.number().int().min(0),
  removed: z.number().int().min(0),
});
/**
 * What a newer template version changes (not the customer's own edits),
 * without app-scope parts; `conflicts` are items both changed, `removals`
 * template parts proposed for removal.
 */
export const storeTemplateUpdateSummarySchema = z.object({
  measures: storeTemplateCountsSchema,
  steps: storeTemplateCountsSchema,
  widgets: storeTemplateCountsSchema,
  conflicts: z.number().int().min(0),
  removals: z.number().int().min(0),
});
export type StoreTemplateUpdateSummary = z.infer<
  typeof storeTemplateUpdateSummarySchema
>;
/** An applied update in progress: its data drafts and dashboard copies. */
export const storeTemplateUpdateSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  createdAt: z.iso.datetime(),
  drafts: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["preparation", "model"]),
      recordId: z.uuid(),
      name: z.string(),
      version: z.number().int(),
      published: z.boolean(),
    }),
  ),
  dashboards: z.array(
    z.object({
      key: z.string(),
      originalId: z.uuid(),
      copyId: z.uuid().nullable(),
      swappedAt: z.iso.datetime().nullable(),
      swappedBackAt: z.iso.datetime().nullable(),
      ready: z.boolean(),
    }),
  ),
});
export type StoreTemplateUpdate = z.infer<typeof storeTemplateUpdateSchema>;
/**
 * Applying an update: the plan's `basis` (the state the customer reviewed)
 * and a choice for every item the plan asks about (`choose`: template or
 * customer; `propose_removal`: remove or keep).
 */
export const storeTemplateApplyRequestSchema = z.strictObject({
  basis: z.string(),
  decisions: z.array(
    z.strictObject({
      ref: z.string(),
      choice: z.enum(["template", "customer", "remove", "keep"]),
    }),
  ),
});
export type StoreTemplateApplyRequest = z.infer<
  typeof storeTemplateApplyRequestSchema
>;
/**
 * `store_update_decision_missing` lists the items still without a choice;
 * `store_update_unmergeable` names the record (`key`) whose merged content
 * cannot be written and, when known, its items.
 */
export const storeTemplateApplyErrorSchema = z.object({
  error: z.string().min(1),
  key: z.string().optional(),
  refs: z.array(z.string()).optional(),
});
/**
 * The workspace's store-template installs and whether a newer template
 * version is available. `summary` is null when the install is up to date
 * or its baseline cannot be read (`error`).
 */
export const storeTemplateInstallListSchema = z.object({
  installs: z.array(
    z.object({
      requestId: z.uuid(),
      name: z.string(),
      templateVersion: z.number().int(),
      latestVersion: z.number().int(),
      updateAvailable: z.boolean(),
      summary: storeTemplateUpdateSummarySchema.nullable(),
      error: z.enum(["store_template_baseline_unavailable"]).nullable(),
      dashboardIds: z.array(z.uuid()),
      modelIds: z.array(z.uuid()),
      preparationIds: z.array(z.uuid()),
      openUpdate: storeTemplateUpdateSchema.nullable(),
    }),
  ),
});
export type StoreTemplateInstallList = z.infer<
  typeof storeTemplateInstallListSchema
>;
/**
 * The three-way plan of an update, per record: each item the template or
 * the customer changed, with its original, current and new value. `basis`
 * identifies the state the plan was made from.
 */
export const storeTemplatePlanSchema = z.object({
  requestId: z.uuid(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  basis: z.string().regex(/^[0-9a-f]{64}$/),
  summary: storeTemplateUpdateSummarySchema,
  records: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["preparation", "model", "dashboard"]),
      /** Null for a record the new version adds. */
      recordId: z.uuid().nullable(),
      name: z.string(),
      hasUnpublishedDraft: z.boolean(),
      items: z.array(
        z.object({
          ref: z.string(),
          change: z.enum(["added", "changed", "removed"]),
          outcome: z.enum([
            "template",
            "customer",
            "choose",
            "propose_removal",
            "scope",
          ]),
          original: z.unknown().optional(),
          current: z.unknown().optional(),
          next: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
export type StoreTemplatePlan = z.infer<typeof storeTemplatePlanSchema>;
