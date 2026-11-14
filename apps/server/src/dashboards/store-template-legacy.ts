import { and, eq, inArray, sql } from "drizzle-orm";
import {
  storeTemplateResultSchema,
  type StoreTemplateResult,
} from "@netrics/contracts";
import { schema, type Transaction } from "@netrics/database";
import type {
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import type { StoreConnectorId, StoreMetric } from "./store-portfolio.js";
import {
  appendKey,
  sourceKey,
  storeMetrics,
  storeTemplateInputsSchema,
  type StoreTemplateInputs,
  type StoreTemplateKey,
} from "./store-template.js";

/**
 * Completes an install made before template versions (baseline from 0072):
 * derives the inputs it was made from and the structural key of each
 * `legacy:<id>` preparation from its first published content. The rules read
 * what version 1 built and do not depend on the current template version, so
 * they keep working after later versions ship.
 */

/** The downloads measure's name in German in version 1, frozen here. */
const GERMAN_DOWNLOADS_V1 = "Downloads und Nutzerinstallationen";

/** The dashboard as the migration stored it: rows as `to_jsonb`. */
export interface LegacyDashboardSnapshot {
  dashboard: Record<string, unknown>;
  slides: (Record<string, unknown> & {
    widgets: Record<string, unknown>[];
  })[];
}
export type LegacyCompletion =
  | {
      ok: true;
      inputs: StoreTemplateInputs;
      /** `legacy:<id>` → structural key. */
      keys: Record<string, StoreTemplateKey>;
      /** Widget id → widget key; the customer's widgets are absent. */
      widgetKeys: Record<string, string>;
    }
  | { ok: false; code: "store_template_baseline_unavailable" };

const unavailable: LegacyCompletion = {
  ok: false,
  code: "store_template_baseline_unavailable",
};
class Unavailable extends Error {}
function must<T>(value: T | null | undefined | false): T {
  if (value === null || value === undefined || value === false)
    throw new Unavailable();
  return value;
}

/** The dataset each version-1 source preparation reads, by connector and metric. */
function datasetKey(connectorId: StoreConnectorId, metric: StoreMetric) {
  if (metric === "ratings") return "store_ratings";
  if (connectorId === "app-store-connect") return "sales_rows";
  return metric === "downloads" ? "install_rows" : "earning_rows";
}
const sourceNode = (graph: PreparationGraph, id: string) => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  return node?.type === "source" ? node.datasetId : undefined;
};
const preparedId = (datasetId: string) =>
  /^prepared:([0-9a-f-]{36}):[^:]+$/.exec(datasetId)?.[1];

type Parsed =
  | { kind: "source"; connectionId: string; metric: StoreMetric; raw: string }
  | { kind: "append"; inputs: string[] };

function parseGraph(
  graph: PreparationGraph,
  result: StoreTemplateResult,
): Parsed {
  const connection = /^resources:(.+)$/.exec(
    sourceNode(graph, "resource_names") ?? "",
  )?.[1];
  if (connection) {
    const output = graph.nodes.find((node) => node.id === "output");
    must(output?.type === "select" && graph.outputs[0] === "output");
    const fields = output!.type === "select" ? output!.fields : [];
    const metric: StoreMetric = fields.includes("downloads")
      ? "downloads"
      : fields.includes("amount")
        ? "proceeds"
        : must(fields.includes("rating") && "ratings");
    must(sourceNode(graph, "mapping") === result.mappingDatasetId);
    must(sourceNode(graph, "products") === result.productDatasetId);
    return {
      kind: "source",
      connectionId: connection,
      metric,
      raw: must(sourceNode(graph, "raw")),
    };
  }
  const inputs: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === "source" && /^input_\d+$/.test(node.id))
      inputs.push(must(preparedId(node.datasetId)));
    else must(node.type === "append");
  }
  // A last chunk of one input is a pass-through append (81 sources).
  must(inputs.length > 0);
  return { kind: "append", inputs };
}

export function completeLegacyInstall(input: {
  result: StoreTemplateResult;
  preparations: { id: string; graph: PreparationGraph }[];
  models: Record<StoreMetric, SemanticModelDefinition>;
  snapshot: LegacyDashboardSnapshot | null;
  connections: {
    id: string;
    name: string;
    connectorId: StoreConnectorId;
    datasets: Record<string, string>;
  }[];
}): LegacyCompletion {
  try {
    return complete(input);
  } catch (error) {
    if (error instanceof Unavailable) return unavailable;
    throw error;
  }
}

