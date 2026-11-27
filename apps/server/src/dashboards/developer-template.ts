import { z } from "zod";
import { SUPPORTED_LOCALES, type PreparationNode } from "@netrics/domain";
import { DEVELOPER_TEMPLATE_CONNECTORS } from "@netrics/contracts";

import {
  audienceMetricsOf,
  buildDeveloperAppend,
  buildDeveloperDashboard,
  buildDeveloperModel,
  buildDeveloperPreparation,
  developerTemplateCopy,
  DEVELOPER_FAMILIES,
  DEVELOPER_PROJECT_WIDGETS,
  DEVELOPER_STORE_METRICS,
  feedsFamily,
  isStoreSource,
  projectNameOf,
  sourceDefaults,
  type DeveloperBuild,
  type DeveloperFamily,
  type DeveloperPortfolio,
  type DeveloperDefaults,
  type DeveloperProjectIdentity,
  type DeveloperSource,
  type DeveloperTemplateVersion,
} from "./developer-portfolio.js";
import {
  storeTemplateV7,
  type StoreTemplateDefinition,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateKey,
  type StoreTemplateRecord,
} from "./store-template.js";

/**
 * The Developer Portfolio template (#876) as a versioned definition, like
 * the App Portfolio's (store-template.ts): every record is built from
 * stored inputs and the ids of the records created before it, and template
 * updates (store-template-updates.ts) plan, merge and apply it the same
 * way. Changing what a version builds requires a new version
 * (`developer-template.test.ts` hashes version 1).
 *
 * Keys: `preparation:ops:<family>:<connectionId>` (a source's rows of a
 * family), `preparation:ops:<family>` (their append, with two sources or
 * more), `model:<family>`; the App Portfolio's store keys (version 7) for
 * App Store and Google Play connections; `dashboard:portfolio`; and the
 * datasets `dataset:mapping` (the resource → project links) and
 * `dataset:products` (the projects).
 */
export const DEVELOPER_TEMPLATE_ID = "developer_portfolio";
/**
 * 1: the overview and one slide per project (#876).
 * 2: a Vercel state's time is the reported state's (a build in progress
 *    since it was created); a project's name is its current workspace
 *    name unless the projects table overrides it, a seeded row no longer
 *    counting as an override (#913).
 */
export const DEVELOPER_TEMPLATE_VERSION = 2;

export const developerTemplateInputsSchema = z.object({
  name: z.string().min(1).max(100),
  locale: z.enum(SUPPORTED_LOCALES),
  /** The project new records start in; null = no project. */
  projectId: z.uuid().nullable(),
  connections: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      connectorId: z.enum(DEVELOPER_TEMPLATE_CONNECTORS),
      datasets: z.record(z.string(), z.string()),
    }),
  ),
  /** Never fixed to one project (the shared update engine's field). */
  fixedProduct: z.null().default(null),
  /** No install-time groups (the shared update engine's field). */
  groups: z.null().default(null),
  /**
   * The projects that can have a slide, in slide order, as the projects
   * and links tables said when the install or its last update was built.
   * Named `apps` like the App Portfolio's slide items, so the shared update
   * engine compares and stores them alike.
   */
  /**
   * What the workspace links by default (developer-template-service,
   * developerDefaults): read fresh for every plan, stored as built.
   */
  defaults: z
    .object({
      links: z.record(z.string(), z.string()),
      names: z.record(z.string(), z.string()),
      linked: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional(),
  /**
   * The project names the install wrote into its projects table (version
   * 2, #913; derived for an earlier install when it is updated): a row
   * still saying its seeded name is no override.
   */
  seededNames: z.record(z.string(), z.string()).optional(),
  apps: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        widgets: z.array(z.enum(DEVELOPER_PROJECT_WIDGETS)),
      }),
    )
    .optional(),
});
export interface DeveloperTemplateInputs {
  name: string;
  locale: StoreTemplateInputs["locale"];
  projectId: string | null;
  connections: DeveloperSource[];
  fixedProduct: null;
  groups: null;
  apps?: DeveloperProjectIdentity[];
  /** The workspace's default links (developerDefaults); none before them. */
  defaults?: DeveloperDefaults;
  /** The names the projects table was seeded with (version 2, #913). */
  seededNames?: Record<string, string>;
}

export const opsSourceKey = (family: DeveloperFamily, connectionId: string) =>
  `preparation:ops:${family}:${connectionId}`;
export const opsAppendKey = (family: DeveloperFamily) =>
  `preparation:ops:${family}`;

/** The developer inputs as the shared engine and store builders see them. */
export const asStoreInputs = (inputs: DeveloperTemplateInputs) =>
  inputs as unknown as StoreTemplateInputs;
