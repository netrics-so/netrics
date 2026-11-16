import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  compareMeasureBindingSchema,
  dashboardDataFiltersSchema,
  measureWidgetBindingSchema,
  preparationGraphSchema,
  semanticModelDefinitionSchema,
  type DataImpact,
  type DataImpactTarget,
} from "@netrics/contracts";
import {
  measureDependencies,
  type SemanticModelDefinition,
} from "@netrics/domain";
import { schema, type Transaction } from "@netrics/database";

/**
 * Everything one workspace's impact checks read (11C "Impact before
 * publish"): drafts and live versions of preparations and models, the
 * model-bound widgets, the shared-filter mappings and the paired screens.
 */
export interface ImpactGraph {
  preparations: Array<{
    id: string;
    name: string;
    /** preparation ids read by the draft graph (source nodes "prepared:<id>:<out>") */
    draftReads: string[];
    /** keys of the published version's dependencies.prepared (transitive) */
    publishedReads: string[];
  }>;
  models: Array<{
    id: string;
    name: string;
    publishedVersion: number | null;
    draft: SemanticModelDefinition;
    released: SemanticModelDefinition | null;
    /** release dependencies.prepared (transitive pins) */
    releasePins: Record<string, number>;
  }>;
  widgets: Array<{
    id: string;
    dashboardId: string;
    type: string;
    title: string | null;
    modelId: string;
    measureIds: string[];
  }>;
  filterModels: Array<{ dashboardId: string; modelId: string }>;
  dashboards: Array<{ id: string; name: string }>;
  /** non-revoked devices with a dashboard */
  devices: Array<{ id: string; name: string; dashboardId: string }>;
}

type Collected = Omit<DataImpact, "hidden">;

const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;

/** JSON with sorted keys, so jsonb key order never reads as a change. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** Preparation ids a model definition reads directly. */
function preparationsRead(definition: SemanticModelDefinition | null) {
  return (definition?.datasets ?? [])
    .filter((source) => source.startsWith("prepared:"))
    .map((source) => source.split(":")[1]!);
}

/** Measures whose draft differs from the live release; null when never published. */
function changedMeasures(model: ImpactGraph["models"][number]) {
  if (!model.released) return null;
  const draft = new Map(model.draft.measures.map((m) => [m.id, stable(m)]));
  const live = new Map(model.released.measures.map((m) => [m.id, stable(m)]));
  const changed = new Set<string>();
  for (const [id, json] of draft) if (live.get(id) !== json) changed.add(id);
  for (const id of live.keys()) if (!draft.has(id)) changed.add(id);
  return [...changed].sort();
}

/** Measures of `definition` built on any of `ids`, transitively; `ids` excluded. */
function dependentMeasures(
  definition: SemanticModelDefinition,
  ids: readonly string[],
) {
  const affected = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const measure of definition.measures)
      if (
        !affected.has(measure.id) &&
        measureDependencies(measure).some((dep) => affected.has(dep))
      ) {
        affected.add(measure.id);
        grew = true;
      }
  }
  return definition.measures.filter(
    (m) => affected.has(m.id) && !ids.includes(m.id),
  );
}

/**
 * Lists what depends on `target`. Pure: the graph is one workspace's, loaded
 * by `loadImpactGraph`; redaction by the caller's capabilities is
 * `redactDataImpact`.
 */
