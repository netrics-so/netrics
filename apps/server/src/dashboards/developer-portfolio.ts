import { createHash } from "node:crypto";
import type {
  CreateDashboardRequest,
  DeveloperTemplateConnector,
} from "@netrics/contracts";
import {
  STUDIO_LIMITS,
  type DashboardDataFilter,
  type DataExpression,
  type Locale,
  type ModelDimension,
  type ModelMeasure,
  type PreparationGraph,
  type PreparationNode,
  type SemanticModelDefinition,
} from "@netrics/domain";

import { buildStoreAppend, type StoreMetric } from "./store-portfolio.js";

/**
 * The Developer Portfolio template's builders (#876): pure functions from
 * the install's sources to preparations, models and the dashboard, like
 * the App Portfolio's (store-portfolio.ts), whose store records it reuses.
 *
 * Operations and analytics are four families, each a preparation per
 * source connection (its rows in common columns, related to workspace
 * projects through the install's links table), one append of them, and a
 * model:
 *
 * - `state`: what is up, from Railway service states, Vercel production,
 *   Hetzner servers and HTTP checks (a state widget reads it);
 * - `deploys`: Railway deployments and Vercel production deployments, per
 *   UTC day;
 * - `costs`: this calendar month's cost per provider, effective and net of
 *   VAT (Railway as computed, Vercel's effective cost, Hetzner's net
 *   monthly price), in each provider's currency (models never convert);
 * - `audience`: Vercel Web Analytics visitors, Search Console clicks and
 *   PostHog daily and monthly active users (UTC days).
 *
 * A resource belongs to a project through the links table (`app_key`,
 * `<connectionId>:<resourceId>` → `product_id`, the project id), named by
 * the projects table (`product_id` → `product_name`): the App Portfolio's
 * table columns, so its store preparations read the same tables. A
 * resource without a link is its own entry (its key, its own name), as an
 * app without a product is in the App Portfolio.
 */

export type DeveloperFamily = "state" | "deploys" | "costs" | "audience";
export const DEVELOPER_FAMILIES: readonly DeveloperFamily[] = [
  "state",
  "deploys",
  "costs",
  "audience",
];
/** The store models the template reuses (App Portfolio's). */
export const DEVELOPER_STORE_METRICS: readonly StoreMetric[] = [
  "downloads",
  "proceeds",
  "ratings",
];

/** A source connection as the template builds from it. */
export interface DeveloperSource {
  id: string;
  name: string;
  connectorId: DeveloperTemplateConnector;
  /**
   * Source dataset ids by key, and observation datasets by `metric:<key>`
   * (`observation:<connectionId>:<metricDefinitionId>`).
   */
  datasets: Record<string, string>;
}

/**
 * The workspace's default links (developerDefaults): each selected
 * resource of a connection in a project belongs to that project unless
 * the links table says otherwise.
 */
export interface DeveloperDefaults {
  /** `<connectionId>:<resourceId>` → `product:<projectId>`. */
  links: Record<string, string>;
  /** `product:<projectId>` → the project's name. */
  names: Record<string, string>;
}

/** The widgets a project's slide can show, in reading order. */
export const DEVELOPER_PROJECT_WIDGETS = [
  "downloads",
  "revenue",
  "ratings",
  "audience",
  "clicks",
  "deploys",
  "costs",
  "state",
] as const;
export type DeveloperProjectWidget = (typeof DEVELOPER_PROJECT_WIDGETS)[number];

/**
 * A project of the install as its slide needs it, read from the projects
 * and links tables when the install or an update is built: its id (the
 * project filter's value), name and the widgets its linked resources fill.
 */
export interface DeveloperProjectIdentity {
  productId: string;
  name: string;
  widgets: DeveloperProjectWidget[];
}

const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const text = (value: string): DataExpression => ({
  kind: "literal",
  type: "string",
  value,
});
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const nullOf = (type: "string" | "timestamp" | "date"): DataExpression =>
  ({ kind: "literal", type, value: null }) as DataExpression;
const bool = (value: boolean): DataExpression => ({
  kind: "literal",
  type: "boolean",
  value,
});

export const developerTemplateCopy = (locale: Locale) =>
  locale === "de"
    ? {
        name: "Developer-Portfolio",
        overview: "Übersicht",
        links: "Projektzuordnung der Ressourcen",
        projects: "Projekte",
        resource: "Ressource",
        project: "Projekt",
        provider: "Anbieter",
        item: "Dienst",
        itemFull: "Dienst mit Projekt",
        state: "Status",
        changedAt: "Status seit",
        rolledBack: "Zurückgerollt",
        items: "Dienste",
        service: "Dienst",
        status: "Deploy-Status",
        day: "Tag (UTC)",
        createdAt: "Erstellt",
        month: "Monat",
        currency: "Währung",
        metric: "Kennzahl",
        families: {
          state: "Dienststatus",
          deploys: "Deploys",
          costs: "Kosten",
          audience: "Nutzung",
        },
        deploys: "Deploys",
        failedDeploys: "Fehlgeschlagen",
        lastDeploy: "Letzter Deploy",
        lastStatus: "Letzter Status",
        cost: "Kosten diesen Monat",
        visitors: "Besucher",
        clicks: "Suchklicks",
        dau: "Aktive Nutzer (Tag)",
        wau: "Aktive Nutzer (Woche)",
        mau: "Aktive Nutzer (Monat)",
        notHealthy: "Was nicht läuft",
        deploysToday: "Deploys heute",
        spend: "Kosten diesen Monat",
        activeUsers: "Aktive Nutzer gestern",
        usage: "Nutzung gestern",
        searchClicks: "Suchklicks, neuester Tag",
        newestDay: "Neuester Tag",
        ownNewestDay:
          "Zeigt den neuesten abgeschlossenen Tag der Search Console.",
        stateSummary: "Alle Dienste",
        latestDeploys: "Letzte Deploys",
        services: "Status",
        audience: "Gestern (UTC)",
        downloads: "Downloads (30 Tage)",
        revenue: "Erlöse (30 Tage)",
        ratings: "Bewertungen",
        noDate: "Ein Status hat keinen Tag.",
        ownPeriod: "Zeigt einen eigenen Zeitraum, nicht den des Filters.",
        noProvider: "Gilt nicht für Stores.",
        providers: {
          railway: "Railway",
          vercel: "Vercel",
          hetzner: "Hetzner Cloud",
          http: "HTTP-Check",
          posthog: "PostHog",
          search: "Search Console",
        },
      }
    : {
        name: "Developer Portfolio",
        overview: "Overview",
        links: "Resource project links",
        projects: "Projects",
        resource: "Resource",
        project: "Project",
        provider: "Provider",
        item: "Service",
        itemFull: "Service with project",
        state: "State",
        changedAt: "State since",
        rolledBack: "Rolled back",
        items: "Services",
        service: "Service",
        status: "Deploy status",
        day: "Day (UTC)",
        createdAt: "Created",
        month: "Month",
        currency: "Currency",
        metric: "Metric",
        families: {
          state: "Service state",
          deploys: "Deploys",
          costs: "Costs",
          audience: "Usage",
        },
        deploys: "Deploys",
        failedDeploys: "Failed",
        lastDeploy: "Last deploy",
        lastStatus: "Last status",
        cost: "Cost this month",
        visitors: "Visitors",
        clicks: "Search clicks",
        dau: "Daily active users",
        wau: "Weekly active users",
        mau: "Monthly active users",
        notHealthy: "What is not up",
        deploysToday: "Deploys today",
        spend: "Spend this month",
        activeUsers: "Active users yesterday",
        usage: "Usage yesterday",
        searchClicks: "Search clicks, newest day",
        newestDay: "Newest day",
        ownNewestDay: "Shows Search Console's newest finalized day.",
        stateSummary: "All services",
        latestDeploys: "Latest deploys",
        services: "State",
        audience: "Yesterday (UTC)",
        downloads: "Downloads (30 days)",
        revenue: "Revenue (30 days)",
        ratings: "Ratings",
        noDate: "A state has no day.",
        ownPeriod: "Shows a period of its own, not the filter's range.",
        noProvider: "Does not apply to stores.",
        providers: {
          railway: "Railway",
          vercel: "Vercel",
          hetzner: "Hetzner Cloud",
          http: "HTTP check",
          posthog: "PostHog",
          search: "Search Console",
        },
      };
