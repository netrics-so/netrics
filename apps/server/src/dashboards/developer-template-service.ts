import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createDashboardRequestSchema,
  developerTemplateResultSchema,
  DEVELOPER_TEMPLATE_CONNECTORS,
  sourceDatasetSchema,
  type DeveloperTemplateConnector,
  type DeveloperTemplateOptions,
  type DeveloperTemplateRequest,
  type DeveloperTemplateResult,
} from "@netrics/contracts";
import {
  insertAuditEvent,
  notDraftConnection,
  registerSourceDataset,
  resolveDataPolicy,
  retryOnSerializationFailure,
  rethrowWorkspaceGone,
  resourceIsSelected,
  schema,
  withWorkspace,
  DatasetStoreError,
  hasSqlstate,
  type Database,
  type TableLocks,
  type Transaction,
} from "@netrics/database";
import {
  DEFAULT_DATA_POLICY,
  exceedsDataPolicy,
  type DataPolicy,
  type Locale,
} from "@netrics/domain";
import {
  createDataLoader,
  createDataService,
  DataServiceError,
  datasetStoreStatus,
  isDataConflict,
  isRetryableDataConflict,
} from "../data/service.js";
import {
  DEVELOPER_AUDIENCE_METRICS,
  DEVELOPER_DEFAULT_LINKS_MAX,
  developerProjectSlides,
  developerSourceDatasets,
  developerTemplateCopy,
  isStoreSource,
  type DeveloperDefaults,
  type DeveloperProjectIdentity,
  type DeveloperProjectWidget,
  type DeveloperSource,
} from "./developer-portfolio.js";
import {
  asStoreInputs,
  developerPortfolio,
  developerTemplate,
  developerTemplateInputsSchema,
  DEVELOPER_TEMPLATE_ID,
  type DeveloperTemplateInputs,
} from "./developer-template.js";
import { createDashboardService } from "./service.js";
import {
  INSTALL_LOCK,
  installedWidgetKeys,
  storeSourceDatasets,
} from "./store-template-service.js";
import type {
  StoreTemplateDefinition,
  StoreTemplateIds,
  StoreTemplateRecord,
} from "./store-template.js";

/**
 * Installing the Developer Portfolio (#876), as the App Portfolio installs
 * (store-template-service.ts): one serializable transaction under the
 * global install lock (#604, #660), one batch data service (#668), the
 * records and their originals stored for template updates.
 */

type Actor = { workspaceId: string; callerId: string; locale: Locale };
const isLockTimeout = (error: unknown) => hasSqlstate(error, "55P03");
function reject(
  code: string,
  status: 400 | 404 | 409 | 413 | 503 = 400,
): never {
  throw new DataServiceError(code, status);
}

/** Which widgets a linked resource of a connector fills on its slide. */
const CONNECTOR_WIDGETS: Record<
  DeveloperTemplateConnector,
  DeveloperProjectWidget[]
> = {
  "app-store-connect": ["downloads", "revenue", "ratings"],
  "google-play": ["downloads", "revenue", "ratings"],
  vercel: ["audience", "deploys", "costs", "state"],
  railway: ["deploys", "costs", "state"],
  "hetzner-cloud": ["costs", "state"],
  "http-check": ["state"],
  posthog: ["audience"],
  "google-search-console": ["clicks"],
};

const isTemplateConnector = (id: string): id is DeveloperTemplateConnector =>
  (DEVELOPER_TEMPLATE_CONNECTORS as readonly string[]).includes(id);

/**
 * A resource row of a connection, not a value of another dimension (a
 * Railway service or environment): the rule the resource catalog and
 * connectionHasResource use.
 */
const RESOURCE_KIND = sql`not exists (
  select 1 from metric_definitions m
  where m.connector_id = c.connector_id
    and r.kind <> 'resource'
    and m.dimensions ? r.kind
)`;
/** A resource the connection's selection keeps (resources.ts), as syncs do. */
const SELECTED = resourceIsSelected(
  sql`c.config`,
  sql`c.connector_id`,
  sql`r.resource_id`,
);

/**
 * The sources of `connectionIds` (all of the workspace, set up, of a
 * connector the template reads), each with the datasets it reads: source
 * datasets (registered with `register`, else their id or a `pending:`
 * placeholder) and, for the audience, observation datasets by
 * `metric:<key>`.
 */
