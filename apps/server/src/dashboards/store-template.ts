import { z } from "zod";
import {
  SUPPORTED_LOCALES,
  type Locale,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
import {
  storeTemplateRequestSchema,
  type CreateDashboardRequest,
  type StoreTemplateRequest,
} from "@netrics/contracts";
import {
  buildStoreAppLabels,
  buildStoreAppend,
  buildStoreLabelled,
  buildStoreDashboardTemplate,
  buildStoreModel,
  buildStorePreparation,
  storeTemplateCopy,
  type StoreAppIdentity,
  type StoreConnectorId,
  type StoreMetric,
  type StoreTemplateVersion,
} from "./store-portfolio.js";

/**
 * The store portfolio template as a versioned definition: every record of an
 * install is built from stored inputs and the ids of the records created
 * before it. Changing what any version builds requires a new version (the
 * content hash in `store-template.test.ts` guards this).
 */
export const STORE_TEMPLATE_ID = "store_portfolio";
/**
 * 2: Google Play ratings come from Play Console rating reports (latest Total
 * Average Rating per app, no rating count) instead of the public listing.
 */
/**
 * 3: proceeds leave out rows without proceeds and name a missing currency
 * (#620); one app label for all three models, from the downloads data, adds
 * the store where apps of different stores share a name (#621):
 * `preparation:labels` and a `preparation:labelled:<metric>` per metric,
 * which the models read.
 */
/**
 * 4: the overview plus one slide per app (#709), each scoped to the app
 * with its icon as the slide's logo, paid and free layouts, auto advance.
 * The apps are an input (`apps`), read from the product identity (#708)
 * when an install or update is built; the data records are version 3's.
 */
/**
 * 5: the overview's model tables (#768) ask for the rows that fit their
 * tiles in every format at every theme font scale, above the footer lines
 * a measure table shows, with a shorter title where that leaves more
 * rows; downloads and ratings show their top rows (by downloads, by rating
 * count). Everything else is version 4's.
 */
/**
 * 6: a product in both stores shows both stores on its slide (#784): its
 * downloads as a total with a line per store, and Google Play's proceeds
 * per currency beside the App Store's revenue. Everything else is version
 * 5's.
 */
/**
 * 7: beside app slides the overview slide is named "Overview" (#779), not
 * after the template again, and its visitors tables list only the websites
 * the install's apps link, under a head that says "30-day total" (#787).
 * Everything else is version 6's.
 */
export const STORE_TEMPLATE_VERSION = 7;

export const storeMetrics: StoreMetric[] = ["downloads", "proceeds", "ratings"];

export const storeTemplateInputsSchema = z.object({
  name: z.string().min(1).max(100),
  locale: z.enum(SUPPORTED_LOCALES),
  /** The project new records start in (#573); null = no project. */
  projectId: z.uuid().nullable(),
  connections: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      connectorId: z.enum(["app-store-connect", "google-play"]),
      datasets: z.record(z.string(), z.string()),
    }),
  ),
  /** The value buildStoreDashboard fixes the app filter to; null = all apps. */
  fixedProduct: z.string().nullable(),
  /** Install-time product groups; seed for the mapping tables only, null for baseline installs. */
  groups: storeTemplateRequestSchema.shape.groups.unwrap().nullable(),
  /**
   * Version 4: the apps that can have a slide, in slide order, as their
   * identity was when the install or its last update was built. Missing
   * before version 4.
   */
  apps: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        paid: z.boolean(),
        icon: z.uuid().nullable(),
        appStore: z
          .object({ connectionId: z.uuid(), appId: z.string() })
          .nullable(),
        stores: z.array(z.enum(["app-store-connect", "google-play"])),
        website: z
          .object({ connectionId: z.uuid(), projectId: z.string() })
          .nullable(),
      }),
    )
    .optional(),
});
export interface StoreTemplateInputs {
  name: string;
  locale: Locale;
  projectId: string | null;
  connections: {
    id: string;
    name: string;
    connectorId: StoreConnectorId;
    datasets: Record<string, string>;
  }[];
  fixedProduct: string | null;
  groups: StoreTemplateRequest["groups"] | null;
  apps?: StoreAppIdentity[];
}
/**
 * Version 1 grammar: `preparation:source:<connectionId>:<metric>`,
 * `preparation:append:<metric>:<round>:<index>`, `model:<metric>`,
 * `dashboard:portfolio`; plus `dataset:mapping` and `dataset:products`.
 * Version 3 adds `preparation:labels` and `preparation:labelled:<metric>`.
 */