export function collectDataImpact(
  graph: ImpactGraph,
  target: DataImpactTarget,
): Collected {
  const preparations: Collected["preparations"] = [];
  const models: Collected["models"] = [];
  let measures: Collected["measures"] = [];
  let changedMeasureIds: string[] | null = null;
  /** Affected model id → the measure ids that matter (null: all of them). */
  const affected = new Map<string, Set<string> | null>();

  if (target.kind === "preparation") {
    const reach = new Set<string>([target.id]);
    const queue = [target.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const prep of graph.preparations)
        if (
          !reach.has(prep.id) &&
          (prep.draftReads.includes(current) ||
            prep.publishedReads.includes(current))
        ) {
          reach.add(prep.id);
          queue.push(prep.id);
        }
    }
    for (const prep of graph.preparations)
      if (prep.id !== target.id && reach.has(prep.id))
        preparations.push({ id: prep.id, name: prep.name });
    for (const model of graph.models)
      if (
        [
          ...preparationsRead(model.draft),
          ...preparationsRead(model.released),
          ...Object.keys(model.releasePins),
        ].some((id) => reach.has(id))
      ) {
        models.push({
          id: model.id,
          name: model.name,
          publishedVersion: model.publishedVersion,
          pinnedVersion: model.releasePins[target.id] ?? null,
        });
        affected.set(model.id, null);
      }
  } else {
    const model = graph.models.find((m) => m.id === target.id);
    if (model) changedMeasureIds = changedMeasures(model);
    if (target.kind === "model") affected.set(target.id, null);
    else {
      const dependents = model
        ? dependentMeasures(model.draft, target.measureIds)
        : [];
      measures = dependents.map((m) => ({
        modelId: target.id,
        id: m.id,
        name: m.name,
      }));
      affected.set(
        target.id,
        new Set([...target.measureIds, ...dependents.map((m) => m.id)]),
      );
    }
  }

  const widgets = new Map<string, Collected["dashboards"][number]["widgets"]>();
  for (const widget of graph.widgets) {
    if (!affected.has(widget.modelId)) continue;
    const ids = affected.get(widget.modelId);
    if (ids && !widget.measureIds.some((id) => ids.has(id))) continue;
    const list = widgets.get(widget.dashboardId) ?? [];
    list.push({ id: widget.id, type: widget.type, title: widget.title });
    widgets.set(widget.dashboardId, list);
  }
  const viaFilter = new Set<string>();
  // A filter mapping reads the model's dimensions, never a measure.
  if (target.kind !== "measure")
    for (const { dashboardId, modelId } of graph.filterModels)
      if (affected.has(modelId) && !widgets.has(dashboardId))
        viaFilter.add(dashboardId);
  const dashboards = graph.dashboards
    .filter((d) => widgets.has(d.id) || viaFilter.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      widgets: (widgets.get(d.id) ?? []).sort((a, b) =>
        byName(
          { id: a.id, name: a.title ?? "" },
          { id: b.id, name: b.title ?? "" },
        ),
      ),
      viaFilter: !widgets.has(d.id),
    }))
    .sort(byName);
  const shown = new Set(dashboards.map((d) => d.id));
  const seen = new Set<string>();
  const screens = graph.devices
    .filter(
      (d) => shown.has(d.dashboardId) && !seen.has(d.id) && seen.add(d.id),
    )
    .map((d) => ({ id: d.id, name: d.name, dashboardId: d.dashboardId }))
    .sort(byName);

  return {
    target,
    preparations: preparations.sort(byName),
    models: models.sort(byName),
    measures: measures.sort(byName),
    dashboards,
    screens,
    changedMeasureIds,
  };
}

/**
 * What uses `target` directly, from the same graph as the publish impact:
 * preparations whose draft or live version reads it, models whose draft,
 * live release or pins read it, and for a model the dashboards bound to it
 * (a widget or a shared filter mapping). Unlike `collectDataImpact` it
 * stops at the first step: these are what must go before `target` can be
 * deleted (#671). `extraDashboards` adds dashboards the graph cannot read
 * (a widget whose binding no longer parses).
 */
export function collectDataUsers(
  graph: ImpactGraph,
  target: { kind: "preparation" | "model"; id: string },
  extraDashboards: readonly string[] = [],
): Pick<DataImpact, "preparations"> & {
  models: Array<{ id: string; name: string }>;
  dashboards: Array<{ id: string; name: string }>;
} {
  const preparations =
    target.kind === "preparation"
      ? graph.preparations
          .filter(
            (prep) =>
              prep.id !== target.id &&
              (prep.draftReads.includes(target.id) ||
                prep.publishedReads.includes(target.id)),
          )
          .map(({ id, name }) => ({ id, name }))
      : [];
  const models =
    target.kind === "preparation"
      ? graph.models
          .filter((model) =>
            [
              ...preparationsRead(model.draft),
              ...preparationsRead(model.released),
              ...Object.keys(model.releasePins),
            ].includes(target.id),
          )
          .map(({ id, name }) => ({ id, name }))
      : [];
  const bound = new Set<string>(extraDashboards);
  if (target.kind === "model") {
    for (const widget of graph.widgets)
      if (widget.modelId === target.id) bound.add(widget.dashboardId);
    for (const { dashboardId, modelId } of graph.filterModels)
      if (modelId === target.id) bound.add(dashboardId);
  }
  const dashboards = graph.dashboards
    .filter((d) => bound.has(d.id))
    .map(({ id, name }) => ({ id, name }));
  return {
    preparations: preparations.sort(byName),
    models: models.sort(byName),
    dashboards: dashboards.sort(byName),
  };
}

/** Empties the lists the caller may not open, counting them in `hidden` instead. */
export function redactDataImpact(
  impact: Collected,
  may: { data: boolean; dashboards: boolean; screens: boolean },
): DataImpact {
  // A screen names the dashboard it shows, so screens are only named
  // when the caller may also see dashboards.
  const screens = may.screens && may.dashboards;
  return {
    ...impact,
    preparations: may.data ? impact.preparations : [],
    models: may.data ? impact.models : [],
    measures: may.data ? impact.measures : [],
    dashboards: may.dashboards ? impact.dashboards : [],
    screens: screens ? impact.screens : [],
    hidden: {
      preparations: may.data ? 0 : impact.preparations.length,
      models: may.data ? 0 : impact.models.length,
      dashboards: may.dashboards ? 0 : impact.dashboards.length,
      screens: screens ? 0 : impact.screens.length,
    },
  };
}

const EMPTY_DEFINITION: SemanticModelDefinition = {
  version: 1,
  datasets: [],
  relationships: [],
  dimensions: [],
  measures: [],
};