type Copy = ReturnType<typeof developerTemplateCopy>;
type Provider = keyof Copy["providers"];

/** The provider value of a connector's rows (the provider dimension). */
const PROVIDER: Partial<Record<DeveloperTemplateConnector, Provider>> = {
  railway: "railway",
  vercel: "vercel",
  "hetzner-cloud": "hetzner",
  "http-check": "http",
  posthog: "posthog",
  "google-search-console": "search",
};

/** The observation datasets the audience family reads, per connector. */
export const DEVELOPER_AUDIENCE_METRICS: Partial<
  Record<DeveloperTemplateConnector, { key: string; metric: string }[]>
> = {
  vercel: [{ key: "vercel.visitors", metric: "visitors" }],
  "google-search-console": [
    { key: "google-search-console.clicks", metric: "clicks" },
  ],
  posthog: [
    { key: "posthog.dau", metric: "dau" },
    { key: "posthog.wau", metric: "wau" },
    { key: "posthog.mau", metric: "mau" },
  ],
};
/** The audience model's metrics, in the order widgets show them. */
export const AUDIENCE_METRICS = [
  "dau",
  "wau",
  "mau",
  "visitors",
  "clicks",
] as const;
export type AudienceMetric = (typeof AUDIENCE_METRICS)[number];
/** The audience metrics the given sources fill, in widget order. */
export function audienceMetricsOf(
  sources: readonly Pick<DeveloperSource, "connectorId">[],
): AudienceMetric[] {
  const read = new Set(
    sources.flatMap(
      (source) =>
        DEVELOPER_AUDIENCE_METRICS[source.connectorId]?.map(
          (entry) => entry.metric,
        ) ?? [],
    ),
  );
  return AUDIENCE_METRICS.filter((metric) => read.has(metric));
}

/** The source datasets each family reads, per connector. */
export const DEVELOPER_FAMILY_DATASETS: Record<
  Exclude<DeveloperFamily, "audience">,
  Partial<Record<DeveloperTemplateConnector, string>>
> = {
  state: {
    railway: "service_states",
    vercel: "production_deployments",
    "hetzner-cloud": "servers",
    "http-check": "checks",
  },
  deploys: { railway: "deployments", vercel: "deployments" },
  costs: {
    railway: "project_usage",
    vercel: "billing_charges",
    "hetzner-cloud": "cost_items",
  },
};

/** The source dataset keys an install registers for a connector. */
export function developerSourceDatasets(
  connectorId: DeveloperTemplateConnector,
): string[] {
  return [
    ...new Set(
      (["state", "deploys", "costs"] as const).flatMap((family) => {
        const key = DEVELOPER_FAMILY_DATASETS[family][connectorId];
        return key ? [key] : [];
      }),
    ),
  ];
}

/** Whether a source feeds a family (its preparation exists). */
export function feedsFamily(
  source: Pick<DeveloperSource, "connectorId">,
  family: DeveloperFamily,
): boolean {
  return family === "audience"
    ? (DEVELOPER_AUDIENCE_METRICS[source.connectorId]?.length ?? 0) > 0
    : DEVELOPER_FAMILY_DATASETS[family][source.connectorId] !== undefined;
}

export const isStoreSource = (source: Pick<DeveloperSource, "connectorId">) =>
  source.connectorId === "app-store-connect" ||
  source.connectorId === "google-play";

/** A source dataset of the connection; a placeholder until registered. */
const datasetOf = (source: DeveloperSource, key: string) =>
  source.datasets[key] ?? `pending:${source.id}:${key}`;

/** The field id an observation dataset gives its `resource` dimension. */
export const OBSERVATION_RESOURCE_FIELD =
  "dimension." + createHash("sha256").update("resource").digest("hex");

/**
 * The family's columns of one connector's rows: each a calculation over
 * the source dataset's fields. `resource` is the provider's resource id
 * (what links to a project), `resourceName` its name where the rows carry
 * one (else the connection's resource catalog names it).
 */
interface FamilySpec {
  datasetKey: string;
  filter?: DataExpression;
  resource: DataExpression;
  resourceName: DataExpression | null;
  columns: [string, string, DataExpression][];
}