export type StoreTemplateKey = string;
export type StoreTemplateIds = Record<StoreTemplateKey, string> & {
  "dataset:mapping": string;
  "dataset:products": string;
};
export type StoreTemplateRecord =
  | {
      kind: "preparation";
      key: StoreTemplateKey;
      name: string;
      graph: PreparationGraph;
    }
  | {
      kind: "model";
      key: StoreTemplateKey;
      name: string;
      definition: SemanticModelDefinition;
    }
  | {
      kind: "dashboard";
      key: StoreTemplateKey;
      name: string;
      request: CreateDashboardRequest;
      widgetKeys: string[];
      /** Version 4: the key of each slide, in position order. */
      slideKeys?: string[];
    };
export interface StoreTemplateDefinition {
  version: number;
  /** Record keys in creation (dependency) order. */
  keys(inputs: StoreTemplateInputs): StoreTemplateKey[];
  /** One record; `ids` holds every key created before it in `keys()` order. */
  build(
    key: StoreTemplateKey,
    inputs: StoreTemplateInputs,
    ids: StoreTemplateIds,
  ): StoreTemplateRecord;
}

/** Sources per append preparation; each graph composes up to 80 inputs. */
const APPEND_WIDTH = 80;

export const sourceKey = (connectionId: string, metric: StoreMetric) =>
  `preparation:source:${connectionId}:${metric}`;
export const LABELS_KEY = "preparation:labels";
export const labelledKey = (metric: StoreMetric) =>
  `preparation:labelled:${metric}`;
export const appendKey = (metric: StoreMetric, round: number, index: number) =>
  `preparation:append:${metric}:${round}:${index}`;

function idOf(ids: StoreTemplateIds, key: StoreTemplateKey): string {
  const id = ids[key];
  if (!id) throw new Error(`store template record ${key} built before ${key}`);
  return id;
}
function isMetric(value: string | undefined): value is StoreMetric {
  return storeMetrics.includes(value as StoreMetric);
}
/** Round sizes of the combine tree: [sources, round 0 appends, ...]. */
function appendRounds(sources: number): number[] {
  const rounds: number[] = [];
  for (let count = sources; count > 1;) {
    count = Math.ceil(count / APPEND_WIDTH);
    rounds.push(count);
  }
  return rounds;
}
/**
 * The dataset references that are the inputs of `round` (round 0: the
 * per-source preparations); `round === rounds.length` yields the single
 * reference the model reads.
 */
function roundInputs(
  metric: StoreMetric,
  round: number,
  inputs: StoreTemplateInputs,
  ids: StoreTemplateIds,
): string[] {
  let level = inputs.connections.map(
    (connection) =>
      `prepared:${idOf(ids, sourceKey(connection.id, metric))}:output`,
  );
  for (let current = 0; current < round; current++) {
    const next: string[] = [];
    for (let offset = 0; offset < level.length; offset += APPEND_WIDTH) {
      const graph = buildStoreAppend(
        level.slice(offset, offset + APPEND_WIDTH),
      );
      next.push(
        `prepared:${idOf(ids, appendKey(metric, current, offset / APPEND_WIDTH))}:${graph.outputs[0]!}`,
      );
    }
    level = next;
  }
  return level;
}

/**
 * The definition of one template version. Versions 1 and 2 build the same
 * records except the Google Play ratings preparation. Version 3 changes the
 * proceeds sources and the models and adds the label preparations; the
 * dashboard stays.
 */
