import { z } from "zod";
import { workspaceImageSchema } from "./images.js";
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
  /**
   * The apps without a slide of their own (#709): a dashboard has at most
   * 12 slides and 48 data widgets, so past them an app shows in the
   * overview only. Missing when every app has its slide.
   */
  omittedApps: z.array(z.string()).optional(),
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
      /**
       * Published, reading the current published versions of its inputs.
       * False while `stale`.
       */
      published: z.boolean(),
      /**
       * Published, but before the update's versions of its inputs: it still
       * reads their earlier versions. Publishing it again reads the current
       * ones. A later publish of an input, after the update's version, never
       * makes it stale.
       */
      stale: z.boolean(),
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
 * An install's app scope: the store connections it reads and the one app
 * its dashboard is fixed to (null: every app). Product groups are not part
 * of it; they live in the install's mapping tables.
 */
export const storeTemplateScopeSchema = z.object({
  requestId: z.uuid(),
  connections: z.array(z.uuid()),
  appScope: app.nullable(),
});
export type StoreTemplateScope = z.infer<typeof storeTemplateScopeSchema>;
/** The app scope a scope plan is made for, as query parameters. */
export const storeTemplateScopeQuerySchema = z.object({
  /** Comma-separated connection ids. */
  connections: z.string().min(1).max(4000),
  /** `<connectionId>:<appId>`; absent: every app. */
  appScope: z.string().min(1).max(65600).optional(),
});
/**
 * Changing an install's app scope: the new scope, the scope plan's `basis`
 * and a choice for every item it asks about (the removed connections'
 * preparations: remove or keep; either way they are detached, not deleted).
 */
export const storeTemplateScopeRequestSchema = z.strictObject({
  basis: z.string(),
  connections: z.array(z.uuid()).min(1),
  appScope: app.nullish(),
  decisions: storeTemplateApplyRequestSchema.shape.decisions.default([]),
});
export type StoreTemplateScopeRequest = z.infer<
  typeof storeTemplateScopeRequestSchema
>;
/**
 * `store_update_decision_missing` lists the items still without a choice;
 * `store_update_unmergeable` names the record (`key`) whose merged content
 * cannot be written and, when known, its items; `paths` are the validation
 * issue paths in that record when the merged content fails validation.
 */
