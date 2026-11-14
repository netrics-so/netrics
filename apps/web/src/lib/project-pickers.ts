import { inPickerScope, type ProjectScope } from "./project-scope";

/**
 * What each picker offers (#573): the active project's items and
 * unassigned ones, never items of archived projects; the current value
 * always stays, so an existing choice still reads (and a screen keeps its
 * dashboard). Lookups by id (names on the screens page, connection names
 * in the Studio) keep the full lists.
 */

/** Every string under `key` anywhere in a value (drafts, bindings, …). */
export function collectStrings(
  value: unknown,
  keys: readonly string[],
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, keys, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (keys.includes(key) && typeof entry === "string") into.add(entry);
      else if (keys.includes(key) && Array.isArray(entry))
        for (const item of entry) {
          if (typeof item === "string") into.add(item);
        }
      collectStrings(entry, keys, into);
    }
  }
  return into;
}

/** The models a dashboard draft binds (widgets, filter mappings). */
export function referencedModelIds(draft: unknown): Set<string> {
  return collectStrings(draft, ["modelId"]);
}

/** The datasets a preparation or model reads. */
export function referencedSourceIds(draft: unknown): Set<string> {
  return collectStrings(draft, ["datasetId", "datasets"]);
}

/** "connectionId|metricKey" of every metric a dashboard draft binds. */
export function boundMetricKeys(draft: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (
        typeof record.connectionId === "string" &&
        typeof record.metricKey === "string"
      )
        keys.add(`${record.connectionId}|${record.metricKey}`);
      Object.values(record).forEach(visit);
    }
  };
  visit(draft);
  return keys;
}

/** Metrics whose connection is in the picker scope, plus the bound ones. */
export function pickableMetrics<
  T extends { connectionId: string; key: string },
>(
  metrics: readonly T[],
  connectionProject: (connectionId: string) => string | null,
  scope: ProjectScope,
  bound: ReadonlySet<string>,
): T[] {
  return metrics.filter((metric) =>
    inPickerScope(
      connectionProject(metric.connectionId),
      scope,
      bound.has(`${metric.connectionId}|${metric.key}`),
    ),
  );
}

/** Dashboards a screen may show, keeping the one it shows now. */
export function pickableDashboards<
  T extends { id: string; projectId: string | null },
>(dashboards: readonly T[], scope: ProjectScope, current: string | null): T[] {
  return dashboards.filter((dashboard) =>
    inPickerScope(dashboard.projectId, scope, dashboard.id === current),
  );
}

/**
 * The sources a data editor offers: the picker list (loaded with
 * pickerQuery), plus the ones the item already reads from the full list.
 */
export function editorSources<T extends { id: string }>(
  picker: readonly T[],
  all: readonly T[] | null,
  referenced: ReadonlySet<string>,
): T[] {
  const listed = new Set(picker.map((source) => source.id));
  const kept = (all ?? []).filter(
    (source) => referenced.has(source.id) && !listed.has(source.id),
  );
  return [...picker, ...kept];
}

/** Whether `editorSources` needs the full list to keep a current source. */
export function missingSources(
  picker: ReadonlyArray<{ id: string }>,
  referenced: ReadonlySet<string>,
): boolean {
  const listed = new Set(picker.map((source) => source.id));
  return [...referenced].some((id) => !listed.has(id));
}
