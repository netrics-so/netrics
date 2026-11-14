import type { DataImpact, DataImpactTarget } from "@netrics/contracts";
import {
  measureDependencies,
  type SemanticModelDefinition,
} from "@netrics/domain";

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

/** Empties the lists the caller may not open, counting them in `hidden` instead. */
export function redactDataImpact(
  impact: Collected,
  may: { data: boolean; dashboards: boolean; screens: boolean },
): DataImpact {
  return {
    ...impact,
    preparations: may.data ? impact.preparations : [],
    models: may.data ? impact.models : [],
    measures: may.data ? impact.measures : [],
    dashboards: may.dashboards ? impact.dashboards : [],
    screens: may.screens ? impact.screens : [],
    hidden: {
      preparations: may.data ? 0 : impact.preparations.length,
      models: may.data ? 0 : impact.models.length,
      dashboards: may.dashboards ? 0 : impact.dashboards.length,
      screens: may.screens ? 0 : impact.screens.length,
    },
  };
}