export const storeTemplateApplyErrorSchema = z.object({
  error: z.string().min(1),
  key: z.string().optional(),
  refs: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
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
      /**
       * Some record (the dashboard among them) is not built from the
       * latest version yet: an update applied but not swapped in, closed
       * or swapped back. Its apps cannot change before that update. False
       * when the update only follows changed apps (#709).
       */
      newerVersion: z.boolean(),
      summary: storeTemplateUpdateSummarySchema.nullable(),
      error: z.enum(["store_template_baseline_unavailable"]).nullable(),
      dashboardIds: z.array(z.uuid()),
      modelIds: z.array(z.uuid()),
      preparationIds: z.array(z.uuid()),
      openUpdate: storeTemplateUpdateSchema.nullable(),
      /**
       * The install's newest update, open or closed (the open one when
       * there is one): a closed update's dashboards can still be swapped
       * back, and swapped again after a swap back.
       */
      lastUpdate: storeTemplateUpdateSchema.nullable(),
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
          /**
           * Why a template change is a choice: taking it brings back
           * `dataset` (symbolic), which the customer removed from the model.
           */
          reason: z.enum(["reads_removed_dataset"]).optional(),
          dataset: z.string().optional(),
          original: z.unknown().optional(),
          current: z.unknown().optional(),
          next: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
export type StoreTemplatePlan = z.infer<typeof storeTemplatePlanSchema>;
/**
 * Errors of creating an updated dashboard copy and of swapping it:
 * `store_update_review_changed` carries the fresh plan `records` of the
 * dashboard (it changed since the update was reviewed);
 * `store_update_unmergeable` names the dashboard (`key`), the template
 * widgets that do not fit (`refs`) and why (`paths`);
 * `device_scope_not_applicable` lists the screens whose fixed scope the
 * copy cannot apply, each with its scope problem (`code`).
 */
export const storeTemplateDashboardErrorSchema = z.object({
  error: z.string().min(1),
  key: z.string().optional(),
  refs: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  records: storeTemplatePlanSchema.shape.records.optional(),
  devices: z
    .array(z.object({ id: z.uuid(), name: z.string(), code: z.string() }))
    .optional(),
});
/**
 * Creating an updated dashboard copy. `replace`: build a fresh copy from
 * the original as it is now instead of the existing one, which must be
 * unswapped and on no screen (409 store_update_copy_in_use otherwise).
 */
export const storeTemplateCopyRequestSchema = z.strictObject({
  replace: z.boolean().optional(),
  /**
   * With `replace`: also when the copy was edited since it was made (409
   * store_update_copy_edited otherwise); those edits are lost.
   */
  discardCopyEdits: z.boolean().optional(),
});
/**
 * Paid or free of a product (#708): `auto` (default) is paid when one of
 * its apps had proceeds in the last 90 days (App Store sales rows with
 * developer proceeds, Google Play earnings rows with a positive amount).
 */
export const storeProductPricingSchema = z.enum(["auto", "paid", "free"]);
/**
 * The longest product id that can have settings (characters). The tables
 * accept longer free-text ids; such a product is listed as not editable
 * (`store_product_id_too_long`) and a save of it answers 400 with that code.
 */
export const STORE_PRODUCT_ID_MAX = 500;
export type StoreProductPricing = z.infer<typeof storeProductPricingSchema>;
/** A Vercel Web Analytics project (a resource of a Vercel connection). */
const storeProductWebsiteSchema = z.strictObject({
  connectionId: z.uuid(),
  projectId: z.string().trim().min(1).max(1024),
});
/**
 * The product identities of an install (#708): every product of its
 * products table plus each app of its connections no product claims, with
 * the owner's settings and what they resolve to. `icon` is the stored
 * resource icon of the product's first App Store app, else Play app, that
 * has one; it follows the daily icon refresh. `iconSource` is the app whose
 * icon to fetch while there is none (POST /resource-icons). `paid` is the
 * effective value: `pricing` unless `auto`, then `hadProceeds`. `websites`
 * are the workspace's Vercel connections and their projects to choose from.
 */
export const storeTemplateProductsSchema = z.object({
  requestId: z.uuid(),
  products: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      apps: z.array(
        z.object({
          connectionId: z.uuid(),
          appId: z.string(),
          name: z.string(),
          connectorId: z.enum(["app-store-connect", "google-play"]),
        }),
      ),
      icon: workspaceImageSchema.nullable(),
      iconSource: z
        .object({ connectionId: z.uuid(), resourceId: z.string() })
        .nullable(),
      pricing: storeProductPricingSchema,
      hadProceeds: z.boolean(),
      paid: z.boolean(),
      /**
       * Why the product's settings cannot be saved; null when they can. An
       * id longer than STORE_PRODUCT_ID_MAX, or empty (valid in the tables).
       */
      notEditable: z
        .enum(["store_product_id_too_long", "store_product_id_empty"])
        .nullable(),
      /** `name` is null when the project is no longer listed. */
      website: z
        .object({
          connectionId: z.uuid(),
          projectId: z.string(),
          name: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  websites: z.array(
    z.object({
      connectionId: z.uuid(),
      name: z.string(),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
export type StoreTemplateProducts = z.infer<typeof storeTemplateProductsSchema>;
/**
 * Changing product settings: each listed product gets its pricing and
 * website (null: none); products not listed keep theirs. The website must be
 * a project of a Vercel connection of the same workspace (400
 * store_website_invalid); the product one of the install's (400
 * store_product_unknown).
 */
export const storeTemplateProductsRequestSchema = z.strictObject({
  products: z
    .array(
      z.strictObject({
        /**
         * At most STORE_PRODUCT_ID_MAX characters; a longer id answers 400
         * store_product_id_too_long (the transport bound is the tables').
         */
        productId: z.string().min(1).max(65600),
        pricing: storeProductPricingSchema,
        website: storeProductWebsiteSchema.nullable(),
      }),
    )
    .min(1)
    .max(1000),
});
export type StoreTemplateProductsRequest = z.infer<
  typeof storeTemplateProductsRequestSchema
>;