export async function developerTemplateSources(
  tx: Transaction,
  deps: { registry: ConnectorRegistry; policy: DataPolicy },
  workspaceId: string,
  connectionIds: string[],
  options: { register: boolean },
): Promise<DeveloperSource[]> {
  if (!connectionIds.length) return [];
  const rows = await tx
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        notDraftConnection(),
        inArray(schema.connections.id, connectionIds),
      ),
    )
    .orderBy(asc(schema.connections.id));
  if (rows.length !== new Set(connectionIds).size)
    reject("connection_not_found", 404);
  const metricKeys = [
    ...new Set(
      Object.values(DEVELOPER_AUDIENCE_METRICS).flatMap((metrics) =>
        metrics.map((metric) => metric.key),
      ),
    ),
  ];
  const definitions = new Map(
    (
      await tx
        .select({
          id: schema.metricDefinitions.id,
          connectorId: schema.metricDefinitions.connectorId,
          key: schema.metricDefinitions.key,
        })
        .from(schema.metricDefinitions)
        .where(inArray(schema.metricDefinitions.key, metricKeys))
    ).map((row) => [`${row.connectorId}:${row.key}`, row.id]),
  );
  const sources: DeveloperSource[] = [];
  for (const row of rows) {
    if (row.setupPending) reject("connection_setup_pending", 409);
    if (!isTemplateConnector(row.connectorId))
      reject("developer_connector_required");
    const connectorId = row.connectorId;
    if (!deps.registry.get(connectorId)) reject("connector_unavailable", 503);
    const datasets = isStoreSource({ connectorId })
      ? await storeSourceDatasets(
          tx,
          deps,
          workspaceId,
          {
            id: row.id,
            connectorId: connectorId as "app-store-connect" | "google-play",
          },
          options,
        )
      : await sourceDatasets(
          tx,
          deps,
          workspaceId,
          row.id,
          connectorId,
          options,
        );
    for (const { key } of DEVELOPER_AUDIENCE_METRICS[connectorId] ?? []) {
      const metric = definitions.get(`${connectorId}:${key}`);
      if (!metric) reject("connector_unavailable", 503);
      datasets[`metric:${key}`] = `observation:${row.id}:${metric}`;
    }
    sources.push({ id: row.id, name: row.name, connectorId, datasets });
  }
  return sources;
}

/** The source datasets an operations connector's families read. */
async function sourceDatasets(
  tx: Transaction,
  deps: { registry: ConnectorRegistry; policy: DataPolicy },
  workspaceId: string,
  connectionId: string,
  connectorId: DeveloperTemplateConnector,
  options: { register: boolean },
): Promise<Record<string, string>> {
  const registered = deps.registry.get(connectorId)!;
  const datasets: Record<string, string> = {};
  for (const key of developerSourceDatasets(connectorId)) {
    const definition = registered.manifest.datasets?.find(
      (dataset) => dataset.key === key,
    );
    if (!definition) reject("developer_source_schema_unavailable", 503);
    if (options.register) {
      datasets[key] = (
        await registerSourceDataset(tx, {
          workspaceId,
          connectionId,
          definition,
          policyDefaults: deps.policy,
        })
      ).id;
      continue;
    }
    const [existing] = await tx
      .select({ id: schema.dataDatasets.id })
      .from(schema.dataDatasets)
      .where(
        and(
          eq(schema.dataDatasets.workspaceId, workspaceId),
          eq(schema.dataDatasets.connectionId, connectionId),
          eq(schema.dataDatasets.kind, "source"),
          eq(schema.dataDatasets.key, definition.key),
        ),
      );
    datasets[key] = existing?.id ?? `pending:${connectionId}:${key}`;
  }
  return datasets;
}

/**
 * The developer sources an install's inputs lack datasets of (a newer
 * version reads more), with those datasets: registered with `register`,
 * else their id or a `pending:` placeholder; a connection that no longer
 * exists stays as it is.
 */
export async function withDeveloperSourceDatasets(
  tx: Transaction,
  deps: { registry: ConnectorRegistry; policy: DataPolicy },
  workspaceId: string,
  inputs: DeveloperTemplateInputs,
  register: boolean,
): Promise<DeveloperTemplateInputs> {
  const lacking = (source: DeveloperSource) =>
    !isStoreSource(source) &&
    developerSourceDatasets(source.connectorId).some(
      (key) => source.datasets[key] === undefined,
    );
  if (!inputs.connections.some(lacking)) return inputs;
  const existing = new Set(
    (
      await tx
        .select({ id: schema.connections.id })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.workspaceId, workspaceId),
            notDraftConnection(),
            inArray(
              schema.connections.id,
              inputs.connections.filter(lacking).map((source) => source.id),
            ),
          ),
        )
    ).map((row) => row.id),
  );
  const connections: DeveloperSource[] = [];
  for (const source of inputs.connections)
    connections.push(
      lacking(source) &&
        existing.has(source.id) &&
        deps.registry.get(source.connectorId)
        ? {
            ...source,
            datasets: {
              ...(await sourceDatasets(
                tx,
                deps,
                workspaceId,
                source.id,
                source.connectorId,
                { register },
              )),
              ...source.datasets,
            },
          }
        : source,
    );
  return { ...inputs, connections };
}

/** Sources whose data is gone or not there yet read as no rows. */
const NO_DATA = new Set([
  "data_source_expired",
  "data_source_history_unavailable",
  "data_source_not_found",
]);