function complete({
  result,
  preparations,
  models,
  snapshot,
  connections,
}: Parameters<typeof completeLegacyInstall>[0]): LegacyCompletion {
  const graphs = new Map(preparations.map((p) => [p.id, p.graph]));
  // Every preparation the install made still has its baseline.
  must(
    graphs.size === result.preparationIds.length &&
      result.preparationIds.every((id) => graphs.has(id)),
  );
  const parsed = new Map(
    result.preparationIds.map((id) => [
      id,
      parseGraph(graphs.get(id)!, result),
    ]),
  );

  // Connections: distinct resources:X of the source preparations, sorted
  // (the install sorted them by id).
  const sourceIds = [...parsed.values()].flatMap((p) =>
    p.kind === "source" ? [p.connectionId] : [],
  );
  const connectionIds = [...new Set(sourceIds)].sort();
  const inputsConnections = connectionIds.map((id) => {
    const connection = must(connections.find((c) => c.id === id));
    return {
      id,
      name: connection.name,
      connectorId: connection.connectorId,
      datasets: { ...connection.datasets },
    };
  });

  // Source keys; each connection has each metric exactly once.
  const keys: Record<string, StoreTemplateKey> = {},
    metricOf = new Map<string, StoreMetric>(),
    roundOf = new Map<string, number>();
  for (const [id, p] of parsed) {
    if (p.kind !== "source") continue;
    const connection = inputsConnections.find((c) => c.id === p.connectionId)!;
    const datasetKeyName = datasetKey(connection.connectorId, p.metric);
    must(
      connection.datasets[datasetKeyName] === undefined ||
        connection.datasets[datasetKeyName] === p.raw,
    );
    connection.datasets[datasetKeyName] = p.raw;
    keys[`legacy:${id}`] = sourceKey(p.connectionId, p.metric);
    metricOf.set(id, p.metric);
  }
  must(
    new Set(Object.values(keys)).size === Object.keys(keys).length &&
      Object.keys(keys).length === connectionIds.length * storeMetrics.length,
  );

  // Append keys: metric of the inputs; round = depth in the combine tree;
  // index = order within result.preparationIds per metric and round.
  const roundFor = (id: string, seen: Set<string>): number => {
    if (roundOf.has(id)) return roundOf.get(id)!;
    const p = must(parsed.get(id));
    if (p.kind === "source") return -1;
    must(!seen.has(id));
    seen.add(id);
    const round =
      1 + Math.max(...p.inputs.map((input) => roundFor(input, seen)));
    const metrics = new Set(p.inputs.map((input) => metricOf.get(input)));
    must(metrics.size === 1 && !metrics.has(undefined));
    metricOf.set(id, [...metrics][0]!);
    roundOf.set(id, round);
    return round;
  };
  const counters = new Map<string, number>();
  for (const id of result.preparationIds) {
    if (parsed.get(id)!.kind !== "append") continue;
    const round = roundFor(id, new Set()),
      metric = metricOf.get(id)!;
    const counter = `${metric}:${round}`;
    const index = counters.get(counter) ?? 0;
    counters.set(counter, index + 1);
    keys[`legacy:${id}`] = appendKey(metric, round, index);
  }

  // Each model reads the top of its metric's tree.
  for (const metric of storeMetrics) {
    const definition = must(models[metric]);
    const top = must(preparedId(definition.datasets[0] ?? ""));
    must(metricOf.get(top) === metric);
    const reads = [...parsed.entries()].filter(
      ([, p]) => p.kind === "append" && p.inputs.includes(top),
    );
    must(reads.length === 0);
  }

  // Locale from the frozen German downloads measure name.
  const downloads = models.downloads.measures.find((m) => m.id === "downloads");
  const locale = downloads?.name === GERMAN_DOWNLOADS_V1 ? "de" : "en";

  // Name, project and app scope from the dashboard as migrated.
  const dashboard = must(snapshot).dashboard;
  const filters = Array.isArray(dashboard.data_filters)
    ? (dashboard.data_filters as Record<string, unknown>[])
    : [];
  const fixed = filters.find((filter) => filter.id === "app")?.fixedValue as
    { kind?: string; values?: unknown[] } | undefined;
  const fixedProduct =
    fixed?.kind === "values" && typeof fixed.values?.[0] === "string"
      ? fixed.values[0]
      : null;

  // Widget keys: per metric, the first measure widget in reading order bound
  // to that metric's model; every other widget is the customer's.
  const widgets = [...snapshot!.slides]
    .sort((a, b) => Number(a.position) - Number(b.position))
    .flatMap((slide) =>
      [...slide.widgets].sort(
        (a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x),
      ),
    );
  const widgetKeys: Record<string, string> = {};
  for (const metric of storeMetrics) {
    const widget = widgets.find(
      (candidate) =>
        candidate.type === "measure" &&
        (candidate.model_binding as { modelId?: unknown } | null)?.modelId ===
          result.models[metric],
    );
    if (widget) widgetKeys[String(widget.id)] = `widget:${metric}`;
  }

  const parsedInputs = storeTemplateInputsSchema.safeParse({
    name: dashboard.name,
    locale,
    projectId: dashboard.project_id ?? null,
    connections: inputsConnections,
    fixedProduct,
    groups: null,
  });
  return {
    ok: true,
    inputs: must(parsedInputs.success && parsedInputs.data),
    keys,
    widgetKeys,
  };
}