function stateSpec(source: DeveloperSource, t: Copy): FamilySpec | null {
  const key = (expression: DataExpression) =>
    call("concat", text(source.id + ":"), expression);
  const common = (
    item: DataExpression,
    itemKey: DataExpression,
    changed: DataExpression,
    rolledBack: DataExpression,
  ): [string, string, DataExpression][] => [
    ["item_key", t.item + " ID", key(itemKey)],
    ["item_name", t.item, item],
    ["state", t.state, field("state")],
    ["changed_at", t.changedAt, changed],
    ["rolled_back", t.rolledBack, rolledBack],
  ];
  switch (source.connectorId) {
    case "railway":
      return {
        datasetKey: "service_states",
        resource: field("project_id"),
        resourceName: field("project_name"),
        columns: common(
          call(
            "concat",
            field("service_name"),
            text(" · "),
            field("environment_name"),
          ),
          call(
            "concat",
            field("service_id"),
            text(":"),
            field("environment_id"),
          ),
          field("latest_status_updated_at"),
          bool(false),
        ),
      };
    case "vercel":
      return {
        datasetKey: "production_deployments",
        resource: field("project_id"),
        resourceName: field("project_name"),
        columns: common(
          field("project_name"),
          field("project_id"),
          call(
            "coalesce",
            field("live_ready_at"),
            field("latest_ready_at"),
            field("latest_created_at"),
          ),
          field("rolled_back"),
        ),
      };
    case "hetzner-cloud":
      return {
        datasetKey: "servers",
        resource: field("server_id"),
        resourceName: field("name"),
        columns: common(
          field("name"),
          field("server_id"),
          nullOf("timestamp"),
          bool(false),
        ),
      };
    case "http-check":
      return {
        datasetKey: "checks",
        resource: field("check_id"),
        resourceName: field("name"),
        columns: common(
          field("name"),
          field("check_id"),
          field("last_change_at"),
          bool(false),
        ),
      };
    default:
      return null;
  }
}

function deploysSpec(source: DeveloperSource, t: Copy): FamilySpec | null {
  const common = (
    id: DeveloperSource["id"],
    service: DataExpression,
    status: string,
    serviceId: DataExpression,
  ): [string, string, DataExpression][] => [
    [
      "deploy_key",
      "Deploy ID",
      call("concat", text(id + ":"), field("deployment_id")),
    ],
    // The service's identity, qualified by its connection: two services
    // of one name stay apart; the name is its label.
    [
      "service_key",
      t.service + " ID",
      call("concat", text(id + ":"), serviceId),
    ],
    ["deploy_service", t.service, service],
    ["status", t.status, field(status)],
    ["failed", t.failedDeploys, field("failed")],
    ["created_at", t.createdAt, field("created_at")],
    // UTC days, like every other source (owner decision, #876).
    ["day", t.day, call("to_date", field("created_at"))],
  ];
  switch (source.connectorId) {
    case "railway":
      return {
        datasetKey: "deployments",
        resource: field("project_id"),
        resourceName: null,
        columns: common(
          source.id,
          call(
            "coalesce",
            field("service_name"),
            field("service_id"),
            text("—"),
          ),
          "status",
          call("coalesce", field("service_id"), field("project_id")),
        ),
      };
    case "vercel":
      return {
        datasetKey: "deployments",
        // What shipped: production deployments, not previews.
        filter: call("eq", field("target"), text("production")),
        resource: field("project_id"),
        resourceName: field("project_name"),
        columns: common(
          source.id,
          field("project_name"),
          "state",
          field("project_id"),
        ),
      };
    default:
      return null;
  }
}

function costsSpec(source: DeveloperSource, t: Copy): FamilySpec | null {
  // The calendar month's cost (owner decision, #876): effective and net
  // of VAT, in the provider's currency; `month` is a day of that month.
  const common = (
    key: DataExpression,
    amount: string,
    month: DataExpression,
  ): [string, string, DataExpression][] => [
    ["cost_key", "Cost ID", call("concat", text(source.id + ":"), key)],
    ["amount", t.cost, field(amount)],
    ["month", t.month, month],
  ];
  switch (source.connectorId) {
    case "railway":
      return {
        datasetKey: "project_usage",
        resource: field("project_id"),
        resourceName: field("project_name"),
        // Railway's usage so far this month, as computed at list prices
        // (not the billing period's estimate).
        columns: common(field("project_id"), "cost_usd", field("month")),
      };
    case "vercel":
      return {
        datasetKey: "billing_charges",
        // A team-wide charge (no project) is its team's: linkable by the
        // team ID, never one shared empty key across teams.
        resource: call(
          "if",
          call("eq", field("project_id"), text("")),
          field("team_id"),
          field("project_id"),
        ),
        resourceName: call(
          "coalesce",
          field("project_name"),
          field("team_name"),
        ),
        columns: common(
          call(
            "concat",
            field("team_id"),
            text(":"),
            field("project_id"),
            text(":"),
            field("sku_id"),
            text(":"),
            field("charge_category"),
          ),
          "effective_cost",
          field("month"),
        ),
      };
    case "hetzner-cloud":
      return {
        datasetKey: "cost_items",
        // An item Hetzner prices no longer (no price) adds nothing.
        filter: call("not", call("is_null", field("monthly_net"))),
        resource: field("resource_id"),
        resourceName: null,
        columns: common(
          call("concat", field("item_kind"), text(":"), field("item_id")),
          "monthly_net",
          // The monthly price as of the last sync: a day of this month.
          call("to_date", field("as_of")),
        ),
      };
    default:
      return null;
  }
}

/**
 * The defaults of one source: its own resources' links and their
 * projects' names, so a source's preparation changes only when its own
 * defaults do.
 */