/** A workspace project's value in the tables, filters and slide scopes. */
const PRODUCT_PREFIX = "product:";
export const projectProduct = (projectId: string) => PRODUCT_PREFIX + projectId;

type TableRow = Record<string, unknown>;

/**
 * What the workspace links by default (owner decision C, #876): every
 * selected resource of the install's operations and analytics connections
 * that is in a project (not archived) belongs to that project, and those
 * projects' names. They are template inputs, read fresh for every plan:
 * a workspace project created since, a connection moved into a project or
 * a resource discovered later changes the source preparations, which a
 * template update offers for review (and its basis guards); applying it
 * writes nothing but those reviewed drafts. The links table holds the
 * customer's own links over them; a row with an empty project unlinks a
 * resource for good (it is never proposed again).
 *
 * Store connections have no defaults: their records are the App
 * Portfolio's, whose preparations read the links table only (an install
 * seeds it, storeDefaultLinks).
 */
/** The selected resources of connections in a project, by connection. */
async function projectResources(
  tx: Transaction,
  workspaceId: string,
  connectionIds: readonly string[],
  policy: DataPolicy,
): Promise<{
  projects: Map<string, string>;
  resources: { connectionId: string; resourceId: string; projectId: string }[];
}> {
  const projects = new Map(
    (
      await tx
        .select({ id: schema.projects.id, name: schema.projects.name })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.workspaceId, workspaceId),
            isNull(schema.projects.archivedAt),
          ),
        )
    ).map((project) => [project.id, project.name]),
  );
  if (!connectionIds.length) return { projects, resources: [] };
  const assigned = (
    await tx
      .select({
        id: schema.connections.id,
        projectId: schema.connections.projectId,
      })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          notDraftConnection(),
          inArray(schema.connections.id, [...connectionIds]),
        ),
      )
  ).filter(
    (row): row is { id: string; projectId: string } =>
      row.projectId !== null && projects.has(row.projectId),
  );
  if (!assigned.length) return { projects, resources: [] };
  const rows = await tx.execute<{
    connection_id: string;
    resource_id: string;
  }>(sql`select distinct r.connection_id, r.resource_id
    from connection_resources r
    join connections c
      on c.workspace_id = r.workspace_id and c.id = r.connection_id
    where r.workspace_id = ${workspaceId}
      and r.connection_id in (${sql.join(
        assigned.map((row) => sql`${row.id}`),
        sql`, `,
      )})
      and ${RESOURCE_KIND}
      and ${SELECTED}
    order by r.connection_id, r.resource_id
    ${policy.queryRows === null ? sql`` : sql`limit ${policy.queryRows + 1}`}`);
  if (exceedsDataPolicy(rows.length, policy.queryRows))
    reject("data_source_row_limit", 413);
  const projectOf = new Map(assigned.map((row) => [row.id, row.projectId]));
  return {
    projects,
    resources: rows.map((row) => ({
      connectionId: row.connection_id,
      resourceId: row.resource_id,
      projectId: projectOf.get(row.connection_id)!,
    })),
  };
}

/**
 * The workspace's default links of the install's non-store sources, and
 * the current names of the projects they and the links table (`links`,
 * the install's rows) link to, with the projects the table links each
 * connection's resources to (#913): a workspace rename reaches every
 * project the dashboard names. A connection with more default links than
 * one lookup holds (DEVELOPER_DEFAULT_LINKS_MAX) is refused with 413
 * `developer_default_links_limit`, and one whose resources the defaults and
 * the table link to more projects than one name lookup holds with 413
 * `developer_project_names_limit`, before anything is built.
 */
export async function developerDefaults(
  tx: Transaction,
  workspaceId: string,
  connections: readonly Pick<DeveloperSource, "id" | "connectorId">[],
  policy: DataPolicy,
  links: readonly TableRow[] = [],
): Promise<DeveloperDefaults> {
  const { projects, resources } = await projectResources(
    tx,
    workspaceId,
    connections
      .filter((connection) => !isStoreSource(connection))
      .map((connection) => connection.id),
    policy,
  );
  const defaults: DeveloperDefaults = { links: {}, names: {} };
  const counts = new Map<string, number>(),
    defaultProducts = new Map<string, Set<string>>();
  for (const resource of resources) {
    const count = (counts.get(resource.connectionId) ?? 0) + 1;
    if (count > DEVELOPER_DEFAULT_LINKS_MAX)
      reject("developer_default_links_limit", 413);
    counts.set(resource.connectionId, count);
    const product = projectProduct(resource.projectId);
    defaultProducts.set(
      resource.connectionId,
      (defaultProducts.get(resource.connectionId) ?? new Set()).add(product),
    );
    defaults.links[`${resource.connectionId}:${resource.resourceId}`] = product;
    defaults.names[product] = projects.get(resource.projectId)!;
  }
  // As the preparations join the table: an app key's first row decides.
  const installed = new Set(connections.map((connection) => connection.id));
  const linked = new Map<string, Set<string>>(),
    seen = new Set<string>();
  for (const row of links) {
    const key = typeof row.app_key === "string" ? row.app_key : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const connectionId = key.slice(0, key.indexOf(":")),
      product = typeof row.product_id === "string" ? row.product_id : "";
    const name = product.startsWith(PRODUCT_PREFIX)
      ? projects.get(product.slice(PRODUCT_PREFIX.length))
      : undefined;
    if (!installed.has(connectionId) || name === undefined) continue;
    defaults.names[product] = name;
    linked.set(
      connectionId,
      (linked.get(connectionId) ?? new Set()).add(product),
    );
  }
  if (linked.size)
    defaults.linked = Object.fromEntries(
      [...linked]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([connectionId, products]) => [
          connectionId,
          [...products].sort(),
        ]),
    );
  // Every lookup a source's preparation carries (its links, and its
  // projects' current and seeded names, which the links table can add to)
  // must fit the expression engine's JSON limit (#913).
  // (sourceDefaults: a source's names are those of its default links'
  // projects and of the projects the table links its resources to.)
  for (const connection of connections) {
    const products = new Set(linked.get(connection.id));
    for (const product of defaultProducts.get(connection.id) ?? [])
      products.add(product);
    if (products.size > DEVELOPER_DEFAULT_LINKS_MAX)
      reject("developer_project_names_limit", 413);
  }
  return defaults;
}

