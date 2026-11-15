import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  preparationGraphSchema,
  semanticModelDefinitionSchema,
  type CreateDashboardRequest,
  type StoreTemplateApplyRequest,
  type StoreTemplateInstallList,
  type StoreTemplatePlan,
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
} from "./store-template.js";

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

function reject(code: string, status: 404 | 409): never {
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
  | { request: CreateDashboardRequest; widgetKeys?: string[] }
  /** Installs made before versions: the dashboard rows at migration time. */
  | { legacySnapshot: LegacyDashboardSnapshot }
  /** Already in comparison form (symbolic references). */
  | { normalized: NormalizedDashboard };

class BaselineUnavailable extends Error {}

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
}) {
  const template = deps.template ?? storeTemplate,
    now = deps.now ?? (() => new Date());

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
   * The three-way plan of one install against `template`; null when its
   * baseline cannot be read (store_template_baseline_unavailable).
   */
  async function computePlan(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
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
    const inputs = completion.inputs;
    const rows = (await recordRows(tx, workspaceId, requestId)).map((row) => {
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
          normalizeTemplateDashboard(original.request, keys, idsToKeys),
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
    const plan = classify(original, current, upcoming);
    const byRecord = new Map<string, PlanItem[]>();
    for (const item of plan) {
      const key = recordKeyOf(item.ref);
      byRecord.set(key, [...(byRecord.get(key) ?? []), item]);
    }
    for (const record of plans) record.items = byRecord.get(record.key) ?? [];
    const basis = createHash("sha256")
      .update(
        JSON.stringify([
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
    };
  }

  async function planOrUnavailable(
    tx: Transaction,
    workspaceId: string,
    requestId: string,
  ) {
    try {
      return await computePlan(tx, workspaceId, requestId);
    } catch (error) {
      if (error instanceof BaselineUnavailable) return null;
      throw error;
    }
  }

  /** The install's open update (none closed it yet), as the API shows it. */
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
    return row ? updateView(tx, workspaceId, row) : null;
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
    const views = drafts.flatMap((draft) => {
      const record = current.get(draft.recordId);
      if (!record) return [];
      return [
        {
          ...draft,
          name: record.name,
          published:
            record.publishedVersion !== null &&
            record.publishedVersion >= draft.version,
        },
      ];
    });
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
    if (!isUpdateAvailable(install, rows, template.version))
      reject("store_template_up_to_date", 409);
    const plan = await planOrUnavailable(tx, actor.workspaceId, requestId);
    if (!plan) reject("store_template_baseline_unavailable", 409);
    // The same plan applied twice (double click, two tabs) is stale first.
    if (plan.basis !== body.basis) reject("store_update_stale", 409);
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
        if (same(graph, current.graph)) continue;
        const { preparation } = await data.savePreparation(
          actor,
          { name: current.name, graph, version: current.version },
          current.id,
        );
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
        if (same(definition, current.definition)) continue;
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
    if (created.length)
      await tx.insert(schema.dataTemplateRecords).values(created);
    await tx
      .update(schema.dataTemplateInstalls)
      .set({ templateVersion: template.version, updatedAt: at })
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
          record.items.length > 0,
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
      action: "data.store_template_update_applied",
      target: requestId,
      metadata: {
        requestId,
        fromVersion: plan.install.templateVersion,
        toVersion: template.version,
      },
    });
    return updateView(tx, actor.workspaceId, update!);
  }

  /** The install's lock (store-template-service.ts). */
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
    const plan = await planOrUnavailable(tx, actor.workspaceId, row.requestId);
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
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                // The install's lock (store-template-service.ts).
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
            const updateAvailable = isUpdateAvailable(
              install,
              rows,
              template.version,
            );
            const computed = updateAvailable
              ? await planOrUnavailable(
                  tx,
                  actor.workspaceId,
                  install.requestId,
                )
              : undefined;
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
              summary: computed?.summary ?? null,
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
    plan(actor: Actor, requestId: string): Promise<StoreTemplatePlan> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const install = await installRow(tx, actor.workspaceId, requestId);
          if (!install) reject("store_template_not_found", 404);
          const rows = await recordRows(tx, actor.workspaceId, requestId);
          if (!isUpdateAvailable(install, rows, template.version))
            reject("store_template_up_to_date", 409);
          const computed = await planOrUnavailable(
            tx,
            actor.workspaceId,
            requestId,
          );
          if (!computed) reject("store_template_baseline_unavailable", 409);
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