/** Preparation ids in a `dependencies` jsonb (`{ prepared: { <id>: version } }`). */
function pins(dependencies: unknown): Record<string, number> {
  const prepared = (dependencies as { prepared?: unknown } | null)?.prepared;
  if (!prepared || typeof prepared !== "object") return {};
  return Object.fromEntries(
    Object.entries(prepared).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

/** The measure ids a model-bound widget reads; null when its binding is unreadable. */
function widgetMeasures(type: string, binding: unknown): string[] | null {
  if (type === "compare") {
    const parsed = compareMeasureBindingSchema.safeParse(binding);
    return parsed.success ? Object.values(parsed.data.measureIds) : null;
  }
  const parsed = measureWidgetBindingSchema.safeParse(binding);
  return parsed.success ? parsed.data.measureIds : null;
}

/**
 * Reads one workspace's impact graph. Runs inside `withWorkspace` (RLS) and
 * still names the workspace on every table it reads.
 */
export async function loadImpactGraph(
  tx: Transaction,
  workspaceId: string,
): Promise<ImpactGraph> {
  const prep = schema.dataPreparations,
    prepVersion = schema.dataPreparationVersions,
    model = schema.dataModels,
    release = schema.dataModelReleases,
    widget = schema.dashboardWidgets,
    dashboard = schema.dashboards,
    device = schema.devices;
  const preparationRows = await tx
    .select({
      id: prep.id,
      name: prep.name,
      graph: prep.graph,
      dependencies: prepVersion.dependencies,
    })
    .from(prep)
    .leftJoin(
      prepVersion,
      and(
        eq(prepVersion.workspaceId, workspaceId),
        eq(prepVersion.preparationId, prep.id),
        eq(prepVersion.version, prep.publishedVersion),
      ),
    )
    .where(eq(prep.workspaceId, workspaceId));
  const modelRows = await tx
    .select({
      id: model.id,
      name: model.name,
      definition: model.definition,
      publishedVersion: model.publishedVersion,
      released: release.definition,
      dependencies: release.dependencies,
    })
    .from(model)
    .leftJoin(
      release,
      and(
        eq(release.workspaceId, workspaceId),
        eq(release.modelId, model.id),
        eq(release.version, model.publishedVersion),
      ),
    )
    .where(eq(model.workspaceId, workspaceId));
  const widgetRows = await tx
    .select({
      id: widget.id,
      dashboardId: widget.dashboardId,
      type: widget.type,
      title: widget.title,
      modelId: widget.modelId,
      binding: widget.modelBinding,
    })
    .from(widget)
    .where(and(eq(widget.workspaceId, workspaceId), isNotNull(widget.modelId)));
  const dashboardRows = await tx
    .select({
      id: dashboard.id,
      name: dashboard.name,
      dataFilters: dashboard.dataFilters,
    })
    .from(dashboard)
    .where(eq(dashboard.workspaceId, workspaceId));
  const deviceRows = await tx
    .select({
      id: device.id,
      name: device.name,
      dashboardId: device.dashboardId,
    })
    .from(device)
    .where(
      and(
        eq(device.workspaceId, workspaceId),
        isNull(device.revokedAt),
        isNotNull(device.dashboardId),
      ),
    );
  return {
    preparations: preparationRows.map((row) => {
      const graph = preparationGraphSchema.safeParse(row.graph);
      return {
        id: row.id,
        name: row.name,
        draftReads: graph.success
          ? graph.data.nodes.flatMap((node) =>
              node.type === "source" && node.datasetId.startsWith("prepared:")
                ? [node.datasetId.split(":")[1]!]
                : [],
            )
          : [],
        publishedReads: Object.keys(pins(row.dependencies)),
      };
    }),
    models: modelRows.flatMap((row) => {
      const draft = semanticModelDefinitionSchema.safeParse(row.definition);
      const released =
        row.released === null
          ? null
          : semanticModelDefinitionSchema.safeParse(row.released);
      const live = released?.success ? released.data : null;
      return [
        {
          id: row.id,
          name: row.name,
          publishedVersion: row.publishedVersion,
          // A draft that no longer parses still leaves the live release
          // (and its pins) in force: read the release in its place.
          draft: draft.success ? draft.data : (live ?? EMPTY_DEFINITION),
          released: live,
          releasePins: pins(row.dependencies),
        },
      ];
    }),
    widgets: widgetRows.flatMap((row) => {
      const measureIds = widgetMeasures(row.type, row.binding);
      return measureIds && row.modelId
        ? [
            {
              id: row.id,
              dashboardId: row.dashboardId,
              type: row.type,
              title: row.title,
              modelId: row.modelId,
              measureIds,
            },
          ]
        : [];
    }),
    filterModels: dashboardRows.flatMap((row) => {
      const filters = dashboardDataFiltersSchema.safeParse(row.dataFilters);
      return filters.success
        ? filters.data.flatMap((filter) =>
            filter.mappings.map((mapping) => ({
              dashboardId: row.id,
              modelId: mapping.modelId,
            })),
          )
        : [];
    }),
    dashboards: dashboardRows.map(({ id, name }) => ({ id, name })),
    devices: deviceRows.flatMap((row) =>
      row.dashboardId
        ? [{ id: row.id, name: row.name, dashboardId: row.dashboardId }]
        : [],
    ),
  };
}