/**
 * The names an earlier install (version 1) seeded into its projects table
 * that a row still says, read when it is updated (#913): a row equal to its
 * project's current workspace name. A row that differs is the customer's
 * or a rename's since; it is kept as an override, so no edit is lost.
 */
async function derivedSeededNames(
  tx: Transaction,
  workspaceId: string,
  projectRows: readonly TableRow[],
): Promise<Record<string, string>> {
  const current = new Map(
    (
      await tx
        .select({ id: schema.projects.id, name: schema.projects.name })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.workspaceId, workspaceId),
            isNull(schema.projects.archivedAt),
          ),
        )
    ).map((project) => [projectProduct(project.id), project.name]),
  );
  const seeded = new Map<string, string>();
  for (const row of projectRows)
    if (
      typeof row.product_id === "string" &&
      typeof row.product_name === "string" &&
      !seeded.has(row.product_id) &&
      current.get(row.product_id) === row.product_name
    )
      seeded.set(row.product_id, row.product_name);
  return Object.fromEntries(
    [...seeded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * The links an install seeds for its store connections: their selected
 * apps that are in a project, unless the request links them itself.
 */
async function storeDefaultLinks(
  tx: Transaction,
  workspaceId: string,
  connections: readonly Pick<DeveloperSource, "id" | "connectorId">[],
  policy: DataPolicy,
): Promise<TableRow[]> {
  const { resources } = await projectResources(
    tx,
    workspaceId,
    connections.filter(isStoreSource).map((connection) => connection.id),
    policy,
  );
  return resources.map((resource) => ({
    app_key: `${resource.connectionId}:${resource.resourceId}`,
    product_id: projectProduct(resource.projectId),
  }));
}

/**
 * The projects an install's slides are built from: read in tx from its
 * projects and links tables (or as the caller just wrote them) over the
 * workspace's defaults, each project with the widgets its linked resources
 * of the install's connections fill, by name; a project nothing links has
 * no slide. The data policy's statement timeout the read sets is restored
 * after it.
 */
export function readDeveloperProjects(input: {
  connections: Pick<DeveloperSource, "id" | "connectorId">[];
  defaults: DeveloperDefaults;
  tables: { projects: TableRow[]; links: TableRow[] };
  /** The names the projects table was seeded with (version 2, #913). */
  seeded?: Record<string, string>;
}): DeveloperProjectIdentity[] {
  return developerProjectIdentities(
    input.tables,
    input.connections,
    input.defaults,
    input.seeded,
  );
}

/**
 * An install's projects and links tables, read in tx under the data
 * policy (whose statement timeout the read sets is restored after it); a
 * table that is gone or not there yet has no rows.
 */
export async function readDeveloperTables(
  tx: Transaction,
  workspaceId: string,
  result: { projectsDatasetId: string; linksDatasetId: string },
  now: Date,
  policy: DataPolicy,
): Promise<{ projects: TableRow[]; links: TableRow[] }> {
  const [timeout] = await tx.execute(
    sql`select current_setting('statement_timeout') as value`,
  );
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(policy.queryTimeoutMs ?? 0)}, true)`,
  );
  const loader = createDataLoader(tx, workspaceId, now, {
    policy,
    allowPendingResults: true,
  });
  const rows = async (datasetId: string) => {
    try {
      return (await loader.load(datasetId)).rows;
    } catch (error) {
      rethrowWorkspaceGone(error);
      if (error instanceof DataServiceError && NO_DATA.has(error.code))
        return [];
      throw error;
    }
  };
  const tables = {
    projects: await rows(result.projectsDatasetId),
    links: await rows(result.linksDatasetId),
  };
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(timeout!.value)}, true)`,
  );
  return tables;
}

