import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  preparationGraphSchema,
  semanticModelDefinitionSchema,
  storeTemplateResultSchema,
  type CreateDashboardRequest,
  type StoreTemplateApplyRequest,
  type StoreTemplateInstallList,
  type StoreTemplatePlan,
  type StoreTemplateScope,
  type StoreTemplateScopeRequest,
  type StoreTemplateUpdate,
} from "@netrics/contracts";
import {
  DatasetStoreError,
  deleteDashboard,
  findDashboard,
  insertAuditEvent,
  retryOnSerializationFailure,
  schema,
  withWorkspace,
  type Database,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  type DataPolicy,
  type Locale,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
import {
  createDataService,
  DataServiceError,
  datasetStoreStatus,
  isDataConflict,
  isRetryableDataConflict,
} from "../data/service.js";
import { createUpdatedDashboardCopy, DashboardCopyUnfit } from "./service.js";
import { storeTemplateCopy } from "./store-portfolio.js";
import { storedScope, validateScope } from "../devices/service.js";
import {
  deriveInstallCompletion,
  ensureInstallCompleted,
  type LegacyDashboardSnapshot,
} from "./store-template-legacy.js";
import {
  canonical,
  dashboardFromItems,
  dashboardItems,
  itemKindOf,
  withSlideKeys,
  modelFromItems,
  modelItems,
  normalizeDashboard,
  normalizeLegacyDashboard,
  normalizeTemplateDashboard,
  preparationFromItems,
  preparationItems,
  itemRefOfPath,
  recordKeyOf,
  UnmergeableRecord,
  type ItemRef,
  type Items,
  type NormalizedDashboard,
} from "./store-template-items.js";
import {
  classify,
  merge,
  MergeDecisionMissing,
  summarize,
  type ClassifyOptions,
  type Decision,
  type PlanItem,
  type UpdateSummary,
} from "./store-template-merge.js";
import {
  STORE_TEMPLATE_ID,
  storeTemplate,
  storeTemplateV1,
  type StoreTemplateDefinition,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateRecord,
  storeTemplateInputsSchema,
} from "./store-template.js";
import {
  readStoreApps,
  STORE_SOURCE_DATASETS,
  storeSourceDatasets,
  storeTemplateSources,
  unmappedProductRow,
  type StoreIconFetcher,
} from "./store-template-service.js";
import {
  missingIconSources,
  readStoreProducts,
} from "./store-template-products.js";

/**
 * "Update available" for store-template installs (template updates, 11E):
 * the list of installs with a summary of what a newer template version
 * changes, and per install the three-way plan (original template, the
 * customer's current records, the new template) the customer reviews before
 * applying it. Status and plan are read-only: an install made before
 * versions is completed in memory. Applying an update writes the completion
 * (ensureInstallCompleted), then the data changes as drafts through the
 * data service; nothing goes live before the customer publishes them.
 */
type Actor = { workspaceId: string; callerId: string; locale: Locale };
type RecordRow = typeof schema.dataTemplateRecords.$inferSelect;
type InstallRow = typeof schema.dataTemplateInstalls.$inferSelect;
type UpdateRow = typeof schema.dataTemplateUpdates.$inferSelect;
type PreparationRow = typeof schema.dataPreparations.$inferSelect;
type ModelRow = typeof schema.dataModels.$inferSelect;
type Kind = "preparation" | "model" | "dashboard";
/** Where a plan's version 4 apps come from (withApps). */
type Identity = "fresh" | "stored" | "lenient";

function reject(code: string, status: 400 | 404 | 409): never {
  throw new DataServiceError(code, status);
}

/** Applying with conflicts or removals still undecided; lists their refs. */
export class StoreUpdateDecisionMissing extends DataServiceError {
  constructor(readonly refs: string[]) {
    super("store_update_decision_missing", 400);
  }
}

/**
 * The merged content of a record cannot be written: a reference resolves
 * to nothing, or the result is not a valid definition. Names the record and
 * the items (when known); nothing of the update is written.
 */
export class StoreUpdateUnmergeable extends DataServiceError {
  constructor(
    readonly key: string,
    readonly refs: string[],
    /** Validation issue paths in the merged record, when it failed one. */
    readonly paths: string[] = [],
  ) {
    super("store_update_unmergeable", 409);
  }
}

/**
 * The customer's dashboard changed since the update was reviewed: an item
 * it asks about has no fitting decision. Carries the fresh plan records of
 * that dashboard, to review again.
 */
export class StoreUpdateReviewChanged extends DataServiceError {
  constructor(
    readonly records: StoreTemplatePlan["records"],
    /** The decided items whose current value changed since the apply. */
    readonly refs: string[] = [],
  ) {
    super("store_update_review_changed", 409);
  }
}

/**
 * A stored decision; dashboard decisions carry a hash of the customer's
 * value they were made on (`current`), so a later edit asks again.
 */
type StoredDecision = Decision & { current?: string };
/**
 * A hash of an item's value in one state; absent items hash alike. A
 * widget's value includes its slide and position, so moving a widget the
 * customer decided on asks for review again: by design, as the decision
 * was made on the widget where it was.
 */
const valueHash = (value: unknown) =>
  createHash("sha256")
    .update(value === undefined ? "absent" : JSON.stringify(canonical(value)))
    .digest("hex");

/**
 * Screens whose fixed scope the dashboard they would move to cannot apply
 * (its shared filters changed): nothing moves. Names each screen and why.
 */
export class StoreUpdateScopeNotApplicable extends DataServiceError {
  constructor(readonly devices: { id: string; name: string; code: string }[]) {
    super("device_scope_not_applicable", 409);
  }
}

/** The data drafts an update wrote (data_template_updates.drafts). */
const storedDraftsSchema = z.array(
  z.object({
    key: z.string(),
    kind: z.enum(["preparation", "model"]),
    recordId: z.uuid(),
    version: z.number().int(),
  }),
);
type StoredDraft = z.infer<typeof storedDraftsSchema>[number];
/** The dashboards an update changes (data_template_updates.dashboards). */
const storedDashboardsSchema = z.array(
  z.object({
    key: z.string(),
    originalId: z.uuid(),
    copyId: z.uuid().nullable(),
    swappedAt: z.iso.datetime().nullable(),
    swappedBackAt: z.iso.datetime().nullable(),
    /** The copy's widget and slide ids → template keys (once made). */
    copyWidgetKeys: z.record(z.string(), z.string()).optional(),
    /** The new template's dashboard in comparison form (once made). */
    templateOriginal: z.unknown().optional(),
    /** The record as it was before the swap, for swapping back. */
    previousOriginal: z.unknown().optional(),
    previousWidgetKeys: z.record(z.string(), z.string()).nullable().optional(),
    previousTemplateVersion: z.number().int().optional(),
    /** The original's version the copy was made from. */
    originalVersion: z.number().int().optional(),
    /** The copy's version when it was made (edited in Studio since if not). */
    copyVersion: z.number().int().optional(),
    /** A newer update of the install replaced this one: no more swaps. */
    superseded: z.boolean().optional(),
  }),
);
type StoredDashboard = z.infer<typeof storedDashboardsSchema>[number];

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** A record's original in any of its stored shapes. */
type Original =
  | { graph: PreparationGraph }
  | { definition: SemanticModelDefinition }
  /** New installs; `widgetKeys` (reading order) since template updates. */
  | {
      request: CreateDashboardRequest;
      widgetKeys?: string[];
      /** Version 4: the slides' keys in position order. */
      slideKeys?: string[];
    }
  /** Installs made before versions: the dashboard rows at migration time. */
  | { legacySnapshot: LegacyDashboardSnapshot }
  /** Already in comparison form (symbolic references). */
  | { normalized: NormalizedDashboard };

class BaselineUnavailable extends Error {}

/** An app scope the customer chose for an install (scope change). */
interface ScopeChoice {
  connections: string[];
  appScope?: { connectionId: string; appId: string } | null;
}
const appKeyOf = (app: { connectionId: string; appId: string }) =>
  app.connectionId + ":" + app.appId;

interface RecordPlan {
  key: string;
  kind: Kind;
  recordId: string | null;
  name: string;
  version: number | null;
  hasUnpublishedDraft: boolean;
  items: PlanItem[];
}
interface ComputedPlan {
  install: InstallRow;
  records: RecordPlan[];
  summary: UpdateSummary;
  basis: string;
  /** What applying the plan builds from. */
  inputs: StoreTemplateInputs;
  /** Every key the install knows → its record id (detached ones too). */
  ids: StoreTemplateIds;
  rows: RecordRow[];
  next: Map<string, StoreTemplateRecord>;
  original: Items;
  current: Items;
  upcoming: Items;
  preparations: Map<string, PreparationRow>;
  models: Map<string, ModelRow>;
  /** Template record and dataset ids → keys (new records as `new:<key>`). */
  idsToKeys: Map<string, string>;
  /** Per dashboard key: the widget and slide keys its current state used. */
  dashboardKeys: Map<string, Record<string, string>>;
  classifyOptions: ClassifyOptions;
  /** Scope change: detached keys the new scope builds again, by state. */
  reattached: string[];
  /**
   * Preparation and model keys whose record was deleted since (#671), live
   * or detached: dropped from the install, and built anew where the
   * template builds them.
   */
  replaced: string[];
}

const isUpdateAvailable = (
  install: InstallRow,
  records: RecordRow[],
  latest: number,
) =>
  install.templateVersion < latest ||
  records.some(
    (record) =>
      record.detachedAt === null &&
      record.kind !== "dataset" &&
      record.templateVersion < latest,
  );

/**
 * Whether applying a plan changes anything. classify never lists unchanged
 * items, but it lists the customer's own changes, which an apply keeps as
 * they are: a plan of only those (a record left at an older version because
 * the update did not touch it) is nothing to offer.
 */
const changesAnything = (records: readonly RecordPlan[]) =>
  records.some((record) =>
    record.items.some((item) => item.outcome !== "customer"),
  );

/** Plan records as the API shows them (classify never lists unchanged items). */
const planRecords = (records: RecordPlan[]): StoreTemplatePlan["records"] =>
  records.map(({ version: _version, items, ...record }) => ({
    ...record,
    items: items as StoreTemplatePlan["records"][number]["items"],
  }));

/** The item reference of a dashboard widget key (`widget:<name>`, `custom:<id>`). */
const dashboardWidgetRef = (key: string, widgetKey: string) =>
  `${key}#widget:${widgetKey.startsWith("widget:") ? widgetKey.slice("widget:".length) : widgetKey}`;

export function createStoreTemplateUpdateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
  /** The newest template; tests pass other versions. */
  template?: StoreTemplateDefinition;
  /** Fetches missing app icons before a plan or an apply (version 4). */
  fetchIcons?: StoreIconFetcher;
}) {
  const template = deps.template ?? storeTemplate,
    now = deps.now ?? (() => new Date()),
    policy = deps.policy ?? DEFAULT_DATA_POLICY;

  async function installRow(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
  ): Promise<InstallRow | undefined> {
    const [install] = await tx
      .select()
      .from(schema.dataTemplateInstalls)
      .where(
        and(
          eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
          eq(schema.dataTemplateInstalls.requestId, requestId),
          eq(schema.dataTemplateInstalls.templateId, STORE_TEMPLATE_ID),
        ),
      );
    return install;
  }
  function recordRows(tx: Transaction, workspaceId: string, requestId: string) {
    return tx
      .select()
      .from(schema.dataTemplateRecords)
      .where(
        and(
          eq(schema.dataTemplateRecords.workspaceId, workspaceId),
          eq(schema.dataTemplateRecords.requestId, requestId),
        ),
      )
      .orderBy(asc(schema.dataTemplateRecords.key));
  }

  /**
   * The inputs with the apps version 4 builds its slides from: read now
   * from the product identity ("fresh"; "lenient" keeps the given apps when
   * the identity cannot be read), or as stored ("stored": what an applied
   * update was reviewed with). Templates before version 4 have no apps.
   */
  async function withApps(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    inputs: StoreTemplateInputs,
    identity: Identity,
  ): Promise<StoreTemplateInputs> {
    if (template.version < 4 || identity === "stored") return inputs;
    const install = await installRow(tx, workspaceId, requestId);
    if (!install) return inputs;
    try {
      const apps = await readStoreApps(
        tx,
        workspaceId,
        requestId,
        {
          result: storeTemplateResultSchema.parse(install.result),
          connections: inputs.connections,
          fixedProduct: inputs.fixedProduct,
        },
        now(),
        policy,
      );
      return { ...inputs, apps };
    } catch (error) {
      if (identity === "lenient" && error instanceof DataServiceError)
        return inputs;
      throw error;
    }
  }

  /**
   * Whether an install may have an update to offer: a newer version than
   * some of its records, or (version 4) apps whose identity changed since
   * it was built (an app added or removed, paid or free, icon, website,
   * name). Whether the plan changes anything decides.
   */
  async function updateCandidate(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    install: InstallRow,
    rows: RecordRow[],
  ): Promise<boolean> {
    if (isUpdateAvailable(install, rows, template.version)) return true;
    if (template.version < 4) return false;
    const stored = storeTemplateInputsSchema.safeParse(install.inputs);
    if (!stored.success) return false;
    const inputs = stored.data as StoreTemplateInputs;
    const fresh = await withApps(tx, workspaceId, requestId, inputs, "lenient");
    return !same(inputs.apps ?? [], fresh.apps ?? []);
  }

  /**
   * Fetches the icons the install's apps lack (version 4), before a plan
   * or an apply reads them: app slides get their logo without "Use app
   * icon". Best effort; outside the plan's transaction.
   */
  async function prefetchIcons(actor: Actor, requestId: string) {
    if (!deps.fetchIcons || template.version < 4) return;
    try {
      const sources = await withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const install = await installRow(tx, actor.workspaceId, requestId);
          const inputs = install?.inputs as StoreTemplateInputs | null;
          if (!install || inputs?.fixedProduct) return [];
          return missingIconSources(
            (
              await readStoreProducts(
                tx,
                actor.workspaceId,
                requestId,
                now(),
                policy,
              )
            ).products,
          );
        },
      );
      if (sources.length) await deps.fetchIcons(actor, sources);
    } catch {
      // No icon: the slide has no logo.
    }
  }

  /**
   * The install's inputs with every source dataset the template reads: a
   * newer version can read datasets an install made before did not (version
   * 2: Google Play rating reports and report availability). Missing ones are
   * registered with `register`, otherwise their id or a `pending:`
   * placeholder; a connection that no longer exists is left as it is.
   */
  async function withSourceDatasets(
    tx: Transaction,
    workspaceId: string,
    inputs: StoreTemplateInputs,
    register: boolean,
  ): Promise<StoreTemplateInputs> {
    const lacking = inputs.connections.filter((connection) =>
      STORE_SOURCE_DATASETS[connection.connectorId].some(
        (key) => connection.datasets[key] === undefined,
      ),
    );
    if (!lacking.length) return inputs;
    const existing = new Set(
      (
        await tx
          .select({ id: schema.connections.id })
          .from(schema.connections)
          .where(
            and(
              eq(schema.connections.workspaceId, workspaceId),
              inArray(
                schema.connections.id,
                lacking.map((connection) => connection.id),
              ),
            ),
          )
      ).map((row) => row.id),
    );
    const connections = [];
    for (const connection of inputs.connections) {
      const missing = STORE_SOURCE_DATASETS[connection.connectorId].filter(
        (key) => connection.datasets[key] === undefined,
      );
      connections.push(
        missing.length && existing.has(connection.id)
          ? {
              ...connection,
              datasets: {
                ...connection.datasets,
                ...(await storeSourceDatasets(
                  tx,
                  {
                    registry: deps.registry,
                    policy: deps.policy ?? DEFAULT_DATA_POLICY,
                  },
                  workspaceId,
                  connection,
                  { register },
                  missing,
                )),
              },
            }
          : connection,
      );
    }
    return { ...inputs, connections };
  }

  /**
   * The three-way plan of one install against `template`; null when its
   * baseline cannot be read (store_template_baseline_unavailable).
   */
  async function computePlan(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    /**
     * A change of the install's app scope: the plan builds the same version
     * from these inputs instead of the stored ones (scopeInputs).
     */
    scope?: { inputs: StoreTemplateInputs },
    /** Register source datasets the stored inputs lack (applying). */
    register = false,
    /** Which apps the plan builds version 4's slides from (withApps). */
    identity: Identity = "fresh",
  ): Promise<ComputedPlan | null> {
    // Read-only: an install made before versions is completed in memory
    // (keys renamed, inputs derived); applying an update writes it.
    const completion = await deriveInstallCompletion(
      tx,
      workspaceId,
      requestId,
    );
    if (!completion.ok) return null;
    const install = (await installRow(tx, workspaceId, requestId))!;
    const inputs = await withApps(
      tx,
      workspaceId,
      requestId,
      scope?.inputs ??
        (await withSourceDatasets(
          tx,
          workspaceId,
          completion.inputs,
          register,
        )),
      // A scope change always builds from the chosen connections' apps,
      // and still works when their identity cannot be read (over the row
      // limit, say): the apps then stay as they were built.
      scope ? "lenient" : identity,
    );
    let rows = (await recordRows(tx, workspaceId, requestId)).map((row) => {
      if (!completion.pending) return row;
      const key = completion.keys[row.key] ?? row.key;
      return {
        ...row,
        key,
        widgetKeys:
          key === "dashboard:portfolio"
            ? completion.widgetKeys
            : row.widgetKeys,
      };
    });
    const reattached: string[] = [],
      replaced: string[] = [];
    // Preparations and models deleted since (#671), tracked or detached:
    // their keys are built anew where the template builds them, so nothing
    // the update writes reads a record that no longer exists.
    const exists = new Set<string>();
    for (const [table, kind] of [
      [schema.dataPreparations, "preparation"],
      [schema.dataModels, "model"],
    ] as const) {
      const ids = rows
        .filter((row) => row.kind === kind)
        .map((row) => row.recordId);
      if (ids.length)
        for (const found of await tx
          .select({ id: table.id })
          .from(table)
          .where(
            and(eq(table.workspaceId, workspaceId), inArray(table.id, ids)),
          ))
          exists.add(found.id);
    }
    const deleted = (row: RecordRow) =>
      (row.kind === "preparation" || row.kind === "model") &&
      !exists.has(row.recordId);
    if (scope) {
      // A connection added back: the records detached when it was removed
      // are the install's again, as the customer left them.
      const keys = new Set(template.keys(inputs));
      for (const row of rows)
        if (
          row.detachedAt !== null &&
          keys.has(row.key) &&
          (row.kind === "preparation" || row.kind === "model") &&
          !deleted(row)
        )
          reattached.push(row.key);
      rows = rows.map((row) =>
        reattached.includes(row.key) ? { ...row, detachedAt: null } : row,
      );
    }
    for (const row of rows) if (deleted(row)) replaced.push(row.key);
    rows = rows.filter((row) => !deleted(row));
    const live = rows.filter(
      (row) => row.detachedAt === null && row.kind !== "dataset",
    );

    // Every id the install knows, plus a placeholder for each record the new
    // version adds, so dependants of new records can be built.
    const ids = Object.fromEntries(
      rows.map((row) => [row.key, row.recordId]),
    ) as StoreTemplateIds;
    const nextIds = { ...ids } as StoreTemplateIds;
    const next = new Map<string, StoreTemplateRecord>();
    for (const key of template.keys(inputs)) {
      if (!nextIds[key]) nextIds[key] = `new:${key}`;
      next.set(key, template.build(key, inputs, nextIds));
    }
    const idsToKeys = new Map<string, string>(
      Object.entries(nextIds).map(([key, id]) => [id, key]),
    );

    // The customer's current rows (the draft where one exists).
    const recordIds = (kind: Kind) =>
      live.filter((row) => row.kind === kind).map((row) => row.recordId);
    const preparations = new Map(
      (recordIds("preparation").length
        ? await tx
            .select()
            .from(schema.dataPreparations)
            .where(
              and(
                eq(schema.dataPreparations.workspaceId, workspaceId),
                inArray(schema.dataPreparations.id, recordIds("preparation")),
              ),
            )
        : []
      ).map((row) => [row.id, row]),
    );
    const models = new Map(
      (recordIds("model").length
        ? await tx
            .select()
            .from(schema.dataModels)
            .where(
              and(
                eq(schema.dataModels.workspaceId, workspaceId),
                inArray(schema.dataModels.id, recordIds("model")),
              ),
            )
        : []
      ).map((row) => [row.id, row]),
    );

    const nextItems = (record: StoreTemplateRecord): Items =>
      record.kind === "preparation"
        ? preparationItems(record.key, record.graph, idsToKeys)
        : record.kind === "model"
          ? modelItems(record.key, record.definition, idsToKeys)
          : dashboardItems(
              record.key,
              normalizeTemplateDashboard(
                record.request,
                record.widgetKeys,
                idsToKeys,
                record.slideKeys,
              ),
            );
    /** The dashboard version 1 builds for these inputs, as items. */
    const v1Dashboard = (key: string): Items => {
      const record = storeTemplateV1.build(key, inputs, ids);
      if (record.kind !== "dashboard") throw new BaselineUnavailable();
      return nextItems(record);
    };
    /**
     * A dashboard's widget and slide keys; installs keyed before slides were
     * get the first slides by position, as many as its original has.
     */
    const templateKeys = (
      row: RecordRow,
      slides: readonly object[],
      originals: Items,
    ) =>
      withSlideKeys(
        (row.widgetKeys ?? {}) as Record<string, string>,
        slides,
        [...originals.keys()].filter(
          (ref) =>
            itemKindOf(ref) === "slide" && !ref.includes("#slide:custom:"),
        ).length,
      );
    const originalItems = (row: RecordRow): Items => {
      const original = row.original as Original | null;
      if (original && "graph" in original && row.kind === "preparation")
        return preparationItems(row.key, original.graph, idsToKeys);
      if (original && "definition" in original && row.kind === "model")
        return modelItems(row.key, original.definition, idsToKeys);
      if (row.kind !== "dashboard" || !original)
        throw new BaselineUnavailable();
      if ("normalized" in original)
        return dashboardItems(row.key, original.normalized);
      if ("request" in original) {
        let keys = original.widgetKeys;
        if (!Array.isArray(keys)) {
          // Installs between template versions and template updates stored
          // no key order; they were all made by version 1.
          if (row.templateVersion !== 1) throw new BaselineUnavailable();
          const built = storeTemplateV1.build(row.key, inputs, ids);
          if (built.kind !== "dashboard") throw new BaselineUnavailable();
          keys = built.widgetKeys;
        }
        return dashboardItems(
          row.key,
          normalizeTemplateDashboard(
            original.request,
            keys,
            idsToKeys,
            original.slideKeys,
          ),
        );
      }
      if ("legacySnapshot" in original) {
        // The dashboard at migration time is the original of every template
        // part still on it. A template part the customer had already
        // deleted keeps version 1's content (a customer deletion, not a
        // template addition); what the customer had added is theirs, not
        // the template's.
        const v1 = v1Dashboard(row.key);
        const snapshot = dashboardItems(
          row.key,
          normalizeLegacyDashboard(
            original.legacySnapshot,
            templateKeys(row, original.legacySnapshot.slides, v1),
            idsToKeys,
          ),
        );
        const items: Items = new Map();
        for (const [ref, value] of v1)
          items.set(ref, snapshot.has(ref) ? snapshot.get(ref) : value);
        return items;
      }
      throw new BaselineUnavailable();
    };

    const original: Items = new Map(),
      current: Items = new Map(),
      upcoming: Items = new Map();
    const add = (target: Items, items: Items) => {
      for (const [ref, value] of items) target.set(ref, value);
    };
    const plans: RecordPlan[] = [];
    const seen = new Set<string>();
    const dashboardKeys = new Map<string, Record<string, string>>();
    for (const row of live) {
      const kind = row.kind as Kind;
      let name: string,
        version: number,
        draft = false,
        currentItems: Items,
        recordOriginal: Items | undefined;
      if (kind === "preparation") {
        const prep = preparations.get(row.recordId);
        if (!prep) continue;
        name = prep.name;
        version = prep.version;
        draft =
          prep.publishedVersion === null ||
          prep.version > prep.publishedVersion;
        currentItems = preparationItems(
          row.key,
          prep.graph as PreparationGraph,
          idsToKeys,
        );
      } else if (kind === "model") {
        const model = models.get(row.recordId);
        if (!model) continue;
        name = model.name;
        version = model.version;
        draft =
          model.publishedVersion === null ||
          model.version > model.publishedVersion;
        currentItems = modelItems(
          row.key,
          model.definition as SemanticModelDefinition,
          idsToKeys,
        );
      } else {
        const dashboard = await findDashboard(tx, workspaceId, row.recordId);
        if (!dashboard) continue;
        name = dashboard.name;
        version = dashboard.version;
        recordOriginal = originalItems(row);
        const keys = templateKeys(row, dashboard.slides, recordOriginal);
        dashboardKeys.set(row.key, keys);
        currentItems = dashboardItems(
          row.key,
          normalizeDashboard(dashboard, keys, idsToKeys),
        );
      }
      seen.add(row.key);
      add(original, recordOriginal ?? originalItems(row));
      add(current, currentItems);
      const built = next.get(row.key);
      if (built) add(upcoming, nextItems(built));
      plans.push({
        key: row.key,
        kind,
        recordId: row.recordId,
        name,
        version,
        hasUnpublishedDraft: draft,
        items: [],
      });
    }
    for (const [key, record] of next) {
      if (seen.has(key) || ids[key]) continue;
      add(upcoming, nextItems(record));
      plans.push({
        key,
        kind: record.kind,
        recordId: null,
        name: record.name,
        version: null,
        hasUnpublishedDraft: false,
        items: [],
      });
    }

    // By key, whatever keys the rows were stored under (baseline renames).
    plans.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const classifyOptions = { proposeRemovedConnections: scope !== undefined };
    const plan = classify(original, current, upcoming, classifyOptions);
    const byRecord = new Map<string, PlanItem[]>();
    for (const item of plan) {
      const key = recordKeyOf(item.ref);
      byRecord.set(key, [...(byRecord.get(key) ?? []), item]);
    }
    for (const record of plans) record.items = byRecord.get(record.key) ?? [];
    const basis = createHash("sha256")
      .update(
        JSON.stringify([
          // A scope plan is never the basis of an update, nor the reverse.
          scope ? "scope" : "update",
          template.version,
          install.templateVersion,
          // The inputs the next version is built from (apps, scope, name).
          createHash("sha256")
            .update(JSON.stringify(canonical(inputs)))
            .digest("hex"),
          ...plans
            .map((record) => [record.key, record.recordId, record.version])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]),
      )
      .digest("hex");
    return {
      install,
      records: plans,
      summary: summarize(original, upcoming, plan),
      basis,
      inputs,
      ids,
      rows,
      next,
      original,
      current,
      upcoming,
      preparations,
      models,
      idsToKeys,
      dashboardKeys,
      classifyOptions,
      reattached,
      replaced,
    };
  }

  async function planOrUnavailable(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    scope?: { inputs: StoreTemplateInputs },
    register = false,
    identity: Identity = "fresh",
  ) {
    try {
      return await computePlan(
        tx,
        workspaceId,
        requestId,
        scope,
        register,
        identity,
      );
    } catch (error) {
      if (error instanceof BaselineUnavailable) return null;
      throw error;
    }
  }

  /**
   * Whether an install has a template update to offer: a newer version
   * than some of its records, whose plan changes something (or cannot be
   * read, which the install then reports).
   */
  async function updateToOffer(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    install: InstallRow,
    rows: RecordRow[],
  ): Promise<boolean> {
    // A newer version only: a scope change builds from the apps' current
    // identity itself, so changed app identity never holds it up.
    if (!isUpdateAvailable(install, rows, template.version)) return false;
    const computed = await planOrUnavailable(tx, workspaceId, requestId);
    return computed === null || changesAnything(computed.records);
  }

  /**
   * The install's open update (none closed it yet), as the API shows it. An
   * update without dashboards is done once its drafts are published (a swap
   * closes one with dashboards): it is closed then (#626), so it is the
   * install's last update, the next version's review is not hidden behind
   * it, and a later publish of its inputs never reopens it.
   */
  async function openUpdateOf(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
  ): Promise<StoreTemplateUpdate | null> {
    const [row] = await tx
      .select()
      .from(schema.dataTemplateUpdates)
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
          eq(schema.dataTemplateUpdates.requestId, requestId),
          isNull(schema.dataTemplateUpdates.closedAt),
        ),
      );
    if (!row) return null;
    const view = await updateView(tx, workspaceId, row);
    if (
      view.dashboards.length > 0 ||
      !view.drafts.every((draft) => draft.published)
    )
      return view;
    await tx
      .update(schema.dataTemplateUpdates)
      .set({ closedAt: now() })
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
          eq(schema.dataTemplateUpdates.id, row.id),
          isNull(schema.dataTemplateUpdates.closedAt),
        ),
      );
    return null;
  }
  /**
   * The install's newest update, open or closed: what a swap back (or a
   * swap again after one) acts on once the update closed.
   */
  async function lastUpdateOf(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
  ): Promise<StoreTemplateUpdate | null> {
    const [row] = await tx
      .select()
      .from(schema.dataTemplateUpdates)
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
          eq(schema.dataTemplateUpdates.requestId, requestId),
        ),
      )
      .orderBy(
        sql`${schema.dataTemplateUpdates.closedAt} is not null`,
        desc(schema.dataTemplateUpdates.createdAt),
        desc(schema.dataTemplateUpdates.closedAt),
      )
      .limit(1);
    return row ? updateView(tx, workspaceId, row) : null;
  }
  /**
   * Whether a published preparation version or model release reads, for
   * every preparation this update drafted that it pins (directly or through
   * the preparations it reads), the update's version or a later one. Only
   * the update's own versions count: publishing an input again later, for
   * whatever reason, leaves what was published after the update's version
   * of it done (#626).
   */
  async function readsUpdateInputs(
    tx: Transaction,
    workspaceId: string,
    kind: "preparation" | "model",
    id: string,
    version: number,
    /** The update's preparation drafts: id → the version it drafted. */
    drafted: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    const [publication] =
      kind === "preparation"
        ? await tx
            .select({
              dependencies: schema.dataPreparationVersions.dependencies,
            })
            .from(schema.dataPreparationVersions)
            .where(
              and(
                eq(schema.dataPreparationVersions.workspaceId, workspaceId),
                eq(schema.dataPreparationVersions.preparationId, id),
                eq(schema.dataPreparationVersions.version, version),
              ),
            )
        : await tx
            .select({ dependencies: schema.dataModelReleases.dependencies })
            .from(schema.dataModelReleases)
            .where(
              and(
                eq(schema.dataModelReleases.workspaceId, workspaceId),
                eq(schema.dataModelReleases.modelId, id),
                eq(schema.dataModelReleases.version, version),
              ),
            );
    return Object.entries(
      (
        publication?.dependencies as
          { prepared?: Record<string, number> } | undefined
      )?.prepared ?? {},
    ).every(
      ([prepared, pinned]) =>
        prepared === id ||
        !drafted.has(prepared) ||
        pinned >= drafted.get(prepared)!,
    );
  }
  async function updateView(
    tx: Transaction,
    workspaceId: string,
    row: UpdateRow,
  ): Promise<StoreTemplateUpdate> {
    const drafts = storedDraftsSchema.parse(row.drafts),
      dashboards = storedDashboardsSchema.parse(row.dashboards);
    const ids = (kind: StoredDraft["kind"]) =>
      drafts.filter((d) => d.kind === kind).map((d) => d.recordId);
    const current = new Map<
      string,
      { name: string; publishedVersion: number | null }
    >();
    for (const [table, kind] of [
      [schema.dataPreparations, "preparation"],
      [schema.dataModels, "model"],
    ] as const)
      if (ids(kind).length)
        for (const record of await tx
          .select({
            id: table.id,
            name: table.name,
            publishedVersion: table.publishedVersion,
          })
          .from(table)
          .where(
            and(
              eq(table.workspaceId, workspaceId),
              inArray(table.id, ids(kind)),
            ),
          ))
          current.set(record.id, record);
    const drafted = new Map(
      drafts
        .filter((draft) => draft.kind === "preparation")
        .map((draft) => [draft.recordId, draft.version]),
    );
    const views = [];
    for (const draft of drafts) {
      const record = current.get(draft.recordId);
      if (!record) continue;
      const released =
        record.publishedVersion !== null &&
        record.publishedVersion >= draft.version;
      // Published before the update's version of an input of it was (out
      // of order): it pins that input's earlier version until it is
      // published again.
      const stale =
        released &&
        !(await readsUpdateInputs(
          tx,
          workspaceId,
          draft.kind,
          draft.recordId,
          record.publishedVersion!,
          drafted,
        ));
      views.push({
        ...draft,
        name: record.name,
        published: released && !stale,
        stale,
      });
    }
    const published = views.every((draft) => draft.published);
    return {
      id: row.id,
      requestId: row.requestId,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      createdAt: row.createdAt.toISOString(),
      drafts: views,
      dashboards: dashboards.map((dashboard) => ({
        key: dashboard.key,
        originalId: dashboard.originalId,
        copyId: dashboard.copyId,
        swappedAt: dashboard.swappedAt,
        swappedBackAt: dashboard.swappedBackAt,
        // The updated copy is made once the data it shows is published.
        ready: published && dashboard.copyId === null,
      })),
    };
  }

  /**
   * The inputs an install is built from with `choice` as its app scope:
   * the stored inputs (name, locale, project, groups) with the chosen
   * connections (kept ones as stored, new ones resolved and, with
   * `register`, their sources registered) and the app filter's fixed value
   * derived as at install (the app's install-time group, else the app).
   */
  async function scopeInputs(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    choice: ScopeChoice,
    register: boolean,
  ): Promise<StoreTemplateInputs> {
    const completion = await deriveInstallCompletion(
      tx,
      workspaceId,
      requestId,
    );
    if (!completion.ok) reject("store_template_baseline_unavailable", 409);
    const base = completion.inputs;
    const ids = [...new Set(choice.connections)].sort();
    if (!ids.length) reject("store_scope_invalid", 400);
    const appScope = choice.appScope ?? null;
    if (appScope && !ids.includes(appScope.connectionId))
      reject("store_scope_invalid", 400);
    const kept = base.connections.filter((c) => ids.includes(c.id));
    const added = await storeTemplateSources(
      tx,
      {
        registry: deps.registry,
        policy: deps.policy ?? DEFAULT_DATA_POLICY,
      },
      workspaceId,
      ids.filter((id) => !kept.some((c) => c.id === id)),
      { register },
    );
    const group = appScope
      ? base.groups?.find((candidate) =>
          candidate.apps.some((app) => appKeyOf(app) === appKeyOf(appScope)),
        )
      : undefined;
    return {
      ...base,
      connections: [...kept, ...added].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
      fixedProduct: appScope
        ? group
          ? "product:" + group.id
          : appKeyOf(appScope)
        : null,
    };
  }

  /**
   * Adds the unallocated product row of each of `sources` to the install's
   * products table where its product id is absent; a new snapshot of the
   * table with every existing row as it is.
   */
  async function addProductRows(
    data: ReturnType<typeof createDataService>,
    actor: Actor,
    datasetId: string | undefined,
    sources: { id: string; name: string }[],
    locale: Locale,
  ) {
    if (!datasetId || !sources.length) return;
    const first = await data.readManual(actor, datasetId, {
      offset: 0,
      limit: 1000,
    });
    const records = [...first.records];
    while (records.length < first.total) {
      const page = await data.readManual(actor, datasetId, {
        generationId: first.generationId ?? undefined,
        offset: records.length,
        limit: 1000,
      });
      if (!page.records.length) break;
      records.push(...page.records);
    }
    const known = new Set(records.map((record) => record.values.product_id));
    const added = sources
      .map((source) => unmappedProductRow(source, locale))
      .filter((row) => !known.has(row.values.product_id));
    if (!added.length) return;
    await data.saveManual(
      actor,
      {
        definition: first.definition,
        records: [...records, ...added],
        generationId: first.generationId,
      },
      datasetId,
    );
  }

  /** The app scope an install's inputs describe (scopeInputs reversed). */
  function scopeOf(inputs: StoreTemplateInputs): ScopeChoice {
    const fixed = inputs.fixedProduct;
    let appScope: ScopeChoice["appScope"] = null;
    if (fixed?.startsWith("product:")) {
      const group = inputs.groups?.find(
        (candidate) => "product:" + candidate.id === fixed,
      );
      // An app of the group the install still reads, so the scope applies.
      appScope =
        group?.apps.find((app) =>
          inputs.connections.some((c) => c.id === app.connectionId),
        ) ?? null;
    } else if (fixed) {
      const cut = fixed.indexOf(":");
      appScope = {
        connectionId: fixed.slice(0, cut),
        appId: fixed.slice(cut + 1),
      };
    }
    return {
      connections: inputs.connections.map((connection) => connection.id).sort(),
      appScope,
    };
  }

  /**
   * Writes the update's data drafts in tx: each preparation and model the
   * merge changes is saved as a draft of its record (its published version
   * stays live), records the new version adds are created unpublished, and
   * records it no longer builds are detached and kept. Dashboards are not
   * written: the updated copy is made after the drafts are published.
   */
  async function writeUpdate(
    tx: Transaction,
    actor: Actor,
    requestId: string,
    body: StoreTemplateApplyRequest,
    /** A change of the install's app scope instead of a template update. */
    scope?: ScopeChoice,
  ): Promise<StoreTemplateUpdate> {
    const at = now();
    const install = await installRow(tx, actor.workspaceId, requestId);
    if (!install) reject("store_template_not_found", 404);
    // Under the install's lock: an install made before versions gets its
    // inputs and keys written, so the plan below reads stored state only.
    const completed = await ensureInstallCompleted(
      tx,
      actor.workspaceId,
      requestId,
    );
    if (!completed.ok) reject("store_template_baseline_unavailable", 409);
    const rows = await recordRows(tx, actor.workspaceId, requestId);
    let plan: ComputedPlan | null;
    if (scope) {
      if (await updateToOffer(tx, actor.workspaceId, requestId, install, rows))
        reject("store_template_update_available", 409);
      // The plan the customer reviewed: new connections' sources as they
      // were then (not registered yet), so the basis compares.
      const reviewed = await planOrUnavailable(
        tx,
        actor.workspaceId,
        requestId,
        {
          inputs: await scopeInputs(
            tx,
            actor.workspaceId,
            requestId,
            scope,
            false,
          ),
        },
      );
      if (!reviewed) reject("store_template_baseline_unavailable", 409);
      if (reviewed.basis !== body.basis) reject("store_update_stale", 409);
      if (!reviewed.records.some((record) => record.items.length > 0))
        reject("store_scope_unchanged", 409);
      plan = await planOrUnavailable(tx, actor.workspaceId, requestId, {
        inputs: await scopeInputs(
          tx,
          actor.workspaceId,
          requestId,
          scope,
          true,
        ),
      });
    } else {
      if (
        !(await updateCandidate(
          tx,
          actor.workspaceId,
          requestId,
          install,
          rows,
        ))
      )
        reject("store_template_up_to_date", 409);
      // The plan the customer reviewed: source datasets the new version
      // reads as they were then (perhaps not registered yet).
      const reviewed = await planOrUnavailable(
        tx,
        actor.workspaceId,
        requestId,
      );
      if (!reviewed) reject("store_template_baseline_unavailable", 409);
      if (!changesAnything(reviewed.records))
        reject("store_template_up_to_date", 409);
      // The same plan applied twice (double click, two tabs) is stale first.
      if (reviewed.basis !== body.basis) reject("store_update_stale", 409);
      plan = await planOrUnavailable(
        tx,
        actor.workspaceId,
        requestId,
        undefined,
        true,
      );
    }
    if (!plan) reject("store_template_baseline_unavailable", 409);
    // An earlier update's drafts are the customer's to publish, or they
    // close that update (closeUpdate) to leave them as ordinary drafts:
    // a new apply would build on them and lose track of them.
    const open = await openUpdateOf(tx, actor.workspaceId, requestId);
    if (open && open.drafts.some((draft) => !draft.published))
      reject("store_update_open", 409);
    let merged: Items;
    try {
      merged = merge(
        plan.original,
        plan.current,
        plan.upcoming,
        body.decisions as Decision[],
        plan.classifyOptions,
      );
    } catch (error) {
      if (error instanceof MergeDecisionMissing)
        throw new StoreUpdateDecisionMissing(error.refs);
      throw error;
    }

    const data = createDataService(tx, now, deps.policy ?? DEFAULT_DATA_POLICY);
    const ids: Record<string, string> = { ...plan.ids };
    const live = new Map(
      plan.rows
        .filter((row) => row.detachedAt === null)
        .map((row) => [row.key, row]),
    );
    const keys = template.keys(plan.inputs);
    const drafts: StoredDraft[] = [];
    const created: (typeof schema.dataTemplateRecords.$inferInsert)[] = [];
    const recordItems = (key: string): Items =>
      new Map([...merged].filter(([itemRef]) => recordKeyOf(itemRef) === key));
    // Whether merge took an item's value from the new template.
    const planned = new Map(
      plan.records.flatMap((record) => record.items).map((i) => [i.ref, i]),
    );
    const choices = new Map(body.decisions.map((d) => [d.ref, d.choice]));
    const fromNext = (itemRef: string) => {
      const planItem = planned.get(itemRef as ItemRef);
      return (
        planItem?.outcome === "template" ||
        planItem?.outcome === "scope" ||
        (planItem?.outcome === "choose" && choices.get(itemRef) === "template")
      );
    };
    const datasetsOf = (items: Items, key: string) =>
      (items.get(`${key}#settings:datasets`) as unknown[] | undefined) ?? [];
    /**
     * A merged record that resolves and validates, or 409
     * store_update_unmergeable naming the record and its items.
     */
    const checked = <T extends PreparationGraph | SemanticModelDefinition>(
      key: string,
      build: () => T,
      valid: z.ZodType,
    ): T => {
      let built: T;
      try {
        built = build();
      } catch (error) {
        if (error instanceof UnmergeableRecord)
          throw new StoreUpdateUnmergeable(key, error.refs);
        throw error;
      }
      const parsed = valid.safeParse(built);
      if (!parsed.success)
        // The items the issues point at, so the review can show them.
        throw new StoreUpdateUnmergeable(
          key,
          [
            ...new Set(
              parsed.error.issues.map((issue) =>
                itemRefOfPath(key, built, issue.path),
              ),
            ),
          ],
          // A root-level issue's path is the record key, never "".
          parsed.error.issues.map((issue) =>
            issue.path.length ? issue.path.map(String).join(".") : key,
          ),
        );
      return built;
    };
    /**
     * Preparations this update drafts or creates. A published preparation or
     * model keeps the input versions it was published with, so one that
     * reads them gets a draft too, even with unchanged content: publishing
     * it (after its inputs, the order drafts are listed in) reads their new
     * versions. Keys come in dependency order (sources, appends, models).
     */
    const drafted = new Set<string>();
    const readsDrafted = (datasetIds: string[]) =>
      datasetIds.some(
        (id) => id.startsWith("prepared:") && drafted.has(id.split(":")[1]!),
      );
    const sourcesOf = (graph: PreparationGraph) =>
      graph.nodes.flatMap((node) =>
        node.type === "source" ? [node.datasetId] : [],
      );
    for (const key of keys) {
      const next = plan.next.get(key)!;
      if (next.kind === "dashboard") continue;
      const row = live.get(key);
      if (!row) {
        // Detached keys keep their record (the template no longer tracks
        // it); only a key the install never had is new.
        if (plan.ids[key]) continue;
        const record = template.build(
          key,
          plan.inputs,
          ids as StoreTemplateIds,
        );
        const saved =
          record.kind === "preparation"
            ? (
                await data.savePreparation(actor, {
                  name: record.name,
                  graph: record.graph,
                  projectId: plan.inputs.projectId,
                })
              ).preparation
            : record.kind === "model"
              ? (
                  await data.saveModel(actor, {
                    name: record.name,
                    definition: record.definition,
                    projectId: plan.inputs.projectId,
                  })
                ).model
              : null;
        if (!saved || record.kind === "dashboard") continue;
        ids[key] = saved.id;
        if (record.kind === "preparation") drafted.add(saved.id);
        drafts.push({
          key,
          kind: record.kind,
          recordId: saved.id,
          version: saved.version,
        });
        created.push({
          workspaceId: actor.workspaceId,
          requestId,
          key,
          kind: record.kind,
          recordId: saved.id,
          templateVersion: template.version,
          original:
            record.kind === "preparation"
              ? { graph: record.graph }
              : { definition: record.definition },
          widgetKeys: null,
        });
        continue;
      }
      if (next.kind === "preparation") {
        const current = plan.preparations.get(row.recordId);
        if (!current) continue;
        const graph = checked(
          key,
          () =>
            preparationFromItems(
              key,
              recordItems(key),
              { current: current.graph as PreparationGraph, next: next.graph },
              ids,
            ),
          preparationGraphSchema,
        );
        if (same(graph, current.graph) && !readsDrafted(sourcesOf(graph)))
          continue;
        const { preparation } = await data.savePreparation(
          actor,
          { name: current.name, graph, version: current.version },
          current.id,
        );
        drafted.add(preparation.id);
        drafts.push({
          key,
          kind: "preparation",
          recordId: preparation.id,
          version: preparation.version,
        });
      } else {
        const current = plan.models.get(row.recordId);
        if (!current) continue;
        const definition = checked(
          key,
          () =>
            modelFromItems(
              key,
              recordItems(key),
              {
                current: current.definition as SemanticModelDefinition,
                next: next.definition,
              },
              ids,
              {
                datasets: {
                  original: datasetsOf(plan.original, key),
                  current: datasetsOf(plan.current, key),
                  next: datasetsOf(plan.upcoming, key),
                },
                fromNext,
              },
            ),
          semanticModelDefinitionSchema,
        );
        if (
          same(definition, current.definition) &&
          !readsDrafted(definition.datasets)
        )
          continue;
        const { model } = await data.saveModel(
          actor,
          { name: current.name, definition, version: current.version },
          current.id,
        );
        drafts.push({
          key,
          kind: "model",
          recordId: model.id,
          version: model.version,
        });
      }
    }

    // Records the new version no longer builds: detached, never deleted
    // (whether the customer chose remove or keep, or app scope dropped
    // them); their content stays as the customer left it.
    const built = new Set(keys);
    const gone = [...live.values()]
      .filter(
        (row) =>
          (row.kind === "preparation" || row.kind === "model") &&
          !built.has(row.key),
      )
      .map((row) => row.key);
    if (gone.length)
      await tx
        .update(schema.dataTemplateRecords)
        .set({ detachedAt: at })
        .where(
          and(
            eq(schema.dataTemplateRecords.workspaceId, actor.workspaceId),
            eq(schema.dataTemplateRecords.requestId, requestId),
            inArray(schema.dataTemplateRecords.key, gone),
          ),
        );
    // The new template content is the original of every data record from
    // now on; the dashboards keep theirs until their updated copy exists.
    for (const row of live.values()) {
      if (!built.has(row.key) && row.kind !== "dataset") continue;
      if (row.kind === "dashboard") continue;
      const record =
        row.kind === "dataset"
          ? null
          : template.build(row.key, plan.inputs, ids as StoreTemplateIds);
      await tx
        .update(schema.dataTemplateRecords)
        .set({
          templateVersion: template.version,
          ...(record?.kind === "preparation"
            ? { original: { graph: record.graph } }
            : record?.kind === "model"
              ? { original: { definition: record.definition } }
              : {}),
        })
        .where(
          and(
            eq(schema.dataTemplateRecords.workspaceId, actor.workspaceId),
            eq(schema.dataTemplateRecords.requestId, requestId),
            eq(schema.dataTemplateRecords.key, row.key),
          ),
        );
    }
    // A connection added back: its kept records are tracked again; a key
    // whose record was deleted since points at the one just created.
    if (plan.reattached.length)
      await tx
        .update(schema.dataTemplateRecords)
        .set({ detachedAt: null })
        .where(
          and(
            eq(schema.dataTemplateRecords.workspaceId, actor.workspaceId),
            eq(schema.dataTemplateRecords.requestId, requestId),
            inArray(schema.dataTemplateRecords.key, plan.reattached),
          ),
        );
    if (plan.replaced.length)
      await tx
        .delete(schema.dataTemplateRecords)
        .where(
          and(
            eq(schema.dataTemplateRecords.workspaceId, actor.workspaceId),
            eq(schema.dataTemplateRecords.requestId, requestId),
            inArray(schema.dataTemplateRecords.key, plan.replaced),
          ),
        );
    if (created.length)
      await tx.insert(schema.dataTemplateRecords).values(created);
    // An added connection's unallocated product row, as install writes it;
    // the customer's rows stay. Inert until its preparations are published.
    if (scope && completed.ok)
      await addProductRows(
        data,
        actor,
        plan.ids["dataset:products"],
        plan.inputs.connections.filter(
          (connection) =>
            !completed.inputs.connections.some((c) => c.id === connection.id),
        ),
        plan.inputs.locale,
      );
    await tx
      .update(schema.dataTemplateInstalls)
      .set({
        templateVersion: template.version,
        updatedAt: at,
        // What the install is built from from now on: a scope change, or
        // source datasets a newer version reads.
        inputs: storeTemplateInputsSchema.parse(plan.inputs),
      })
      .where(
        and(
          eq(schema.dataTemplateInstalls.workspaceId, actor.workspaceId),
          eq(schema.dataTemplateInstalls.requestId, requestId),
        ),
      );

    const dashboards: StoredDashboard[] = plan.records
      .filter(
        (record) =>
          record.kind === "dashboard" &&
          record.recordId !== null &&
          changesAnything([record]),
      )
      .map((record) => ({
        key: record.key,
        originalId: record.recordId!,
        copyId: null,
        swappedAt: null,
        swappedBackAt: null,
      }));
    // Older updates of the install can no longer swap: their copies were
    // built from what this update replaces.
    for (const older of await tx
      .select({
        id: schema.dataTemplateUpdates.id,
        dashboards: schema.dataTemplateUpdates.dashboards,
      })
      .from(schema.dataTemplateUpdates)
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, actor.workspaceId),
          eq(schema.dataTemplateUpdates.requestId, requestId),
        ),
      ))
      await saveEntries(
        tx,
        actor.workspaceId,
        older.id,
        storedDashboardsSchema
          .parse(older.dashboards)
          .map((entry) => ({ ...entry, superseded: true })),
      );
    // One open update per install (data_template_updates_one_open).
    await tx
      .update(schema.dataTemplateUpdates)
      .set({ closedAt: at })
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, actor.workspaceId),
          eq(schema.dataTemplateUpdates.requestId, requestId),
          isNull(schema.dataTemplateUpdates.closedAt),
        ),
      );
    const [update] = await tx
      .insert(schema.dataTemplateUpdates)
      .values({
        workspaceId: actor.workspaceId,
        requestId,
        fromVersion: plan.install.templateVersion,
        toVersion: template.version,
        decisions: body.decisions.map((decision): StoredDecision =>
          recordKeyOf(decision.ref).startsWith("dashboard:")
            ? {
                ...(decision as Decision),
                current: valueHash(plan.current.get(decision.ref as ItemRef)),
              }
            : (decision as Decision),
        ),
        drafts,
        dashboards,
        createdBy: actor.callerId,
        createdAt: at,
      })
      .returning();
    await insertAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.callerId,
      action: scope
        ? "data.store_template_scope_changed"
        : "data.store_template_update_applied",
      target: requestId,
      metadata: {
        requestId,
        fromVersion: plan.install.templateVersion,
        toVersion: template.version,
        ...(scope
          ? {
              connections: plan.inputs.connections.map((c) => c.id),
              appScope: scope.appScope ?? null,
            }
          : {}),
      },
    });
    return updateView(tx, actor.workspaceId, update!);
  }

  /**
   * The install's lock: orders the update operations on one install. The
   * install itself takes a SHARE UPDATE EXCLUSIVE table lock instead
   * (INSTALL_LOCK in store-template-service.ts), which never blocks these
   * operations' reads or writes.
   */
  async function lockInstall(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('netrics.store_template'),hashtext(${workspaceId + ":" + requestId}))`,
    );
  }

  /**
   * The update and its dashboard entry under the install's lock, or 404
   * store_template_update_not_found (another workspace's id included).
   */
  async function lockedEntry(
    tx: Transaction,
    workspaceId: string,
    updateId: string,
    key: string,
  ) {
    const read = async () =>
      (
        await tx
          .select()
          .from(schema.dataTemplateUpdates)
          .where(
            and(
              eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
              eq(schema.dataTemplateUpdates.id, updateId),
            ),
          )
      )[0];
    const found = await read();
    if (!found) reject("store_template_update_not_found", 404);
    await lockInstall(tx, workspaceId, found.requestId);
    // Read again under the lock: a concurrent copy or swap went first.
    const row = (await read())!;
    const entries = storedDashboardsSchema.parse(row.dashboards);
    const entry = entries.find((dashboard) => dashboard.key === key);
    if (!entry) reject("store_template_update_not_found", 404);
    return { row, entries, entry };
  }

  async function saveEntries(
    tx: Transaction,
    workspaceId: string,
    updateId: string,
    entries: StoredDashboard[],
    closedAt?: Date,
  ) {
    await tx
      .update(schema.dataTemplateUpdates)
      .set({ dashboards: entries, ...(closedAt ? { closedAt } : {}) })
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
          eq(schema.dataTemplateUpdates.id, updateId),
        ),
      );
  }

  /** Creates the updated copy of one dashboard of an update (createCopy). */
  async function writeCopy(
    tx: Transaction,
    actor: Actor,
    updateId: string,
    key: string,
    options: { replace?: boolean; discardCopyEdits?: boolean },
  ): Promise<StoreTemplateUpdate> {
    const { row, entries, entry } = await lockedEntry(
      tx,
      actor.workspaceId,
      updateId,
      key,
    );
    // A copy deleted since counts as none.
    const existing =
      entry.copyId === null
        ? null
        : await findDashboard(tx, actor.workspaceId, entry.copyId);
    if (existing && !options.replace) reject("store_update_copy_exists", 409);
    if (row.closedAt !== null) reject("store_update_closed", 409);
    if (existing) {
      // Replacing (the original changed since): only a copy no screen
      // shows and that is not swapped in. Its row stays locked until it is
      // deleted, so a screen assigned to it meanwhile (lockDashboardArchive
      // takes a share lock) waits, then finds it gone.
      await tx.execute(
        sql`select id from dashboards where workspace_id = ${actor.workspaceId} and id = ${existing.id} for update`,
      );
      const onScreens = await tx
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.workspaceId, actor.workspaceId),
            eq(schema.devices.dashboardId, existing.id),
            isNull(schema.devices.revokedAt),
          ),
        )
        .limit(1);
      if (
        onScreens.length > 0 ||
        (entry.swappedAt !== null && entry.swappedBackAt === null)
      )
        reject("store_update_copy_in_use", 409);
      // Edits made in the copy are the customer's: dropped only on request.
      if (
        entry.copyVersion !== undefined &&
        existing.version !== entry.copyVersion &&
        !options.discardCopyEdits
      )
        reject("store_update_copy_edited", 409);
    }
    // The copy shows published definitions only, never drafts.
    const view = await updateView(tx, actor.workspaceId, row);
    if (view.drafts.some((draft) => !draft.published))
      reject("store_update_drafts_unpublished", 409);
    if (row.toVersion !== template.version) reject("store_update_stale", 409);
    // The apps as the apply stored them: what the customer reviewed.
    const plan = await planOrUnavailable(
      tx,
      actor.workspaceId,
      row.requestId,
      undefined,
      false,
      "stored",
    );
    if (!plan) reject("store_template_baseline_unavailable", 409);
    const record = plan.records.find(
      (candidate) =>
        candidate.key === key && candidate.recordId === entry.originalId,
    );
    const next = plan.next.get(key);
    if (!record || next?.kind !== "dashboard")
      reject("store_update_stale", 409);
    const only = (items: Items): Items =>
      new Map([...items].filter(([ref]) => recordKeyOf(ref) === key));
    // The decisions the customer made when applying, against the dashboard
    // as it is now: an item they did not decide on, or decided on a value
    // they changed since, is theirs to review again (never overwritten).
    const changed = (row.decisions as StoredDecision[])
      .filter(
        (decision) =>
          recordKeyOf(decision.ref) === key &&
          decision.current !== undefined &&
          decision.current !== valueHash(plan.current.get(decision.ref)),
      )
      .map((decision) => decision.ref);
    if (changed.length)
      throw new StoreUpdateReviewChanged(planRecords([record]), changed);
    let merged: Items;
    try {
      merged = merge(
        only(plan.original),
        only(plan.current),
        only(plan.upcoming),
        row.decisions as Decision[],
      );
    } catch (error) {
      if (error instanceof MergeDecisionMissing)
        throw new StoreUpdateReviewChanged(planRecords([record]));
      throw error;
    }
    let normalized: NormalizedDashboard;
    try {
      normalized = dashboardFromItems(
        key,
        merged,
        { current: only(plan.current), next: only(plan.upcoming) },
        plan.ids,
      );
    } catch (error) {
      if (error instanceof UnmergeableRecord)
        throw new StoreUpdateUnmergeable(key, error.refs);
      throw error;
    }
    let result: Awaited<ReturnType<typeof createUpdatedDashboardCopy>>;
    try {
      result = await createUpdatedDashboardCopy(tx, actor, {
        sourceId: entry.originalId,
        name: storeTemplateCopy(actor.locale).updatedName(record.name),
        merged: normalized,
        widgetKeys: plan.dashboardKeys.get(key) ?? {},
      });
    } catch (error) {
      if (error instanceof DashboardCopyUnfit)
        throw new StoreUpdateUnmergeable(
          key,
          error.widgetKeys.map((widgetKey) =>
            dashboardWidgetRef(key, widgetKey),
          ),
          [error.problem],
        );
      throw error;
    }
    if (!result.ok) throw new DataServiceError(result.error, result.status);
    const copy = result.value.dashboard;
    if (existing) await deleteDashboard(tx, actor.workspaceId, existing.id);
    await saveEntries(
      tx,
      actor.workspaceId,
      updateId,
      entries.map((candidate) =>
        candidate.key === key
          ? {
              ...candidate,
              copyId: copy.id,
              copyWidgetKeys: result.value.widgetKeys,
              originalVersion: record.version ?? undefined,
              copyVersion: copy.version,
              // A fresh copy starts unswapped.
              swappedAt: null,
              swappedBackAt: null,
              templateOriginal: normalizeTemplateDashboard(
                next.request,
                next.widgetKeys,
                plan.idsToKeys,
                next.slideKeys,
              ),
            }
          : candidate,
      ),
    );
    await insertAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.callerId,
      action: "dashboard.template_copy_created",
      target: copy.id,
      metadata: {
        requestId: row.requestId,
        updateId,
        key,
        sourceId: entry.originalId,
        name: copy.name,
        ...(existing ? { replacedId: existing.id } : {}),
      },
    });
    return openUpdateView(tx, actor.workspaceId, updateId);
  }

  async function openUpdateView(
    tx: Transaction,
    workspaceId: string,
    updateId: string,
  ) {
    const [row] = await tx
      .select()
      .from(schema.dataTemplateUpdates)
      .where(
        and(
          eq(schema.dataTemplateUpdates.workspaceId, workspaceId),
          eq(schema.dataTemplateUpdates.id, updateId),
        ),
      );
    return updateView(tx, workspaceId, row!);
  }

  /**
   * Moves every screen (not revoked) on `from` to `to` in tx, fixed scopes
   * included, after checking each scope against `to`; any that does not
   * apply refuses the whole move (StoreUpdateScopeNotApplicable). `from`
   * is locked first, so a concurrent assignment to it either lands before
   * (and moves) or sees it archived. Returns the moved device ids.
   */
  async function moveScreens(
    tx: Transaction,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    await tx.execute(
      sql`select id from dashboards where workspace_id = ${workspaceId} and id = ${from} for update`,
    );
    const target = await findDashboard(tx, workspaceId, to);
    if (!target) reject("store_update_stale", 409);
    const devices = await tx
      .select()
      .from(schema.devices)
      .where(
        and(
          eq(schema.devices.workspaceId, workspaceId),
          eq(schema.devices.dashboardId, from),
          isNull(schema.devices.revokedAt),
        ),
      )
      .orderBy(asc(schema.devices.id))
      .for("update");
    const problems: { id: string; name: string; code: string }[] = [];
    for (const device of devices) {
      if (device.scope === null) continue;
      let code: string | null;
      try {
        code = validateScope(target, storedScope(device));
      } catch {
        code = "device_scope_not_applicable";
      }
      if (code) problems.push({ id: device.id, name: device.name, code });
    }
    if (problems.length) throw new StoreUpdateScopeNotApplicable(problems);
    const ids = devices.map((device) => device.id);
    if (ids.length)
      await tx
        .update(schema.devices)
        .set({
          dashboardId: to,
          scope: sql`case when ${schema.devices.scope} is null then null
            else jsonb_set(${schema.devices.scope}, '{dashboardId}', to_jsonb(${to}::text)) end`,
        })
        .where(
          and(
            eq(schema.devices.workspaceId, workspaceId),
            inArray(schema.devices.id, ids),
          ),
        );
    return ids;
  }

  async function setArchived(
    tx: Transaction,
    workspaceId: string,
    dashboardId: string,
    archivedAt: Date | null,
  ) {
    await tx
      .update(schema.dashboards)
      .set({ archivedAt })
      .where(
        and(
          eq(schema.dashboards.workspaceId, workspaceId),
          eq(schema.dashboards.id, dashboardId),
        ),
      );
  }

  async function dashboardRecord(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    key: string,
  ) {
    const [record] = await tx
      .select()
      .from(schema.dataTemplateRecords)
      .where(
        and(
          eq(schema.dataTemplateRecords.workspaceId, workspaceId),
          eq(schema.dataTemplateRecords.requestId, requestId),
          eq(schema.dataTemplateRecords.key, key),
        ),
      );
    return record;
  }
  async function setRecord(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
    key: string,
    values: Partial<typeof schema.dataTemplateRecords.$inferInsert>,
  ) {
    await tx
      .update(schema.dataTemplateRecords)
      .set(values)
      .where(
        and(
          eq(schema.dataTemplateRecords.workspaceId, workspaceId),
          eq(schema.dataTemplateRecords.requestId, requestId),
          eq(schema.dataTemplateRecords.key, key),
        ),
      );
  }

  /**
   * Puts the copy on every screen of the original in one step (swap), or
   * the original back on every screen of the copy (swap back).
   */
  async function writeSwap(
    tx: Transaction,
    actor: Actor,
    updateId: string,
    key: string,
    direction: "swap" | "back",
  ): Promise<StoreTemplateUpdate> {
    const at = now();
    const { row, entries, entry } = await lockedEntry(
      tx,
      actor.workspaceId,
      updateId,
      key,
    );
    const swapped = entry.swappedAt !== null && entry.swappedBackAt === null;
    // Idempotent: a repeat (double click, two tabs) changes nothing.
    if (direction === "swap" ? swapped : entry.swappedBackAt !== null)
      return openUpdateView(tx, actor.workspaceId, updateId);
    if (direction === "swap" && entry.superseded)
      reject("store_update_superseded", 409);
    if (entry.copyId === null) reject("store_update_copy_missing", 409);
    if (direction === "back" && !swapped)
      reject("store_update_not_swapped", 409);
    // A closed update swaps only what it swapped before (swap again).
    if (direction === "swap" && row.closedAt !== null && !entry.swappedAt)
      reject("store_update_closed", 409);
    const record = await dashboardRecord(
      tx,
      actor.workspaceId,
      row.requestId,
      key,
    );
    const [from, to] =
      direction === "swap"
        ? [entry.originalId, entry.copyId]
        : [entry.copyId, entry.originalId];
    // The record must still show what this update left it on.
    if (!record || record.recordId !== from || record.detachedAt !== null)
      reject("store_update_stale", 409);
    if (!(await findDashboard(tx, actor.workspaceId, from)))
      reject("store_update_stale", 409);
    if (!(await findDashboard(tx, actor.workspaceId, to)))
      reject(
        direction === "swap"
          ? "store_update_copy_missing"
          : "store_update_stale",
        409,
      );
    // The copy was made from the original as it was then: an original
    // edited since would lose those edits on the screens (replace the copy).
    if (direction === "swap" && entry.originalVersion !== undefined) {
      const [original] = await tx
        .select({ version: schema.dashboards.version })
        .from(schema.dashboards)
        .where(
          and(
            eq(schema.dashboards.workspaceId, actor.workspaceId),
            eq(schema.dashboards.id, entry.originalId),
          ),
        )
        .for("update");
      if (original && original.version !== entry.originalVersion)
        reject("store_update_original_changed", 409);
    }
    const devices = await moveScreens(tx, actor.workspaceId, from, to);
    await setArchived(tx, actor.workspaceId, from, at);
    await setArchived(tx, actor.workspaceId, to, null);
    let next: StoredDashboard;
    if (direction === "swap") {
      await setRecord(tx, actor.workspaceId, row.requestId, key, {
        recordId: to,
        original: { normalized: entry.templateOriginal },
        widgetKeys: entry.copyWidgetKeys ?? {},
        templateVersion: row.toVersion,
      });
      next = {
        ...entry,
        swappedAt: at.toISOString(),
        swappedBackAt: null,
        previousOriginal: record.original,
        previousWidgetKeys: (record.widgetKeys ?? null) as Record<
          string,
          string
        > | null,
        previousTemplateVersion: record.templateVersion,
      };
    } else {
      await setRecord(tx, actor.workspaceId, row.requestId, key, {
        recordId: to,
        original: entry.previousOriginal,
        widgetKeys: entry.previousWidgetKeys ?? null,
        templateVersion:
          entry.previousTemplateVersion ?? record.templateVersion,
      });
      next = { ...entry, swappedBackAt: at.toISOString() };
    }
    const nextEntries = entries.map((candidate) =>
      candidate.key === key ? next : candidate,
    );
    // Done when every dashboard of the update is on its copy.
    const done =
      direction === "swap" &&
      row.closedAt === null &&
      nextEntries.every(
        (candidate) =>
          candidate.swappedAt !== null && candidate.swappedBackAt === null,
      );
    await saveEntries(
      tx,
      actor.workspaceId,
      updateId,
      nextEntries,
      done ? at : undefined,
    );
    await insertAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.callerId,
      action:
        direction === "swap"
          ? "dashboard.template_swapped"
          : "dashboard.template_swapped_back",
      target: to,
      metadata: {
        requestId: row.requestId,
        updateId,
        key,
        originalId: entry.originalId,
        copyId: entry.copyId,
        devices,
      },
    });
    return openUpdateView(tx, actor.workspaceId, updateId);
  }

  return {
    /**
     * Puts an update's dashboard copy on every screen of the original in
     * one transaction (fixed scopes included, each checked against the
     * copy) and archives the original; the template record follows the
     * copy at the new version. Under the install's lock; idempotent.
     */
    swap(
      actor: Actor,
      updateId: string,
      key: string,
    ): Promise<StoreTemplateUpdate> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) => writeSwap(tx, actor, updateId, key, "swap"),
      );
    },
    /**
     * The reverse of swap: the archived original back on every screen of
     * the copy, the copy archived, the record back to the original as it
     * was. The data side rolls back through its own history.
     */
    swapBack(
      actor: Actor,
      updateId: string,
      key: string,
    ): Promise<StoreTemplateUpdate> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) => writeSwap(tx, actor, updateId, key, "back"),
      );
    },
    /**
     * Creates the updated copy of an update's dashboard once every data
     * draft of the update is published: the customer's dashboard with the
     * decisions of the apply, unassigned from screens. Under the install's
     * lock; a second call answers store_update_copy_exists.
     */
    createCopy(
      actor: Actor,
      updateId: string,
      key: string,
      /**
       * `replace`: a fresh copy instead of an unswapped one no screen shows;
       * one edited since it was made only with `discardCopyEdits`.
       */
      options: { replace?: boolean; discardCopyEdits?: boolean } = {},
    ): Promise<StoreTemplateUpdate> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) => writeCopy(tx, actor, updateId, key, options),
      );
    },
    /**
     * Closes an install's update without touching its drafts: they stay
     * ordinary drafts the customer edits, restores or publishes, and a new
     * update can be applied. Idempotent: closing a closed update is a no-op.
     */
    closeUpdate(
      actor: Actor,
      requestId: string,
      updateId: string,
    ): Promise<void> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          // The install's lock: never half-way through an apply.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('netrics.store_template'),hashtext(${actor.workspaceId + ":" + requestId}))`,
          );
          const [update] = await tx
            .select({
              id: schema.dataTemplateUpdates.id,
              closedAt: schema.dataTemplateUpdates.closedAt,
            })
            .from(schema.dataTemplateUpdates)
            .where(
              and(
                eq(schema.dataTemplateUpdates.workspaceId, actor.workspaceId),
                eq(schema.dataTemplateUpdates.requestId, requestId),
                eq(schema.dataTemplateUpdates.id, updateId),
              ),
            );
          if (!update) reject("store_template_update_not_found", 404);
          if (update.closedAt !== null) return;
          await tx
            .update(schema.dataTemplateUpdates)
            .set({ closedAt: now() })
            .where(
              and(
                eq(schema.dataTemplateUpdates.workspaceId, actor.workspaceId),
                eq(schema.dataTemplateUpdates.id, updateId),
              ),
            );
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "store_template_update.closed",
            target: updateId,
            metadata: { requestId, updateId },
          });
        },
      );
    },
    /**
     * Applies an update the customer reviewed (`basis`) with a choice for
     * every conflict and proposed removal; one serializable transaction
     * under the install's lock, so a second or concurrent apply of the same
     * plan finds the basis changed (store_update_stale).
     */
    async apply(
      actor: Actor,
      requestId: string,
      body: StoreTemplateApplyRequest,
    ): Promise<StoreTemplateUpdate> {
      await prefetchIcons(actor, requestId);
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                // The install's lock (lockInstall).
                await tx.execute(
                  sql`select pg_advisory_xact_lock(hashtext('netrics.store_template'),hashtext(${actor.workspaceId + ":" + requestId}))`,
                );
                return writeUpdate(tx, actor, requestId, body);
              },
              { isolationLevel: "serializable" },
            ),
          { retryable: isRetryableDataConflict },
        );
      } catch (error) {
        if (isDataConflict(error)) reject("version_conflict", 409);
        if (error instanceof DatasetStoreError)
          throw new DataServiceError(
            error.code,
            datasetStoreStatus(error.code),
          );
        throw error;
      }
    },
    /** The connections and app scope an install is built from. */
    scope(actor: Actor, requestId: string): Promise<StoreTemplateScope> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const install = await installRow(tx, actor.workspaceId, requestId);
          if (!install) reject("store_template_not_found", 404);
          const completion = await deriveInstallCompletion(
            tx,
            actor.workspaceId,
            requestId,
          );
          if (!completion.ok)
            reject("store_template_baseline_unavailable", 409);
          const { connections, appScope } = scopeOf(completion.inputs);
          return { requestId, connections, appScope: appScope ?? null };
        },
      );
    },
    /**
     * The plan of changing an install's app scope: the same template
     * version built from the chosen connections and app scope. What the
     * scope derives is `scope` (no conflict), the preparations of removed
     * connections are proposed for removal; read-only.
     */
    async scopePlan(
      actor: Actor,
      requestId: string,
      choice: ScopeChoice,
    ): Promise<StoreTemplatePlan> {
      await prefetchIcons(actor, requestId);
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const install = await installRow(tx, actor.workspaceId, requestId);
          if (!install) reject("store_template_not_found", 404);
          const rows = await recordRows(tx, actor.workspaceId, requestId);
          if (
            await updateToOffer(tx, actor.workspaceId, requestId, install, rows)
          )
            reject("store_template_update_available", 409);
          const computed = await planOrUnavailable(
            tx,
            actor.workspaceId,
            requestId,
            {
              inputs: await scopeInputs(
                tx,
                actor.workspaceId,
                requestId,
                choice,
                false,
              ),
            },
          );
          if (!computed) reject("store_template_baseline_unavailable", 409);
          return {
            requestId,
            fromVersion: computed.install.templateVersion,
            toVersion: computed.install.templateVersion,
            basis: computed.basis,
            summary: computed.summary,
            records: planRecords(
              computed.records.filter((record) => record.items.length > 0),
            ),
          };
        },
      );
    },
    /**
     * Changes an install's app scope like an update (apply): drafts for the
     * data the scope derives, the new connections' sources registered,
     * removed connections' records detached, the dashboard's app filter
     * through the updated copy; the stored inputs follow.
     */
    async changeScope(
      actor: Actor,
      requestId: string,
      body: StoreTemplateScopeRequest,
    ): Promise<StoreTemplateUpdate> {
      await prefetchIcons(actor, requestId);
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                await lockInstall(tx, actor.workspaceId, requestId);
                return writeUpdate(
                  tx,
                  actor,
                  requestId,
                  { basis: body.basis, decisions: body.decisions ?? [] },
                  { connections: body.connections, appScope: body.appScope },
                );
              },
              { isolationLevel: "serializable" },
            ),
          { retryable: isRetryableDataConflict },
        );
      } catch (error) {
        if (isDataConflict(error)) reject("version_conflict", 409);
        if (error instanceof DatasetStoreError)
          throw new DataServiceError(
            error.code,
            datasetStoreStatus(error.code),
          );
        throw error;
      }
    },
    list(actor: Actor): Promise<StoreTemplateInstallList> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const installs = await tx
            .select()
            .from(schema.dataTemplateInstalls)
            .where(
              and(
                eq(schema.dataTemplateInstalls.workspaceId, actor.workspaceId),
                eq(schema.dataTemplateInstalls.templateId, STORE_TEMPLATE_ID),
              ),
            )
            .orderBy(
              asc(schema.dataTemplateInstalls.createdAt),
              asc(schema.dataTemplateInstalls.requestId),
            );
          const result: StoreTemplateInstallList["installs"] = [];
          for (const install of installs) {
            const rows = await recordRows(
              tx,
              actor.workspaceId,
              install.requestId,
            );
            const live = rows.filter((row) => row.detachedAt === null);
            const idsOf = (kind: Kind) =>
              live
                .filter((row) => row.kind === kind)
                .map((row) => row.recordId);
            const computed = (await updateCandidate(
              tx,
              actor.workspaceId,
              install.requestId,
              install,
              rows,
            ))
              ? await planOrUnavailable(
                  tx,
                  actor.workspaceId,
                  install.requestId,
                  undefined,
                  false,
                  // A list never fails for one install's identity.
                  "lenient",
                )
              : undefined;
            // A plan that changes nothing is no update (#625).
            const updateAvailable =
              computed === null ||
              (computed !== undefined && changesAnything(computed.records));
            const dashboardId = idsOf("dashboard")[0];
            const [dashboard] = dashboardId
              ? await tx
                  .select({ name: schema.dashboards.name })
                  .from(schema.dashboards)
                  .where(
                    and(
                      eq(schema.dashboards.workspaceId, actor.workspaceId),
                      eq(schema.dashboards.id, dashboardId),
                    ),
                  )
              : [];
            const inputs = install.inputs as StoreTemplateInputs | null;
            const openUpdate = await openUpdateOf(
              tx,
              actor.workspaceId,
              install.requestId,
            );
            result.push({
              requestId: install.requestId,
              name: dashboard?.name ?? inputs?.name ?? "",
              templateVersion: install.templateVersion,
              latestVersion: template.version,
              updateAvailable,
              summary: updateAvailable ? (computed?.summary ?? null) : null,
              error:
                computed === null
                  ? "store_template_baseline_unavailable"
                  : null,
              dashboardIds: idsOf("dashboard"),
              modelIds: idsOf("model"),
              preparationIds: idsOf("preparation"),
              openUpdate,
              // The open update is the newest; read further only without one.
              lastUpdate:
                openUpdate ??
                (await lastUpdateOf(tx, actor.workspaceId, install.requestId)),
            });
          }
          return { installs: result };
        },
      );
    },
    async plan(actor: Actor, requestId: string): Promise<StoreTemplatePlan> {
      await prefetchIcons(actor, requestId);
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const install = await installRow(tx, actor.workspaceId, requestId);
          if (!install) reject("store_template_not_found", 404);
          const rows = await recordRows(tx, actor.workspaceId, requestId);
          if (
            !(await updateCandidate(
              tx,
              actor.workspaceId,
              requestId,
              install,
              rows,
            ))
          )
            reject("store_template_up_to_date", 409);
          const computed = await planOrUnavailable(
            tx,
            actor.workspaceId,
            requestId,
          );
          if (!computed) reject("store_template_baseline_unavailable", 409);
          if (!changesAnything(computed.records))
            reject("store_template_up_to_date", 409);
          return {
            requestId,
            fromVersion: computed.install.templateVersion,
            toVersion: template.version,
            basis: computed.basis,
            summary: computed.summary,
            records: planRecords(
              computed.records.filter((record) => record.items.length > 0),
            ),
          };
        },
      );
    },
  };
}
