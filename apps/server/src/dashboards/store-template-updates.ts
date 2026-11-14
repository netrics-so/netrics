import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  type CreateDashboardRequest,
  type StoreTemplateInstallList,
  type StoreTemplatePlan,
} from "@netrics/contracts";
import {
  findDashboard,
  schema,
  withWorkspace,
  type Database,
  type Transaction,
} from "@netrics/database";
import type {
  Locale,
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import { DataServiceError } from "../data/service.js";
import {
  ensureInstallCompleted,
  type LegacyDashboardSnapshot,
} from "./store-template-legacy.js";
import {
  dashboardItems,
  modelItems,
  normalizeDashboard,
  normalizeLegacyDashboard,
  normalizeTemplateDashboard,
  preparationItems,
  recordKeyOf,
  type Items,
  type NormalizedDashboard,
} from "./store-template-items.js";
import {
  classify,
  summarize,
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
 * applying it. Reading only; nothing here changes a record (completing a
 * pre-version install writes its derived inputs and keys, nothing else).
 */
type Actor = { workspaceId: string; callerId: string; locale: Locale };
type RecordRow = typeof schema.dataTemplateRecords.$inferSelect;
type InstallRow = typeof schema.dataTemplateInstalls.$inferSelect;
type Kind = "preparation" | "model" | "dashboard";

function reject(code: string, status: 404 | 409): never {
  throw new DataServiceError(code, status);
}

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

export function createStoreTemplateUpdateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  /** The newest template; tests pass other versions. */
  template?: StoreTemplateDefinition;
}) {
  const template = deps.template ?? storeTemplate;

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
    const completion = await ensureInstallCompleted(tx, workspaceId, requestId);
    if (!completion.ok) return null;
    const install = (await installRow(tx, workspaceId, requestId))!;
    const inputs = completion.inputs;
    const rows = await recordRows(tx, workspaceId, requestId);
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
            (row.widgetKeys ?? {}) as Record<string, string>,
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
    for (const row of live) {
      const kind = row.kind as Kind;
      let name: string,
        version: number,
        draft = false,
        currentItems: Items;
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
        currentItems = dashboardItems(
          row.key,
          normalizeDashboard(
            dashboard,
            (row.widgetKeys ?? {}) as Record<string, string>,
            idsToKeys,
          ),
        );
      }
      seen.add(row.key);
      add(original, originalItems(row));
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

  return {
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
              // Applying an update (and so an open update) arrives with the
              // apply endpoint.
              openUpdate: null,
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
            records: computed.records
              .filter((record) => record.items.length > 0)
              // classify never lists unchanged items.
              .map(({ version: _version, items, ...record }) => ({
                ...record,
                items: items as StoreTemplatePlan["records"][number]["items"],
              })),
          };
        },
      );
    },
  };
}