/**
 * What a Developer Portfolio update reads fresh for a plan (#876, #913):
 * the install's tables, the workspace's defaults over them, the names the
 * projects table was seeded with (stored from version 2; derived for an
 * earlier install) and the projects its slides are built from.
 */
export async function readDeveloperItems(
  tx: Transaction,
  workspaceId: string,
  input: {
    result: { projectsDatasetId: string; linksDatasetId: string };
    connections: Pick<DeveloperSource, "id" | "connectorId">[];
    seededNames?: Record<string, string>;
  },
  now: Date,
  policy: DataPolicy,
  /** Whether the template builds from seeded names (version 2). */
  seeds: boolean,
): Promise<{
  defaults: DeveloperDefaults;
  seededNames?: Record<string, string>;
  apps: DeveloperProjectIdentity[];
}> {
  const tables = await readDeveloperTables(
    tx,
    workspaceId,
    input.result,
    now,
    policy,
  );
  const defaults = await developerDefaults(
    tx,
    workspaceId,
    input.connections,
    policy,
    tables.links,
  );
  const seededNames = !seeds
    ? undefined
    : (input.seededNames ??
      (await derivedSeededNames(tx, workspaceId, tables.projects)));
  return {
    defaults,
    ...(seededNames ? { seededNames } : {}),
    apps: readDeveloperProjects({
      connections: input.connections,
      defaults,
      tables,
      ...(seededNames ? { seeded: seededNames } : {}),
    }),
  };
}

/**
 * The projects with the widgets their links fill (readDeveloperProjects),
 * resolved as the preparations resolve each row: a links-table row wins
 * (an empty project unlinks), else the default link.
 */
export function developerProjectIdentities(
  tables: { projects: TableRow[]; links: TableRow[] },
  connections: Pick<DeveloperSource, "id" | "connectorId">[],
  defaults: DeveloperDefaults = { links: {}, names: {} },
  /**
   * The names the projects table was seeded with (#913): a row still
   * saying its seeded name is no override, so the project's current name
   * (the defaults') wins, as the preparations name it (projectNameOf).
   */
  seeded?: Record<string, string>,
): DeveloperProjectIdentity[] {
  const connectors = new Map(
    connections.map((connection) => [connection.id, connection.connectorId]),
  );
  // As the preparations join the table: an app key's first row decides.
  const effective = new Map<string, string>(Object.entries(defaults.links));
  const seen = new Set<string>();
  for (const link of tables.links) {
    const key = typeof link.app_key === "string" ? link.app_key : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    effective.set(
      key,
      typeof link.product_id === "string" ? link.product_id : "",
    );
  }
  const widgets = new Map<string, Set<DeveloperProjectWidget>>();
  for (const [key, project] of effective) {
    const connectorId = connectors.get(key.slice(0, key.indexOf(":")));
    if (!connectorId || !project || key.indexOf(":") < 0) continue;
    const set = widgets.get(project) ?? new Set();
    for (const widget of CONNECTOR_WIDGETS[connectorId]) set.add(widget);
    widgets.set(project, set);
  }
  const names = new Map<string, string>(Object.entries(defaults.names));
  for (const row of tables.projects)
    if (
      typeof row.product_id === "string" &&
      typeof row.product_name === "string" &&
      row.product_name.trim() &&
      !(
        seeded?.[row.product_id] === row.product_name &&
        defaults.names[row.product_id] !== undefined
      )
    )
      names.set(row.product_id, row.product_name);
  const projects: DeveloperProjectIdentity[] = [...widgets].map(
    ([productId, set]) => ({
      productId,
      name: names.get(productId) ?? productId,
      widgets: [...set].sort(),
    }),
  );
  // Projects the projects table and the defaults do not name are not
  // projects (an app key a customer typed): no slide.
  return projects
    .filter((project) => names.has(project.productId))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    );
}

function normalize(input: DeveloperTemplateRequest) {
  const connections = [...new Set(input.connections)].sort();
  const seen = new Set<string>();
  const links = [...input.links]
    .sort(
      (a, b) =>
        a.connectionId.localeCompare(b.connectionId) ||
        a.resourceId.localeCompare(b.resourceId),
    )
    .filter((link) => {
      const key = link.connectionId + ":" + link.resourceId;
      if (!connections.includes(link.connectionId) || seen.has(key))
        reject("developer_link_invalid");
      seen.add(key);
      return true;
    });
  return { ...input, connections, links };
}