export const asDeveloperInputs = (inputs: StoreTemplateInputs) =>
  inputs as unknown as DeveloperTemplateInputs;

/** The store part of the inputs, as the App Portfolio's records read it. */
function storeInputs(inputs: DeveloperTemplateInputs): StoreTemplateInputs {
  return {
    name: inputs.name,
    locale: inputs.locale,
    projectId: inputs.projectId,
    connections: inputs.connections.filter(isStoreSource).map((connection) => ({
      ...connection,
      connectorId: connection.connectorId as "app-store-connect",
    })),
    fixedProduct: null,
    groups: null,
  };
}

function idOf(ids: StoreTemplateIds, key: string): string {
  const id = ids[key];
  if (!id)
    throw new Error(`developer template record ${key} built before ${key}`);
  return id;
}

/** The sources of a family, in the inputs' order. */
const familySources = (
  inputs: DeveloperTemplateInputs,
  family: DeveloperFamily,
) =>
  inputs.connections.filter(
    (connection) =>
      !isStoreSource(connection) && feedsFamily(connection, family),
  );

/** The dataset reference a family's model reads. */
function familyDataset(
  inputs: DeveloperTemplateInputs,
  family: DeveloperFamily,
  ids: StoreTemplateIds,
): string {
  const sources = familySources(inputs, family);
  const outputs = sources.map(
    (source) => `prepared:${idOf(ids, opsSourceKey(family, source.id))}:output`,
  );
  if (outputs.length === 1) return outputs[0]!;
  const graph = buildDeveloperAppend(outputs);
  return `prepared:${idOf(ids, opsAppendKey(family))}:${graph.outputs[0]!}`;
}

/** The store keys the App Portfolio (version 7) builds, without its dashboard. */
function storeKeys(inputs: DeveloperTemplateInputs): string[] {
  const store = storeInputs(inputs);
  if (!store.connections.length) return [];
  return storeTemplateV7
    .keys(store)
    .filter((key) => key !== "dashboard:portfolio");
}

/** What the dashboard is built from: the models built and the projects. */
export function developerPortfolio(
  inputs: DeveloperTemplateInputs,
  ids: StoreTemplateIds,
): DeveloperPortfolio {
  const models: DeveloperPortfolio["models"] = {};
  for (const family of DEVELOPER_FAMILIES)
    if (familySources(inputs, family).length)
      models[family] = idOf(ids, `model:${family}`);
  if (storeInputs(inputs).connections.length)
    for (const metric of DEVELOPER_STORE_METRICS)
      models[metric] = idOf(ids, `model:${metric}`);
  return {
    models,
    projects: inputs.apps ?? [],
    audience: audienceMetricsOf(familySources(inputs, "audience")),
  };
}

/**
 * A store source preparation as this template needs it: a links-table row
 * with a blank project (the customer's unlink, #876) is the app's own
 * entry, as no row is, not one blank identity shared by every unlinked
 * app. The App Portfolio's own records stay as frozen (store-template.ts).
 */
function withBlankUnlinked(record: StoreTemplateRecord): StoreTemplateRecord {
  if (record.kind !== "preparation") return record;
  const nodes: PreparationNode[] = record.graph.nodes.map((node) =>
    node.type === "calculate" &&
    node.id === "calculate_product_id" &&
    node.fieldId === "product_id"
      ? {
          ...node,
          expression: {
            kind: "call" as const,
            fn: "if" as const,
            args: [
              {
                kind: "call" as const,
                fn: "eq" as const,
                args: [
                  {
                    kind: "call" as const,
                    fn: "coalesce" as const,
                    args: [
                      { kind: "field" as const, fieldId: "mapping.product_id" },
                      {
                        kind: "literal" as const,
                        type: "string" as const,
                        value: "",
                      },
                    ],
                  },
                  {
                    kind: "literal" as const,
                    type: "string" as const,
                    value: "",
                  },
                ],
              },
              { kind: "field" as const, fieldId: "app_key" },
              { kind: "field" as const, fieldId: "mapping.product_id" },
            ],
          },
        }
      : node,
  );
  return { ...record, graph: { ...record.graph, nodes } };
}

/**
 * A store source preparation's project name from version 2 (#913): the
 * projects table's row where it overrides, else the linked project's
 * current workspace name (projectNameOf), as the other sources name it.
 */