const defineStoreTemplate = (
  version: StoreTemplateVersion,
): StoreTemplateDefinition => ({
  version,
  keys(inputs) {
    const keys: StoreTemplateKey[] = [];
    for (const connection of inputs.connections)
      for (const metric of storeMetrics)
        keys.push(sourceKey(connection.id, metric));
    const rounds = appendRounds(inputs.connections.length);
    for (const metric of storeMetrics)
      rounds.forEach((count, round) => {
        for (let index = 0; index < count; index++)
          keys.push(appendKey(metric, round, index));
      });
    if (version >= 3) {
      keys.push(LABELS_KEY);
      for (const metric of storeMetrics) keys.push(labelledKey(metric));
    }
    for (const metric of storeMetrics) keys.push(`model:${metric}`);
    keys.push("dashboard:portfolio");
    return keys;
  },
  build(key, inputs, ids) {
    const t = storeTemplateCopy(inputs.locale),
      parts = key.split(":");
    if (parts[0] === "preparation" && parts[1] === "source") {
      const connection = inputs.connections.find(
        (candidate) => candidate.id === parts[2],
      );
      const metric = parts[3];
      if (connection && isMetric(metric) && parts.length === 4)
        return {
          kind: "preparation",
          key,
          name: `${t[metric]} · ${connection.name}`.slice(0, 100),
          graph: buildStorePreparation(
            connection,
            metric,
            ids["dataset:mapping"],
            ids["dataset:products"],
            inputs.locale,
            version,
          ),
        };
    }
    if (parts[0] === "preparation" && parts[1] === "append") {
      const metric = parts[2],
        round = Number(parts[3]),
        index = Number(parts[4]);
      const rounds = appendRounds(inputs.connections.length);
      if (
        isMetric(metric) &&
        parts.length === 5 &&
        Number.isInteger(round) &&
        Number.isInteger(index) &&
        round >= 0 &&
        round < rounds.length &&
        index >= 0 &&
        index < rounds[round]!
      ) {
        const level = roundInputs(metric, round, inputs, ids);
        return {
          kind: "preparation",
          key,
          name: t[metric].slice(0, 100),
          graph: buildStoreAppend(
            level.slice(index * APPEND_WIDTH, (index + 1) * APPEND_WIDTH),
          ),
        };
      }
    }
    /** The single combined data of a metric (before labels). */
    const combined = (metric: StoreMetric) =>
      roundInputs(
        metric,
        appendRounds(inputs.connections.length).length,
        inputs,
        ids,
      )[0]!;
    if (version >= 3 && key === LABELS_KEY)
      return {
        kind: "preparation",
        key,
        name: `${inputs.name} · ${t.appLabels}`.slice(0, 100),
        graph: buildStoreAppLabels(
          // Downloads only: a pending or failing proceeds or ratings
          // source must not hold up or fail the other models.
          [combined("downloads")],
          inputs.locale,
        ),
      };
    if (
      version >= 3 &&
      parts[0] === "preparation" &&
      parts[1] === "labelled" &&
      isMetric(parts[2]) &&
      parts.length === 3
    ) {
      const metric = parts[2];
      return {
        kind: "preparation",
        key,
        name: `${t[metric]} · ${t.appLabels}`.slice(0, 100),
        graph: buildStoreLabelled(
          metric,
          combined(metric),
          `prepared:${idOf(ids, LABELS_KEY)}:labels`,
          inputs.locale,
        ),
      };
    }
    if (parts[0] === "model" && isMetric(parts[1]) && parts.length === 2) {
      const metric = parts[1];
      const datasetId =
        version >= 3
          ? `prepared:${idOf(ids, labelledKey(metric))}:labelled`
          : combined(metric);
      return {
        kind: "model",
        key,
        name: `${inputs.name} · ${t[metric]}`.slice(0, 100),
        definition: buildStoreModel(metric, datasetId, inputs.locale, version),
      };
    }
    if (key === "dashboard:portfolio") {
      const { request, widgetKeys, slideKeys } = buildStoreDashboardTemplate(
        inputs.name,
        {
          downloads: idOf(ids, "model:downloads"),
          proceeds: idOf(ids, "model:proceeds"),
          ratings: idOf(ids, "model:ratings"),
        },
        inputs.locale,
        inputs.fixedProduct ?? undefined,
        version >= 4 ? storePortfolio(inputs) : undefined,
        version,
      );
      return {
        kind: "dashboard",
        key,
        name: inputs.name,
        request,
        widgetKeys,
        ...(slideKeys ? { slideKeys } : {}),
      };
    }
    throw new Error(`unknown store template key ${key}`);
  },
});

export const storeTemplate: StoreTemplateDefinition = defineStoreTemplate(
  STORE_TEMPLATE_VERSION,
);

/**
 * Version 1, which built every install made before versions (the baseline)
 * and every install whose dashboard original lacks its widget keys. It stays
 * frozen (`store-template.test.ts` checks its content hash).
 */
export const storeTemplateV1: StoreTemplateDefinition = defineStoreTemplate(1);
/** Version 2, frozen like version 1 (`store-template.test.ts`). */
export const storeTemplateV2: StoreTemplateDefinition = defineStoreTemplate(2);
/** Version 3, frozen like version 1 (`store-template.test.ts`). */
export const storeTemplateV3: StoreTemplateDefinition = defineStoreTemplate(3);
/** Version 4, frozen like version 1 (`store-template.test.ts`). */
export const storeTemplateV4: StoreTemplateDefinition = defineStoreTemplate(4);
/** Version 5, frozen like version 1 (`store-template.test.ts`). */
export const storeTemplateV5: StoreTemplateDefinition = defineStoreTemplate(5);
/** Version 6, frozen like version 1 (`store-template.test.ts`). */
export const storeTemplateV6: StoreTemplateDefinition = defineStoreTemplate(6);
/**
 * Version 7, frozen like version 1: the Developer Portfolio (#876) builds
 * its store preparations and models with it, whatever later versions of
 * the App Portfolio change (`developer-template.test.ts` hashes them).
 */
export const storeTemplateV7: StoreTemplateDefinition = defineStoreTemplate(7);

/** What version 4 builds the slides from: the apps and App Store accounts. */
export function storePortfolio(inputs: StoreTemplateInputs) {
  return {
    apps: inputs.apps ?? [],
    appStore: inputs.connections
      .filter((connection) => connection.connectorId === "app-store-connect")
      .map((connection) => ({ id: connection.id, name: connection.name })),
  };
}