export function createDeveloperTemplateService(deps: {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  policy?: DataPolicy;
  /** The template definition installs build from; tests pass others. */
  template?: StoreTemplateDefinition;
  /** Template records per insert statement; tests pass small values. */
  recordChunk?: number;
  /** The wait for the install lock; tests pass small values. */
  installLockTimeoutMs?: number;
}) {
  const now = deps.now ?? (() => new Date()),
    defaults = deps.policy ?? DEFAULT_DATA_POLICY,
    template = deps.template ?? developerTemplate,
    recordChunk = deps.recordChunk ?? 1000,
    installLock: TableLocks = {
      ...INSTALL_LOCK,
      timeoutMs: deps.installLockTimeoutMs ?? INSTALL_LOCK.timeoutMs,
    };
  return {
    options(actor: Actor): Promise<DeveloperTemplateOptions> {
      return withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        async (tx) => {
          const connections = (
            await tx
              .select({
                id: schema.connections.id,
                name: schema.connections.name,
                connectorId: schema.connections.connectorId,
                setupPending: schema.connections.setupPending,
                projectId: schema.connections.projectId,
              })
              .from(schema.connections)
              .where(
                and(
                  eq(schema.connections.workspaceId, actor.workspaceId),
                  notDraftConnection(),
                  inArray(schema.connections.connectorId, [
                    ...DEVELOPER_TEMPLATE_CONNECTORS,
                  ]),
                ),
              )
              .orderBy(asc(schema.connections.name), asc(schema.connections.id))
          ).filter((connection) => deps.registry.get(connection.connectorId));
          const { policy } = await resolveDataPolicy(
            tx,
            actor.workspaceId,
            defaults,
          );
          const resources = connections.length
            ? await tx.execute<{
                connection_id: string;
                resource_id: string;
                name: string;
              }>(sql`select r.connection_id, r.resource_id, r.name
                from connection_resources r
                join connections c
                  on c.workspace_id = r.workspace_id and c.id = r.connection_id
                where r.workspace_id = ${actor.workspaceId}
                  and r.connection_id in (${sql.join(
                    connections.map((connection) => sql`${connection.id}`),
                    sql`, `,
                  )})
                  and ${RESOURCE_KIND}
                  and ${SELECTED}
                order by r.name, r.resource_id
                ${policy.queryRows === null ? sql`` : sql`limit ${policy.queryRows + 1}`}`)
            : [];
          if (exceedsDataPolicy(resources.length, policy.queryRows))
            reject("data_source_row_limit", 413);
          const projects = await tx
            .select({ id: schema.projects.id, name: schema.projects.name })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.workspaceId, actor.workspaceId),
                isNull(schema.projects.archivedAt),
              ),
            )
            .orderBy(asc(schema.projects.name), asc(schema.projects.id));
          // Each connection's resources in one pass over the rows (in
          // their order, each resource once), not one pass per connection.
          const byConnection = new Map<
            string,
            Map<string, { id: string; name: string }>
          >();
          for (const resource of resources) {
            let own = byConnection.get(resource.connection_id);
            if (!own)
              byConnection.set(resource.connection_id, (own = new Map()));
            own.set(resource.resource_id, {
              id: resource.resource_id,
              name: resource.name,
            });
          }
          return {
            connections: connections.map((connection) => ({
              ...connection,
              connectorId: connection.connectorId as DeveloperTemplateConnector,
              resources: [...(byConnection.get(connection.id)?.values() ?? [])],
            })),
            projects,
          };
        },
      );
    },
    async install(
      actor: Actor,
      request: DeveloperTemplateRequest,
    ): Promise<DeveloperTemplateResult> {
      const input = normalize(request);
      const hash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      try {
        return await retryOnSerializationFailure(
          () =>
            withWorkspace(
              deps.db,
              { workspaceId: actor.workspaceId, userId: actor.callerId },
              async (tx) => {
                const [installed] = await tx
                  .select()
                  .from(schema.dataTemplateInstalls)
                  .where(
                    and(
                      eq(
                        schema.dataTemplateInstalls.workspaceId,
                        actor.workspaceId,
                      ),
                      eq(
                        schema.dataTemplateInstalls.requestId,
                        input.requestId,
                      ),
                    ),
                  );
                if (installed) {
                  if (
                    installed.requestHash !== hash ||
                    installed.templateId !== DEVELOPER_TEMPLATE_ID
                  )
                    reject("store_template_request_reused", 409);
                  const result = developerTemplateResultSchema.parse(
                    installed.result,
                  );
                  const [dashboard] = await tx
                    .select({ id: schema.dashboards.id })
                    .from(schema.dashboards)
                    .where(
                      and(
                        eq(schema.dashboards.workspaceId, actor.workspaceId),
                        eq(schema.dashboards.id, result.dashboardId),
                      ),
                    );
                  if (!dashboard) reject("store_template_removed", 409);
                  return result;
                }
                const sources = await developerTemplateSources(
                  tx,
                  { registry: deps.registry, policy: defaults },
                  actor.workspaceId,
                  input.connections,
                  { register: true },
                );
                const projectIds = new Set(
                  (
                    await tx
                      .select({ id: schema.projects.id })
                      .from(schema.projects)
                      .where(
                        and(
                          eq(schema.projects.workspaceId, actor.workspaceId),
                          isNull(schema.projects.archivedAt),
                        ),
                      )
                  ).map((project) => project.id),
                );
                if (input.projectId && !projectIds.has(input.projectId))
                  reject("project_not_found", 404);
                for (const link of input.links)
                  if (!projectIds.has(link.projectId))
                    reject("developer_link_invalid");
                // The explicit links, then what pendingDeveloperRows adds:
                // the workspace's projects and every resource of a
                // connection in a project (the connection's project).
                const { policy } = await resolveDataPolicy(
                  tx,
                  actor.workspaceId,
                  defaults,
                );
                const explicit = input.links.map((link) => ({
                  app_key: link.connectionId + ":" + link.resourceId,
                  product_id: projectProduct(link.projectId),
                }));
                const linked = new Set(explicit.map((row) => row.app_key));
                const storeLinks = (
                  await storeDefaultLinks(
                    tx,
                    actor.workspaceId,
                    sources,
                    policy,
                  )
                ).filter((row) => !linked.has(String(row.app_key)));
                // One batch service for the whole install (#668).
                const data = createDataService(tx, now, defaults, undefined, {
                    batch: true,
                  }),
                  t = developerTemplateCopy(actor.locale);
                const projectRows = (
                  await tx
                    .select({
                      id: schema.projects.id,
                      name: schema.projects.name,
                    })
                    .from(schema.projects)
                    .where(
                      and(
                        eq(schema.projects.workspaceId, actor.workspaceId),
                        isNull(schema.projects.archivedAt),
                      ),
                    )
                    .orderBy(asc(schema.projects.id))
                ).map((project) => ({
                  values: {
                    product_id: projectProduct(project.id),
                    product_name: project.name,
                  },
                }));
                // The request's links and the store apps' projects; the
                // other sources' projects are the defaults (inputs).
                const linkRows = [...explicit, ...storeLinks]
                  .sort((a, b) =>
                    String(a.app_key).localeCompare(String(b.app_key)),
                  )
                  .map((values) => ({ values }));
                // The defaults, and the current names of the projects
                // they and the table's rows link to (#913).
                const workspaceDefaults = await developerDefaults(
                  tx,
                  actor.workspaceId,
                  sources,
                  policy,
                  linkRows.map((row) => row.values),
                );
                // What the projects table says until the customer edits
                // it: a row still saying it is no override (#913).
                const seededNames = Object.fromEntries(
                  projectRows.map((row) => [
                    row.values.product_id,
                    row.values.product_name,
                  ]),
                );
                const projectsTable = await data.saveManual(actor, {
                  definition: sourceDatasetSchema.parse({
                    key: "developer_projects_" + input.requestId,
                    name: t.projects,
                    version: 1,
                    mode: "snapshot",
                    grain: "One workspace project the portfolio shows",
                    keyFields: ["product_id"],
                    retentionDays: null,
                    fields: [
                      {
                        id: "product_id",
                        name: t.project + " ID",
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                      {
                        id: "product_name",
                        name: t.project,
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                    ],
                  }),
                  records: projectRows,
                });
                const linksTable = await data.saveManual(actor, {
                  definition: sourceDatasetSchema.parse({
                    key: "developer_links_" + input.requestId,
                    name: t.links,
                    version: 1,
                    mode: "snapshot",
                    grain:
                      "One workspace project per source resource; unlinked resources retain their source identity",
                    keyFields: ["app_key"],
                    retentionDays: null,
                    fields: [
                      {
                        id: "app_key",
                        name: t.resource,
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                      {
                        id: "product_id",
                        name: t.project + " ID",
                        type: "string",
                        nullable: false,
                        classification: "internal",
                      },
                    ],
                  }),
                  records: linkRows,
                });
                const inputs: DeveloperTemplateInputs = {
                  name: input.name,
                  locale: actor.locale,
                  projectId: input.projectId ?? null,
                  connections: sources,
                  fixedProduct: null,
                  groups: null,
                  // As just written: not read back.
                  defaults: workspaceDefaults,
                  ...(template.version >= 2 ? { seededNames } : {}),
                  apps: readDeveloperProjects({
                    connections: sources,
                    defaults: workspaceDefaults,
                    tables: {
                      projects: projectRows.map((row) => row.values),
                      links: linkRows.map((row) => row.values),
                    },
                    ...(template.version >= 2 ? { seeded: seededNames } : {}),
                  }),
                };
                const ids = {
                  "dataset:mapping": linksTable.datasetId,
                  "dataset:products": projectsTable.datasetId,
                } as StoreTemplateIds;
                const preparationIds: string[] = [],
                  models: Record<string, string> = {},
                  built: StoreTemplateRecord[] = [];
                let dashboardId: string | undefined;
                for (const key of template.keys(asStoreInputs(inputs))) {
                  const record = template.build(
                    key,
                    asStoreInputs(inputs),
                    ids,
                  );
                  built.push(record);
                  if (record.kind === "preparation") {
                    const saved = await data.savePreparation(actor, {
                      name: record.name,
                      graph: record.graph,
                      projectId: input.projectId,
                    });
                    await data.publishPreparation(
                      actor,
                      saved.preparation.id,
                      saved.preparation.version,
                    );
                    preparationIds.push(saved.preparation.id);
                    ids[key] = saved.preparation.id;
                  } else if (record.kind === "model") {
                    const model = await data.saveModel(actor, {
                      name: record.name,
                      definition: record.definition,
                      projectId: input.projectId,
                    });
                    await data.publishModel(
                      actor,
                      model.model.id,
                      model.model.version,
                    );
                    models[key.slice("model:".length)] = model.model.id;
                    ids[key] = model.model.id;
                  } else {
                    const dashboard = await createDashboardService({
                      db: tx,
                      policy: deps.policy,
                      now: deps.now,
                    }).create(
                      actor,
                      createDashboardRequestSchema.parse({
                        ...record.request,
                        projectId: input.projectId,
                      }),
                    );
                    if (!dashboard.ok)
                      reject(
                        dashboard.error,
                        dashboard.status as 400 | 404 | 409 | 413 | 503,
                      );
                    dashboardId = dashboard.value.id;
                    ids[key] = dashboard.value.id;
                  }
                }
                if (!dashboardId)
                  throw new Error("developer template without dashboard");
                const omitted = developerProjectSlides(
                  developerPortfolio(inputs, ids),
                ).omitted;
                const result: DeveloperTemplateResult = {
                  dashboardId,
                  linksDatasetId: linksTable.datasetId,
                  projectsDatasetId: projectsTable.datasetId,
                  models,
                  preparationIds,
                  ...(omitted.length
                    ? {
                        omittedProjects: omitted.map((project) => project.name),
                      }
                    : {}),
                };
                await tx.insert(schema.dataTemplateInstalls).values({
                  workspaceId: actor.workspaceId,
                  requestId: input.requestId,
                  requestHash: hash,
                  result,
                  templateId: DEVELOPER_TEMPLATE_ID,
                  templateVersion: template.version,
                  inputs: developerTemplateInputsSchema.parse(inputs),
                  createdAt: now(),
                  updatedAt: now(),
                });
                const dashboardRecord = built.find(
                  (record) => record.kind === "dashboard",
                )!;
                const dashboardWidgetKeys = await installedWidgetKeys(
                  tx,
                  actor.workspaceId,
                  dashboardId,
                  dashboardRecord.kind === "dashboard"
                    ? dashboardRecord.widgetKeys
                    : [],
                  dashboardRecord.kind === "dashboard"
                    ? dashboardRecord.slideKeys
                    : undefined,
                );
                const recordRows: (typeof schema.dataTemplateRecords.$inferInsert)[] =
                  [
                    ...built.map((record) => ({
                      workspaceId: actor.workspaceId,
                      requestId: input.requestId,
                      key: record.key,
                      kind: record.kind,
                      recordId: ids[record.key]!,
                      templateVersion: template.version,
                      original:
                        record.kind === "preparation"
                          ? { graph: record.graph }
                          : record.kind === "model"
                            ? { definition: record.definition }
                            : {
                                request: record.request,
                                widgetKeys: record.widgetKeys,
                                ...(record.slideKeys
                                  ? { slideKeys: record.slideKeys }
                                  : {}),
                                // The projects its slides were built from.
                                apps: inputs.apps,
                              },
                      widgetKeys:
                        record.kind === "dashboard"
                          ? dashboardWidgetKeys
                          : null,
                    })),
                    ...(["dataset:mapping", "dataset:products"] as const).map(
                      (key) => ({
                        workspaceId: actor.workspaceId,
                        requestId: input.requestId,
                        key,
                        kind: "dataset",
                        recordId: ids[key],
                        templateVersion: template.version,
                        original: null,
                        widgetKeys: null,
                      }),
                    ),
                  ];
                for (
                  let offset = 0;
                  offset < recordRows.length;
                  offset += recordChunk
                )
                  await tx
                    .insert(schema.dataTemplateRecords)
                    .values(recordRows.slice(offset, offset + recordChunk));
                await insertAuditEvent(tx, {
                  workspaceId: actor.workspaceId,
                  actorUserId: actor.callerId,
                  action: "data.developer_template_installed",
                  target: dashboardId,
                  metadata: {
                    requestId: input.requestId,
                    linksDatasetId: linksTable.datasetId,
                  },
                });
                return result;
              },
              { isolationLevel: "serializable", lockTables: installLock },
            ),
          { retryable: isRetryableDataConflict },
        );
      } catch (error) {
        rethrowWorkspaceGone(error);
        if (isDataConflict(error) || isLockTimeout(error))
          reject("version_conflict", 409);
        if (error instanceof DatasetStoreError)
          reject(error.code, datasetStoreStatus(error.code));
        throw error;
      }
    },
  };
}