/**
 * Runs completeLegacyInstall in tx and writes inputs, keys and widget keys;
 * a no-op when the install already has inputs. The install row is locked, so
 * concurrent callers complete it once.
 */
export async function ensureInstallCompleted(
  tx: Transaction,
  workspaceId: string,
  requestId: string,
): Promise<LegacyCompletion> {
  const [install] = await tx
    .select()
    .from(schema.dataTemplateInstalls)
    .where(
      and(
        eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
        eq(schema.dataTemplateInstalls.requestId, requestId),
      ),
    )
    .for("update");
  if (!install) return unavailable;
  const records = await tx
    .select()
    .from(schema.dataTemplateRecords)
    .where(
      and(
        eq(schema.dataTemplateRecords.workspaceId, workspaceId),
        eq(schema.dataTemplateRecords.requestId, requestId),
      ),
    );
  const dashboardRecord = records.find((r) => r.key === "dashboard:portfolio");
  if (install.inputs !== null)
    return {
      ok: true,
      inputs: storeTemplateInputsSchema.parse(install.inputs),
      keys: {},
      widgetKeys: (dashboardRecord?.widgetKeys ?? {}) as Record<string, string>,
    };
  const result = storeTemplateResultSchema.parse(install.result);
  const models = {} as Record<StoreMetric, SemanticModelDefinition>;
  for (const record of records) {
    const metric = /^model:(.+)$/.exec(record.key)?.[1] as
      StoreMetric | undefined;
    if (metric && storeMetrics.includes(metric))
      models[metric] = (
        record.original as { definition: SemanticModelDefinition }
      ).definition;
  }
  const snapshot =
    (
      dashboardRecord?.original as
        { legacySnapshot?: LegacyDashboardSnapshot } | null | undefined
    )?.legacySnapshot ?? null;
  const connections = await tx
    .select({
      id: schema.connections.id,
      name: schema.connections.name,
      connectorId: schema.connections.connectorId,
    })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        inArray(schema.connections.connectorId, [
          "app-store-connect",
          "google-play",
        ]),
      ),
    );
  const done = completeLegacyInstall({
    result,
    preparations: records
      .filter((r) => r.key.startsWith("legacy:") && r.kind === "preparation")
      .map((r) => ({
        id: r.recordId,
        graph: (r.original as { graph: PreparationGraph }).graph,
      })),
    models,
    snapshot,
    connections: connections.map((c) => ({
      ...c,
      connectorId: c.connectorId as StoreConnectorId,
      datasets: {},
    })),
  });
  if (!done.ok) return done;
  // The dashboard original stays `{ legacySnapshot }` here; turning it into
  // the normalized item form belongs with the normalization itself
  // (template updates, Task 5), which reads both shapes.
  for (const [legacy, key] of Object.entries(done.keys))
    await tx
      .update(schema.dataTemplateRecords)
      .set({ key })
      .where(
        and(
          eq(schema.dataTemplateRecords.workspaceId, workspaceId),
          eq(schema.dataTemplateRecords.requestId, requestId),
          eq(schema.dataTemplateRecords.key, legacy),
        ),
      );
  await tx
    .update(schema.dataTemplateRecords)
    .set({ widgetKeys: done.widgetKeys })
    .where(
      and(
        eq(schema.dataTemplateRecords.workspaceId, workspaceId),
        eq(schema.dataTemplateRecords.requestId, requestId),
        eq(schema.dataTemplateRecords.key, "dashboard:portfolio"),
      ),
    );
  await tx
    .update(schema.dataTemplateInstalls)
    .set({ inputs: done.inputs, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.dataTemplateInstalls.workspaceId, workspaceId),
        eq(schema.dataTemplateInstalls.requestId, requestId),
      ),
    );
  return done;
}