function sourceDefaults(
  source: DeveloperSource,
  defaults: DeveloperDefaults | undefined,
): DeveloperDefaults | undefined {
  if (!defaults) return undefined;
  const links = Object.fromEntries(
    Object.entries(defaults.links)
      .filter(([key]) => key.startsWith(source.id + ":"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const names = Object.fromEntries(
    [...new Set(Object.values(links))]
      .sort()
      .flatMap((product) =>
        defaults.names[product] !== undefined
          ? [[product, defaults.names[product]!]]
          : [],
      ),
  );
  return { links, names };
}

/** `map[key]` as text (a JSON literal looked up), else `otherwise`. */
function defaultsOf(
  map: Record<string, string> | undefined,
  key: DataExpression,
  otherwise: DataExpression,
): DataExpression {
  if (!map || !Object.keys(map).length) return otherwise;
  return call(
    "coalesce",
    call(
      "to_string",
      call("json_get", { kind: "literal", type: "json", value: map }, key),
    ),
    otherwise,
  );
}

/** The nodes that relate rows to projects, after the family's columns. */
function projectNodes(
  source: DeveloperSource,
  input: string,
  resourceName: DataExpression | null,
  ids: { links: string; projects: string; defaults?: DeveloperDefaults },
  t: Copy,
): { nodes: PreparationNode[]; output: string } {
  const nodes: PreparationNode[] = [
    { id: "links", type: "source", datasetId: ids.links },
    { id: "projects", type: "source", datasetId: ids.projects },
  ];
  let current = input;
  const calculate = (
    fieldId: string,
    name: string,
    expression: DataExpression,
  ) => {
    const id = "calculate_" + fieldId.replace(/[^a-z0-9_]/g, "_");
    nodes.push({
      id,
      type: "calculate",
      input: current,
      fieldId,
      name,
      expression,
    });
    current = id;
  };
  calculate(
    "app_key",
    t.resource + " ID",
    call("concat", text(source.id + ":"), field("link_resource")),
  );
  if (!resourceName) {
    nodes.push(
      {
        id: "resource_names",
        type: "source",
        datasetId: `resources:${source.id}`,
      },
      {
        id: "names",
        type: "deduplicate",
        input: "resource_names",
        keys: ["resource_id"],
        keep: "last",
      },
      {
        id: "join_names",
        type: "join",
        left: current,
        right: "names",
        keys: [{ left: "link_resource", right: "resource_id" }],
        mode: "left",
        cardinality: "many_to_one",
        rightPrefix: "resource.",
      },
    );
    current = "join_names";
  }
  nodes.push({
    id: "join_links",
    type: "join",
    left: current,
    right: "links",
    keys: [{ left: "app_key", right: "app_key" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "link.",
  });
  current = "join_links";
  calculate(
    "product_id",
    t.project + " ID",
    // The customer's link wins; an empty one unlinks the resource for
    // good. Without one: the workspace's default, else the resource.
    call(
      "if",
      call("is_null", field("link.product_id")),
      defaultsOf(ids.defaults?.links, field("app_key"), field("app_key")),
      call(
        "if",
        call("eq", field("link.product_id"), text("")),
        field("app_key"),
        field("link.product_id"),
      ),
    ),
  );
  nodes.push({
    id: "join_projects",
    type: "join",
    left: current,
    right: "projects",
    keys: [{ left: "product_id", right: "product_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "project.",
  });
  current = "join_projects";
  calculate(
    "product_name",
    t.project,
    call(
      "coalesce",
      field("project.product_name"),
      defaultsOf(ids.defaults?.names, field("product_id"), nullOf("string")),
      resourceName ? field("link_resource_name") : field("resource.name"),
      field("link_resource"),
    ),
  );
  const provider = PROVIDER[source.connectorId]!;
  calculate("provider", t.provider + " ID", text(provider));
  calculate("provider_name", t.provider, text(t.providers[provider]));
  return { nodes, output: current };
}

/** The columns every family's rows end with. */
const PROJECT_COLUMNS = [
  "product_id",
  "product_name",
  "provider",
  "provider_name",
];

/** The output columns of a family's preparations, the same for every source. */
export function familyColumns(family: DeveloperFamily): string[] {
  switch (family) {
    case "state":
      return [
        "item_key",
        "item_name",
        "item_full",
        "state",
        "changed_at",
        "rolled_back",
        ...PROJECT_COLUMNS,
      ];
    case "deploys":
      return [
        "deploy_key",
        "service_key",
        "deploy_service",
        "status",
        "failed",
        "created_at",
        "day",
        ...PROJECT_COLUMNS,
      ];
    case "costs":
      return [
        "cost_key",
        "amount",
        "amount.currency",
        "month",
        ...PROJECT_COLUMNS,
      ];
    case "audience":
      return ["day", "metric", "quantity", "newest", ...PROJECT_COLUMNS];
  }
}

/**
 * One source connection's rows of a family, in the family's columns and
 * related to projects. Inspectable ordinary steps, like the App
 * Portfolio's.
 */
export function buildDeveloperPreparation(
  source: DeveloperSource,
  family: DeveloperFamily,
  ids: { links: string; projects: string; defaults?: DeveloperDefaults },
  locale: Locale,
  /** The workspace's default links; none: the links table alone. */
  defaults?: DeveloperDefaults,
): PreparationGraph {
  const t = developerTemplateCopy(locale);
  const own = sourceDefaults(source, defaults);
  if (family === "audience")
    return audiencePreparation(source, { ...ids, defaults: own }, t);
  ids = { ...ids, defaults: own };
  const spec =
    family === "state"
      ? stateSpec(source, t)
      : family === "deploys"
        ? deploysSpec(source, t)
        : costsSpec(source, t);
  if (!spec)
    throw new Error(`no ${family} rows of a ${source.connectorId} source`);
  const nodes: PreparationNode[] = [
    {
      id: "raw",
      type: "source",
      datasetId: datasetOf(source, spec.datasetKey),
    },
  ];
  let current = "raw";
  if (spec.filter) {
    nodes.push({
      id: "rows",
      type: "filter",
      input: current,
      expression: spec.filter,
    });
    current = "rows";
  }
  const columns: [string, string, DataExpression][] = [
    ...spec.columns,
    ["link_resource", t.resource + " ID", call("to_string", spec.resource)],
    ...(spec.resourceName
      ? ([["link_resource_name", t.resource, spec.resourceName]] as [
          string,
          string,
          DataExpression,
        ][])
      : []),
  ];
  for (const [fieldId, name, expression] of columns) {
    // A column the source already has under that id stays as it is.
    if (expression.kind === "field" && expression.fieldId === fieldId) continue;
    const id = "column_" + fieldId;
    nodes.push({
      id,
      type: "calculate",
      input: current,
      fieldId,
      name,
      expression,
    });
    current = id;
  }
  const related = projectNodes(source, current, spec.resourceName, ids, t);
  nodes.push(...related.nodes);
  current = related.output;
  if (family === "state") {
    // The overview lists every project's items: each named with its
    // project, so two projects' "api · production" stay apart.
    nodes.push({
      id: "column_item_full",
      type: "calculate",
      input: current,
      fieldId: "item_full",
      name: t.itemFull,
      expression: call(
        "concat",
        field("product_name"),
        text(" · "),
        field("item_name"),
      ),
    });
    current = "column_item_full";
  }
  nodes.push({
    id: "output",
    type: "select",
    input: current,
    fields: familyColumns(family),
  });
  return { version: 1, nodes, outputs: ["output"] };
}

/**
 * Vercel visitors, Search Console clicks and PostHog active users of one
 * connection: its observation datasets' daily rows (UTC days) per
 * resource, each tagged with its metric. The model reads them for one
 * complete day (yesterday, UTC): active users are never a sum of days.
 */
function audiencePreparation(
  source: DeveloperSource,
  ids: { links: string; projects: string; defaults?: DeveloperDefaults },
  t: Copy,
): PreparationGraph {
  const metrics = DEVELOPER_AUDIENCE_METRICS[source.connectorId];
  if (!metrics?.length)
    throw new Error(`no audience rows of a ${source.connectorId} source`);
  const nodes: PreparationNode[] = [];
  const tagged: string[] = [];
  for (const { key, metric } of metrics) {
    const prefix = metric;
    nodes.push({
      id: `${prefix}_raw`,
      type: "source",
      datasetId: datasetOf(source, `metric:${key}`),
    });
    let current = `${prefix}_raw`;
    for (const [fieldId, name, expression] of [
      ["day", t.day, field("time")],
      ["metric", t.metric, text(metric)],
      ["quantity", t.metric, call("to_decimal", field("value"))],
      [
        "link_resource",
        t.resource + " ID",
        call("coalesce", field(OBSERVATION_RESOURCE_FIELD), text("")),
      ],
    ] as [string, string, DataExpression][]) {
      const id = `${prefix}_${fieldId}`;
      nodes.push({
        id,
        type: "calculate",
        input: current,
        fieldId,
        name,
        expression,
      });
      current = id;
    }
    nodes.push({
      id: `${prefix}_rows`,
      type: "select",
      input: current,
      fields: ["day", "metric", "quantity", "link_resource"],
    });
    tagged.push(`${prefix}_rows`);
  }
  let current = tagged[0]!;
  if (tagged.length > 1) {
    nodes.push({ id: "metrics", type: "append", inputs: tagged });
    current = "metrics";
  }
  // The connection's newest reported day per metric: Search Console
  // finalizes its days two to three days late, so its clicks are read for
  // that day, not for yesterday (#876 review).
  nodes.push(
    {
      id: "newest",
      type: "group",
      input: current,
      keys: ["metric"],
      aggregates: [
        { id: "newest_day", name: t.day, op: "max", fieldId: "day" },
      ],
    },
    {
      id: "join_newest",
      type: "join",
      left: current,
      right: "newest",
      keys: [{ left: "metric", right: "metric" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "newest.",
    },
    {
      id: "column_newest",
      type: "calculate",
      input: "join_newest",
      fieldId: "newest",
      name: t.newestDay,
      expression: call(
        "coalesce",
        call("eq", field("day"), field("newest.newest_day")),
        bool(false),
      ),
    },
  );
  current = "column_newest";
  const related = projectNodes(source, current, null, ids, t);
  nodes.push(...related.nodes, {
    id: "output",
    type: "select",
    input: related.output,
    fields: familyColumns("audience"),
  });
  return { version: 1, nodes, outputs: ["output"] };
}

/** A family's sources appended into one (up to 80 inputs, as the store's). */
export const buildDeveloperAppend = buildStoreAppend;

/** The model of a family over its appended data. */
export function buildDeveloperModel(
  family: DeveloperFamily,
  datasetId: string,
  locale: Locale,
): SemanticModelDefinition {
  const t = developerTemplateCopy(locale);
  const dimension = (
    id: string,
    name: string,
    fieldId: string,
    extra: Partial<ModelDimension> = {},
  ): ModelDimension => ({ id, name, datasetId, fieldId, ...extra });
  const dimensions: ModelDimension[] = [
    dimension("project", t.project, "product_id", {
      labelFieldId: "product_name",
    }),
    dimension("provider", t.provider, "provider", {
      labelFieldId: "provider_name",
    }),
  ];
  const aggregate = (
    id: string,
    name: string,
    op: "count" | "sum" | "max" | "last",
    fieldId?: string,
    extra: { filter?: DataExpression; orderBy?: string } = {},
    requiredDimensions?: string[],
  ): ModelMeasure => ({
    id,
    name,
    kind: "aggregate",
    datasetId,
    ...(requiredDimensions ? { requiredDimensions } : {}),
    aggregate: {
      id,
      name,
      op,
      ...(fieldId ? { fieldId } : {}),
      ...extra,
    },
  });
  let measures: ModelMeasure[];
  if (family === "state") {
    dimensions.push(
      // The item's identity, named by its label: two items of one name
      // stay apart.
      dimension("item", t.item, "item_key", { labelFieldId: "item_name" }),
      dimension("item_full", t.itemFull, "item_key", {
        labelFieldId: "item_full",
      }),
      dimension("state", t.state, "state"),
      dimension("changed_at", t.changedAt, "changed_at", {
        timeAlignment: "instant",
      }),
      dimension("rolled_back", t.rolledBack, "rolled_back"),
    );
    measures = [aggregate("items", t.items, "count")];
  } else if (family === "deploys") {
    dimensions.push(
      dimension("service", t.service, "service_key", {
        labelFieldId: "deploy_service",
      }),
      dimension("status", t.status, "status"),
      dimension("day", t.day, "day", { timeAlignment: "reporting_date" }),
      dimension("created_at", t.createdAt, "created_at", {
        timeAlignment: "instant",
      }),
    );
    measures = [
      aggregate("deploys", t.deploys, "count"),
      aggregate("failed_deploys", t.failedDeploys, "count", undefined, {
        filter: call("eq", field("failed"), bool(true)),
      }),
      aggregate("last_deploy", t.lastDeploy, "max", "created_at"),
      aggregate("last_status", t.lastStatus, "last", "status", {
        orderBy: "created_at",
      }),
    ];
  } else if (family === "costs") {
    dimensions.push(
      dimension("day", t.month, "month", { timeAlignment: "reporting_date" }),
      dimension("currency", t.currency, "amount.currency"),
    );
    // Currencies never add up: grouped by currency or fixed to one.
    measures = [aggregate("cost", t.cost, "sum", "amount", {}, ["currency"])];
  } else {
    dimensions.push(
      dimension("day", t.day, "day", { timeAlignment: "reporting_date" }),
      dimension("metric", t.metric, "metric"),
    );
    // Per metric, the sum over the query's days: the widgets read one
    // complete UTC day (yesterday, owner decision #876), so active users
    // are summed over projects, never over days.
    measures = [
      ...AUDIENCE_METRICS.map((metric) =>
        aggregate(metric, t[metric], "sum", "quantity", {
          filter: call("eq", field("metric"), text(metric)),
        }),
      ),
      // Search Console's newest reported day, and that day's clicks.
      aggregate("clicks_newest", t.clicks, "sum", "quantity", {
        filter: call(
          "and",
          call("eq", field("metric"), text("clicks")),
          call("eq", field("newest"), bool(true)),
        ),
      }),
      aggregate("clicks_day", t.newestDay, "max", "day", {
        filter: call("eq", field("metric"), text("clicks")),
      }),
    ];
  }
  return {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions,
    measures,
  };
}

/** What the dashboard is built from. */
export interface DeveloperPortfolio {
  /** The family and store models the install has (absent: no source). */
  models: Partial<Record<DeveloperFamily | StoreMetric, string>>;
  /** Every project that can have a slide, in slide order. */
  projects: DeveloperProjectIdentity[];
  /** The audience metrics the install's sources fill. */
  audience: AudienceMetric[];
}

/** A short stable key of a project's slide and widgets. */
export const projectSlideKey = (productId: string) =>
  "project-" +
  createHash("sha256").update(productId).digest("hex").slice(0, 16);

/** The widgets a project's slide shows: those its models can fill. */
export function projectSlideWidgets(
  project: DeveloperProjectIdentity,
  portfolio: Pick<DeveloperPortfolio, "models" | "audience">,
): DeveloperProjectWidget[] {
  const { models } = portfolio;
  const model: Record<DeveloperProjectWidget, DeveloperFamily | StoreMetric> = {
    downloads: "downloads",
    revenue: "proceeds",
    ratings: "ratings",
    audience: "audience",
    clicks: "audience",
    deploys: "deploys",
    costs: "costs",
    state: "state",
  };
  const fills = (widget: DeveloperProjectWidget) =>
    widget === "audience"
      ? USAGE_METRICS.some((metric) => portfolio.audience.includes(metric))
      : widget === "clicks"
        ? portfolio.audience.includes("clicks")
        : true;
  const widgets = DEVELOPER_PROJECT_WIDGETS.filter(
    (widget) =>
      project.widgets.includes(widget) &&
      models[model[widget]] &&
      fills(widget),
  );
  // Two rows of three numbers fit beside the state list: past them, the
  // newest clicks (on the overview too), then the ratings stay out.
  for (const dropped of ["clicks", "ratings"] as const)
    if (widgets.filter((widget) => widget !== "state").length > 6)
      widgets.splice(
        widgets.indexOf(dropped),
        widgets.includes(dropped) ? 1 : 0,
      );
  return widgets;
}

/** Yesterday's usage the usage widgets show, as the sources fill them. */
const USAGE_METRICS: readonly AudienceMetric[] = [
  "dau",
  "wau",
  "mau",
  "visitors",
];

/**
 * The overview's numbers beside the state widgets, in reading order: four
 * fit beside them (two rows of two), six without them (two rows of
 * three); past that, downloads, then the newest clicks stay out.
 */
function overviewNumbers(
  portfolio: Pick<DeveloperPortfolio, "models" | "audience">,
): ("deploys" | "costs" | "audience" | "clicks" | "downloads")[] {
  const { models } = portfolio;
  const numbers = (
    ["deploys", "costs", "audience", "clicks", "downloads"] as const
  ).filter((kind) =>
    kind === "audience"
      ? models.audience &&
        USAGE_METRICS.some((metric) => portfolio.audience.includes(metric))
      : kind === "clicks"
        ? models.audience && portfolio.audience.includes("clicks")
        : models[kind],
  );
  const room = models.state ? 4 : 6;
  for (const dropped of ["downloads", "clicks"] as const)
    if (numbers.length > room && numbers.includes(dropped))
      numbers.splice(numbers.indexOf(dropped), 1);
  return numbers;
}

/** The overview's widgets: the two state widgets and its numbers. */
function overviewWidgets(
  portfolio: Pick<DeveloperPortfolio, "models" | "audience">,
) {
  return [
    ...(portfolio.models.state ? ["summary", "list"] : []),
    ...overviewNumbers(portfolio),
  ];
}

/**
 * The projects that get a slide: the first ones with a widget, in order,
 * while the dashboard stays within the Studio's limits (12 slides, 48 data
 * widgets, the overview included); the rest are `omitted` and show in the
 * overview only.
 */
export function developerProjectSlides(portfolio: DeveloperPortfolio): {
  shown: DeveloperProjectIdentity[];
  omitted: DeveloperProjectIdentity[];
} {
  let cost = Math.max(1, overviewWidgets(portfolio).length);
  const shown: DeveloperProjectIdentity[] = [],
    omitted: DeveloperProjectIdentity[] = [];
  for (const project of portfolio.projects) {
    const widgets = projectSlideWidgets(project, portfolio).length;
    if (!widgets) continue;
    if (
      omitted.length === 0 &&
      shown.length < STUDIO_LIMITS.slides - 1 &&
      cost + widgets <= STUDIO_LIMITS.dataWidgets
    ) {
      shown.push(project);
      cost += widgets;
    } else omitted.push(project);
  }
  return { shown, omitted };
}

type Slide = NonNullable<CreateDashboardRequest["slides"]>[number];
type Widget = Slide["widgets"][number];
type Unplaced = Widget extends infer W
  ? W extends unknown
    ? Omit<W, "x" | "y" | "w" | "h">
    : never
  : never;
type Placed = { key: string; widget: Widget };
type Entry = { key: string; widget: Unplaced };

/** One row of widgets over the grid's width, the first ones wider. */
function row(entries: Entry[], y: number, h: number, x0 = 0, width = 12) {
  const count = entries.length,
    base = Math.floor(width / count),
    extra = width - base * count;
  let x = x0;
  return entries.map(({ key, widget }, index): Placed => {
    const w = index < extra ? base + 1 : base;
    const placed = { key, widget: { ...widget, x, y, w, h } as Widget };
    x += w;
    return placed;
  });
}

/** Rows of at most three widgets sharing the slide's height. */
function rows(groups: Entry[][], heights?: number[]): Placed[] {
  const filled = groups.filter((group) => group.length);
  const split = heights ?? filled.map(() => Math.floor(8 / filled.length));
  let y = 0;
  return filled.flatMap((group, index) => {
    const h = split[index]!;
    const placed = row(group, y, h);
    y += h;
    return placed;
  });
}

/**
 * The dashboard: the overview (what is not up, deploys today, spend this
 * month, active users), then one slide per project with a widget, scoped
 * to it. Every widget reads a model, so the dashboard's filters (project,
 * provider, day) work on every slide.
 */
export function buildDeveloperDashboard(
  name: string,
  portfolio: DeveloperPortfolio,
  locale: Locale,
): {
  request: CreateDashboardRequest;
  widgetKeys: string[];
  slideKeys: string[];
} {
  const t = developerTemplateCopy(locale);
  const { models } = portfolio;
  const families = (["state", "deploys", "costs", "audience"] as const).filter(
    (family) => models[family],
  );
  const stores = DEVELOPER_STORE_METRICS.filter((metric) => models[metric]);
  const mapping = (dimensionId: string, ids: (string | undefined)[]) =>
    ids.flatMap((modelId) => (modelId ? [{ modelId, dimensionId }] : []));
  const filters: DashboardDataFilter[] = [
    {
      id: "project",
      name: t.project,
      type: "string",
      mode: "values",
      mappings: [
        ...mapping(
          "project",
          families.map((family) => models[family]),
        ),
        // The store models' product is the linked project (or the app).
        ...mapping(
          "app",
          stores.map((metric) => models[metric]),
        ),
      ],
      defaultValue: null,
    },
    {
      id: "provider",
      name: t.provider,
      type: "string",
      mode: "values",
      mappings: [
        ...mapping(
          "provider",
          families.map((family) => models[family]),
        ),
        ...mapping(
          "store",
          stores.map((metric) => models[metric]),
        ),
      ],
      defaultValue: null,
    },
    {
      id: "day",
      name: t.day,
      type: "date",
      mode: "range",
      mappings: [
        ...mapping(
          "day",
          (["deploys", "costs", "audience"] as const).map(
            (family) => models[family],
          ),
        ),
        ...mapping(
          "day",
          stores.map((metric) => models[metric]),
        ),
      ],
      defaultValue: null,
    },
  ];
  const ownPeriod = { filterId: "day", reason: t.ownPeriod };
  const measure = (
    modelId: string,
    title: string,
    groupBy: string[],
    measureIds: string[],
    options: {
      view: "value" | "table";
      limit: number;
      period?: "today" | "this_month" | "last_30_days";
      /** The template's own rows are dated in UTC (#876). */
      periodTimeZone?: "UTC";
      /** "previous": yesterday, the last complete day. */
      periodWindow?: "previous";
      order?: { measureId: string; direction: "asc" | "desc" };
    },
    filter?: DataExpression,
    /** A window of its own without a period (Search Console's newest day). */
    own?: { filterId: string; reason: string },
  ): Unplaced => ({
    type: "measure",
    title,
    binding: {
      modelId,
      groupBy,
      measureIds,
      ...(filter ? { filter } : {}),
      exclusions: options.period ? [ownPeriod] : own ? [own] : [],
    },
    options,
  });
  const newestDay = { filterId: "day", reason: t.ownNewestDay };
  // Yesterday's usage the sources fill (UTC), and Search Console's
  // clicks of its newest finalized day with that day beside them.
  const usage = USAGE_METRICS.filter((metric) =>
    portfolio.audience.includes(metric),
  );
  const usageWidget = (groupBy: string[], limit: number): Unplaced =>
    measure(
      models.audience!,
      groupBy.length
        ? usage.includes("dau")
          ? t.activeUsers
          : t.usage
        : t.audience,
      groupBy,
      usage,
      {
        view: "table",
        limit,
        period: "today",
        periodWindow: "previous",
        periodTimeZone: "UTC",
        ...(groupBy.length
          ? { order: { measureId: usage[0]!, direction: "desc" as const } }
          : {}),
      },
      // The usage metrics' rows only: clicks are a widget of their own.
      call("in", field("metric"), {
        kind: "literal",
        type: "json",
        value: usage,
      }),
    );
  const clicksWidget = (groupBy: string[], limit: number): Unplaced =>
    measure(
      models.audience!,
      t.searchClicks,
      groupBy,
      ["clicks_newest", "clicks_day"],
      { view: "table", limit },
      // Search Console's rows only: a project without them has no row.
      call("eq", field("metric"), text("clicks")),
      newestDay,
    );
  const state = (
    dimension: "item" | "item_full",
    limit: number,
    layout: "list" | "single" = "list",
  ): Unplaced => ({
    type: "state",
    title:
      layout === "single"
        ? t.stateSummary
        : dimension === "item_full"
          ? t.notHealthy
          : t.services,
    binding: {
      modelId: models.state!,
      nameDimensionId: dimension,
      stateDimensionId: "state",
      changedAtDimensionId: "changed_at",
      rolledBackDimensionId: "rolled_back",
      exclusions: [{ filterId: "day", reason: t.noDate }],
    },
    options: {
      layout,
      item: null,
      limit,
      showChanged: true,
      states: {},
    },
  });

  // ── Overview ──────────────────────────────────────────────────────────
  const overview: Entry[] = [];
  const numbers = overviewNumbers(portfolio);
  if (numbers.includes("deploys") && models.deploys)
    overview.push({
      key: "widget:deploys",
      widget: measure(
        models.deploys,
        t.deploysToday,
        ["provider"],
        ["deploys", "failed_deploys"],
        { view: "table", limit: 5, period: "today", periodTimeZone: "UTC" },
      ),
    });
  if (numbers.includes("costs") && models.costs)
    overview.push({
      key: "widget:costs",
      widget: measure(
        models.costs,
        t.spend,
        ["provider", "currency"],
        ["cost"],
        {
          view: "table",
          limit: 6,
          period: "this_month",
          periodTimeZone: "UTC",
        },
      ),
    });
  if (numbers.includes("audience"))
    overview.push({
      key: "widget:audience",
      widget: usageWidget(["project"], 6),
    });
  if (numbers.includes("clicks"))
    overview.push({
      key: "widget:clicks",
      widget: clicksWidget(["project"], 6),
    });
  if (numbers.includes("downloads") && models.downloads)
    // The stores' numbers per project, where the install reads a store.
    overview.push({
      key: "widget:downloads",
      widget: measure(
        models.downloads,
        t.downloads,
        ["app", "store"],
        ["downloads"],
        {
          view: "table",
          limit: 6,
          period: "last_30_days",
          order: { measureId: "downloads", direction: "desc" },
        },
      ),
    });
  let overviewPlaced: Placed[];
  const others = overview;
  if (models.state) {
    // On the left the summary ("All 23 up", "2 of 23 down", owner
    // decision #876) over the list of every item, problems first; the
    // numbers beside them: one above the other, or two rows of two.
    const left: Placed[] = [
      {
        key: "widget:state-summary",
        widget: {
          ...state("item_full", 1, "single"),
          x: 0,
          y: 0,
          w: others.length ? 4 : 12,
          h: 2,
        } as Widget,
      },
      {
        key: "widget:state",
        widget: {
          ...state("item_full", 8),
          x: 0,
          y: 2,
          w: others.length ? 4 : 12,
          h: 6,
        } as Widget,
      },
    ];
    const h = others.length > 2 ? 4 : others.length ? 8 / others.length : 8;
    overviewPlaced = [
      ...left,
      ...(others.length > 2
        ? [
            ...row(others.slice(0, 2), 0, h, 4, 8),
            ...row(others.slice(2), 4, h, 4, 8),
          ]
        : others.flatMap((entry, index) => row([entry], index * h, h, 4, 8))),
    ];
  } else
    overviewPlaced = rows(
      overview.length > 3
        ? [overview.slice(0, 2), overview.slice(2)]
        : [overview],
    );

  // ── Project slides ────────────────────────────────────────────────────
  const shown = developerProjectSlides(portfolio).shown;
  const projectSlide = (project: DeveloperProjectIdentity) => {
    const slideKey = projectSlideKey(project.productId);
    const key = (kind: string) => `widget:${slideKey}:${kind}`;
    const widgets = projectSlideWidgets(project, portfolio);
    const entry = (kind: DeveloperProjectWidget): Entry => {
      switch (kind) {
        case "downloads":
          return {
            key: key(kind),
            widget: measure(
              models.downloads!,
              t.downloads,
              ["store"],
              ["downloads"],
              {
                view: "value",
                limit: 2,
                period: "last_30_days",
              },
            ),
          };
        case "revenue":
          return {
            key: key(kind),
            widget: measure(
              models.proceeds!,
              t.revenue,
              ["currency"],
              ["proceeds"],
              {
                view: "table",
                limit: 3,
                period: "last_30_days",
              },
            ),
          };
        case "ratings":
          return {
            key: key(kind),
            widget: measure(
              models.ratings!,
              t.ratings,
              ["listing", "storefront"],
              ["rating", "rating_count"],
              { view: "table", limit: 3 },
            ),
          };
        case "audience":
          return { key: key(kind), widget: usageWidget([], 1) };
        case "clicks":
          return { key: key(kind), widget: clicksWidget([], 1) };
        case "deploys":
          return {
            key: key(kind),
            widget: measure(
              models.deploys!,
              t.latestDeploys,
              ["service"],
              ["last_deploy", "last_status"],
              {
                view: "table",
                limit: 4,
                order: { measureId: "last_deploy", direction: "desc" },
              },
            ),
          };
        case "costs":
          return {
            key: key(kind),
            widget: measure(
              models.costs!,
              t.spend,
              ["provider", "currency"],
              ["cost"],
              {
                view: "table",
                limit: 3,
                period: "this_month",
                periodTimeZone: "UTC",
              },
            ),
          };
        case "state":
          return { key: key(kind), widget: state("item", 6) };
      }
    };
    // The numbers in reading order, three a row (at most two rows).
    const numbered = widgets.filter((kind) => kind !== "state").map(entry);
    const states = widgets.filter((kind) => kind === "state").map(entry);
    const groups = [numbered.slice(0, 3), numbered.slice(3, 6)].filter(
      (group) => group.length,
    );
    // The numbers in rows of up to three; the state list below them (a
    // two-row list beside two rows of numbers), or the whole slide.
    const placed = states.length
      ? groups.length === 2
        ? rows([...groups, states], [3, 3, 2])
        : rows([...groups, states])
      : rows(groups);
    return {
      key: `slide:${slideKey}`,
      widgets: placed,
      slide: {
        name: (
          project.name.trim().slice(0, STUDIO_LIMITS.slideNameLength).trim() ||
          project.productId.slice(0, STUDIO_LIMITS.slideNameLength)
        ).trim(),
        scope: {
          project: { kind: "values" as const, values: [project.productId] },
        },
        widgets: placed.map((entry) => entry.widget),
      } satisfies Slide,
    };
  };
  const slides = [
    {
      key: "slide:0",
      widgets: overviewPlaced,
      slide: {
        name: shown.length ? t.overview : t.name,
        widgets: overviewPlaced.map((entry) => entry.widget),
      } satisfies Slide,
    },
    ...shown.map(projectSlide),
  ];
  return {
    request: {
      name,
      settings: {
        showHeader: true,
        autoAdvance: shown.length > 0,
        dataFilters: filters,
      },
      slides: slides.map((entry) => entry.slide),
    },
    // Reading order: slide by slide, then top to bottom, left to right.
    widgetKeys: slides.flatMap((entry) =>
      [...entry.widgets]
        .sort((a, b) => a.widget.y - b.widget.y || a.widget.x - b.widget.x)
        .map((placed) => placed.key),
    ),
    slideKeys: slides.map((entry) => entry.key),
  };
}