function withCurrentNames(
  record: StoreTemplateRecord,
  connectionId: string,
  inputs: DeveloperTemplateInputs,
  build: DeveloperBuild,
): StoreTemplateRecord {
  if (record.kind !== "preparation" || build.version < 2) return record;
  const naming = sourceDefaults({ id: connectionId }, inputs.defaults, build);
  if (
    !naming ||
    (!Object.keys(naming.names).length &&
      !Object.keys(naming.seeded ?? {}).length)
  )
    return record;
  const nodes: PreparationNode[] = record.graph.nodes.map((node) => {
    if (
      node.type !== "calculate" ||
      node.id !== "calculate_product_name" ||
      node.expression.kind !== "call" ||
      node.expression.fn !== "coalesce"
    )
      return node;
    const [row, ...rest] = node.expression.args;
    return {
      ...node,
      expression: projectNameOf(
        row!,
        { kind: "field", fieldId: "product_id" },
        naming,
        rest,
      ),
    };
  });
  return { ...record, graph: { ...record.graph, nodes } };
}

const defineDeveloperTemplate = (
  version: DeveloperTemplateVersion,
): StoreTemplateDefinition => ({
  version,
  keys(raw) {
    const inputs = asDeveloperInputs(raw);
    const keys: StoreTemplateKey[] = [];
    for (const family of DEVELOPER_FAMILIES) {
      const sources = familySources(inputs, family);
      for (const source of sources) keys.push(opsSourceKey(family, source.id));
      if (sources.length > 1) keys.push(opsAppendKey(family));
    }
    keys.push(...storeKeys(inputs));
    for (const family of DEVELOPER_FAMILIES)
      if (familySources(inputs, family).length) keys.push(`model:${family}`);
    keys.push("dashboard:portfolio");
    return keys;
  },
  build(key, raw, ids): StoreTemplateRecord {
    const inputs = asDeveloperInputs(raw);
    const t = developerTemplateCopy(inputs.locale),
      parts = key.split(":"),
      build: DeveloperBuild = {
        version,
        ...(inputs.seededNames ? { seeded: inputs.seededNames } : {}),
      };
    const datasets = {
      links: ids["dataset:mapping"],
      projects: ids["dataset:products"],
    };
    const family = parts[2] as DeveloperFamily;
    if (
      parts[0] === "preparation" &&
      parts[1] === "ops" &&
      DEVELOPER_FAMILIES.includes(family)
    ) {
      if (parts.length === 4) {
        const source = familySources(inputs, family).find(
          (candidate) => candidate.id === parts[3],
        );
        if (source)
          return {
            kind: "preparation",
            key,
            name: `${t.families[family]} · ${source.name}`.slice(0, 100),
            graph: buildDeveloperPreparation(
              source,
              family,
              datasets,
              inputs.locale,
              inputs.defaults,
              build,
            ),
          };
      }
      if (parts.length === 3) {
        const sources = familySources(inputs, family);
        if (sources.length > 1)
          return {
            kind: "preparation",
            key,
            name: `${inputs.name} · ${t.families[family]}`.slice(0, 100),
            graph: buildDeveloperAppend(
              sources.map(
                (source) =>
                  `prepared:${idOf(ids, opsSourceKey(family, source.id))}:output`,
              ),
            ),
          };
      }
    }
    if (
      parts[0] === "model" &&
      parts.length === 2 &&
      DEVELOPER_FAMILIES.includes(parts[1] as DeveloperFamily) &&
      familySources(inputs, parts[1] as DeveloperFamily).length
    ) {
      const modelFamily = parts[1] as DeveloperFamily;
      return {
        kind: "model",
        key,
        name: `${inputs.name} · ${t.families[modelFamily]}`.slice(0, 100),
        definition: buildDeveloperModel(
          modelFamily,
          familyDataset(inputs, modelFamily, ids),
          inputs.locale,
        ),
      };
    }
    if (key === "dashboard:portfolio") {
      const { request, widgetKeys, slideKeys } = buildDeveloperDashboard(
        inputs.name,
        developerPortfolio(inputs, ids),
        inputs.locale,
      );
      return {
        kind: "dashboard",
        key,
        name: inputs.name,
        request,
        widgetKeys,
        slideKeys,
      };
    }
    // The App Portfolio's records, named after this install.
    if (storeKeys(inputs).includes(key))
      return withCurrentNames(
        withBlankUnlinked(storeTemplateV7.build(key, storeInputs(inputs), ids)),
        // `preparation:source:<connectionId>:<metric>`; others name none.
        parts[0] === "preparation" && parts[1] === "source" ? parts[2]! : "",
        inputs,
        build,
      );
    throw new Error(`unknown developer template key ${key}`);
  },
});

/** Version 1 as released (#876): what earlier installs were built from. */
export const developerTemplateV1: StoreTemplateDefinition =
  defineDeveloperTemplate(1);
export const developerTemplate: StoreTemplateDefinition =
  defineDeveloperTemplate(DEVELOPER_TEMPLATE_VERSION);
