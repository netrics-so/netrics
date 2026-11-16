import { PRODUCT_TYPES } from "@netrics/connectors";
import type {
  Locale,
  PreparationGraph,
  PreparationNode,
  DataExpression,
  SemanticModelDefinition,
  ModelDimension,
  DashboardDataFilter,
} from "@netrics/domain";
import { createHash } from "node:crypto";
import type { CreateDashboardRequest } from "@netrics/contracts";
import { STUDIO_GRID, STUDIO_LIMITS } from "@netrics/domain";

export type StoreConnectorId = "app-store-connect" | "google-play";
export type StoreMetric = "downloads" | "proceeds" | "ratings";
/** The store template versions this module builds (see store-template.ts). */
export type StoreTemplateVersion = 1 | 2 | 3 | 4;
export interface StoreTemplateSource {
  id: string;
  name: string;
  connectorId: StoreConnectorId;
  datasets: Record<string, string>;
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

export const storeTemplateCopy = (locale: Locale) =>
  locale === "de"
    ? {
        name: "App-Portfolio",
        /** The updated copy of a dashboard (template updates, 11E). */
        updatedName: (name: string) => `${name} (aktualisiert)`.slice(0, 100),
        downloads: "Downloads und Nutzerinstallationen",
        proceeds: "Erlöse nach Gebühren",
        ratings: "Store-Bewertungen",
        mapping: "Bestätigte App-Zuordnung",
        products: "Produkte",
        app: "App",
        listing: "Store-Eintrag",
        store: "Store",
        day: "Berichts- / Erfassungstag",
        country: "Installations- / Verkaufsland",
        currency: "Währung",
        storefront: "Bewertungsland",
        rating: "Bewertung",
        ratingCount: "Anzahl Bewertungen",
        checked: "Geprüft am",
        availability: "Verfügbarkeit",
        available: "Verfügbar",
        unrated: "Noch keine Bewertungen",
        notListed: "Nicht im gewählten Land gelistet",
        unavailable: "Derzeit nicht verfügbar",
        noRatingReport: "Noch kein Bewertungsbericht",
        noRatingAccess: "Kein Zugriff auf Bewertungsberichte",
        unreadableRatingReport: "Bewertungsbericht nicht lesbar",
        allCountries: "Alle Länder",
        unallocated: "Nicht zugeordnete Berichtszeilen",
        noCurrency: "Dieser Wert ist kein Geldbetrag.",
        appLabel: "App (mit Store bei gleichem Namen)",
        appStores: "Stores der App",
        appsWithName: "Apps mit diesem Namen",
        rows: "Zeilen",
        appLabels: "App-Bezeichnungen",
        currencyName: "Währungsname",
        withoutCurrency: "Ohne Währung",
        noCountry:
          "Bewertungen verwenden das Bewertungsland, nicht das Installations- oder Verkaufsland.",
        noStorefront:
          "Dieses Maß verwendet das Installations- oder Verkaufsland, nicht das Bewertungsland.",
        revenue: "Erlöse, letzte 30 Tage",
        revenueByApp: "Erlöse nach App, letzte 30 Tage",
        downloadsRecent: "Downloads, letzte 30 Tage",
        visitors: "Website-Besucher, letzte 30 Tage",
        appStore: "App Store",
        connectionOwn:
          "Nutzt Metrik und Zeitraum seiner Verbindung, nicht die Filter der Store-Daten.",
      }
    : {
        name: "App portfolio",
        /** The updated copy of a dashboard (template updates, 11E). */
        updatedName: (name: string) => `${name} (updated)`.slice(0, 100),
        downloads: "Downloads and user installs",
        proceeds: "Proceeds after fees",
        ratings: "Store ratings",
        mapping: "Confirmed app mapping",
        products: "Products",
        app: "App",
        listing: "Store listing",
        store: "Store",
        day: "Reporting / collection day",
        country: "Install / sale country",
        currency: "Currency",
        storefront: "Rating country",
        rating: "Rating",
        ratingCount: "Rating count",
        checked: "Checked at",
        availability: "Availability",
        available: "Available",
        unrated: "No ratings yet",
        notListed: "Not listed in this country",
        unavailable: "Temporarily unavailable",
        noRatingReport: "No rating report yet",
        noRatingAccess: "No access to rating reports",
        unreadableRatingReport: "Rating report could not be read",
        allCountries: "All countries",
        unallocated: "Unallocated report rows",
        noCurrency: "This value is not a monetary amount.",
        appLabel: "App (with store where names repeat)",
        appStores: "Stores of the app",
        appsWithName: "Apps with this name",
        rows: "Rows",
        appLabels: "App labels",
        currencyName: "Currency name",
        withoutCurrency: "No currency",
        noCountry:
          "Ratings use the listing country rather than the install or sale country.",
        noStorefront:
          "This measure uses the install or sale country rather than the listing country.",
        revenue: "Revenue, last 30 days",
        revenueByApp: "Revenue by app, last 30 days",
        downloadsRecent: "Downloads, last 30 days",
        visitors: "Website visitors, last 30 days",
        appStore: "App Store",
        connectionOwn:
          "Uses its connection's own metric and period, not the store data filters.",
      };

const decimal = (value: string): DataExpression => ({
  kind: "literal",
  type: "decimal",
  value,
});
/** The ISO 4217 code App Store sales rows carry when they have no currency. */
const NO_CURRENCY = "XXX";

const nullOf = (type: "string" | "integer" | "decimal", unit?: string) =>
  ({
    kind: "literal",
    type,
    value: null,
    ...(unit ? { unit } : {}),
  }) as DataExpression;
/** A source dataset of the connection; a placeholder until it is registered. */
const sourceDataset = (source: StoreTemplateSource, key: string) =>
  source.datasets[key] ?? `pending:${source.id}:${key}`;

/** The storefront value of a Play Console rating report: every country. */
export const ALL_STOREFRONTS = "ALL";

/**
 * Google Play ratings since template version 2, from Play Console's rating
 * reports. Per rated report day: the Total Average Rating (Play reports no
 * rating count), its report day as the "as of" day, and "available" unless
 * the app's latest rating report month could not be read or accessed (the
 * last value stays, with that reason; a month not published yet is the
 * normal report lag). Every other app the connection reads (install or
 * rating report status) gets one row saying why there is no rating: no
 * ratings yet, no report yet, no access, or an unreadable report.
 * `captured_at` only orders rows (the latest report day wins). Output: the
 * listing snapshot's columns plus `storefront_name`, ending in node `raw`.
 */
function playRatingReportNodes(
  source: StoreTemplateSource,
  t: ReturnType<typeof storeTemplateCopy>,
): PreparationNode[] {
  const columns = [
    "app_id",
    "day",
    "captured_at",
    "rating",
    "rating_count",
    "availability",
    "storefront",
    "storefront_name",
    "app_name",
  ];
  const nodes: PreparationNode[] = [];
  let current = "";
  const step = (node: PreparationNode) => {
    nodes.push(node);
    current = node.id;
  };
  const calc = (
    id: string,
    fieldId: string,
    name: string,
    expression: DataExpression,
  ) =>
    step({ id, type: "calculate", input: current, fieldId, name, expression });
  const eq = (fieldId: string, value: string) =>
    call("eq", field(fieldId), text(value));
  const common = (prefix: string) => {
    calc(`${prefix}_count`, "rating_count", t.ratingCount, nullOf("integer"));
    calc(
      `${prefix}_storefront`,
      "storefront",
      t.storefront,
      text(ALL_STOREFRONTS),
    );
    calc(
      `${prefix}_storefront_name`,
      "storefront_name",
      t.storefront,
      text(t.allCountries),
    );
    calc(`${prefix}_name`, "app_name", t.app, nullOf("string"));
    step({
      id: `${prefix}_ratings`,
      type: "select",
      input: current,
      fields: columns,
    });
  };

  // Rating report availability per app: its latest month, whether any
  // month was published, and when it was last checked.
  step({
    id: "status_rows",
    type: "source",
    datasetId: sourceDataset(source, "report_status"),
  });
  step({
    id: "rating_status",
    type: "filter",
    input: current,
    expression: eq("report_type", "ratings"),
  });
  step({
    id: "status_by_app",
    type: "group",
    input: current,
    keys: ["app_id"],
    aggregates: [
      {
        id: "latest",
        name: t.availability,
        op: "last",
        fieldId: "availability",
        orderBy: "report_month",
      },
      // The reason a rating may be missing or outdated: the latest month
      // that is not merely unpublished (a new month is the normal lag and
      // must not hide that the month before could not be read).
      {
        id: "reason",
        name: t.availability,
        op: "last",
        fieldId: "availability",
        orderBy: "report_month",
        filter: call("ne", field("availability"), text("not_published")),
      },
      {
        id: "reported",
        name: "Available reports",
        op: "count",
        filter: eq("availability", "available"),
      },
      { id: "checked_at", name: t.checked, op: "max", fieldId: "captured_at" },
    ],
  });

  // Rated report days.
  step({
    id: "report_rows",
    type: "source",
    datasetId: sourceDataset(source, "rating_rows"),
  });
  step({
    id: "rated_rows",
    type: "filter",
    input: current,
    expression: call("not", call("is_null", field("total_average_rating"))),
  });
  step({
    id: "report_status",
    type: "join",
    left: "rated_rows",
    right: "status_by_app",
    keys: [{ left: "app_id", right: "app_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "status.",
  });
  calc(
    "report_order",
    "captured_at",
    t.checked,
    call("to_timestamp", field("day")),
  );
  calc("report_rating", "rating", t.rating, field("total_average_rating"));
  calc(
    "report_availability",
    "availability",
    t.availability,
    call(
      "if",
      eq("status.reason", "permission_missing"),
      text("permission_missing"),
      call(
        "if",
        eq("status.reason", "invalid_report"),
        text("invalid_report"),
        text("available"),
      ),
    ),
  );
  common("report");

  // Every other app the connection reads: install report status is written
  // for each selected app from its first sync (discovered apps that are not
  // selected have none), and rating report status for each rated one.
  step({
    id: "install_status",
    type: "filter",
    input: "status_rows",
    expression: eq("report_type", "installs"),
  });
  step({
    id: "install_apps",
    type: "select",
    input: current,
    fields: ["app_id"],
  });
  step({
    id: "status_apps",
    type: "select",
    input: "status_by_app",
    fields: ["app_id"],
  });
  step({
    id: "known_apps_all",
    type: "append",
    inputs: ["install_apps", "status_apps"],
  });
  step({
    id: "known_apps",
    type: "deduplicate",
    input: current,
    keys: ["app_id"],
    keep: "first",
  });
  step({
    id: "rated_apps",
    type: "group",
    input: "rated_rows",
    keys: ["app_id"],
    aggregates: [{ id: "days", name: "Rated days", op: "count" }],
  });
  step({
    id: "known_status",
    type: "join",
    left: "known_apps",
    right: "status_by_app",
    keys: [{ left: "app_id", right: "app_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "status.",
  });
  step({
    id: "known_rated",
    type: "join",
    left: current,
    right: "rated_apps",
    keys: [{ left: "app_id", right: "app_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "rated.",
  });
  step({
    id: "without_rating",
    type: "filter",
    input: current,
    expression: call("is_null", field("rated.days")),
  });
  // Ordering only: an app never checked has this one row.
  calc(
    "status_order",
    "captured_at",
    t.checked,
    call("coalesce", field("status.checked_at"), {
      kind: "literal",
      type: "timestamp",
      value: "1970-01-01T00:00:00.000Z",
    }),
  );
  calc("status_day", "day", t.day, call("to_date", field("status.checked_at")));
  calc("status_rating", "rating", t.rating, nullOf("decimal", "stars"));
  // Published reports without a rated day: no ratings yet. A selected app
  // without rating report status yet: no report yet.
  calc(
    "status_availability",
    "availability",
    t.availability,
    call(
      "if",
      call("is_null", field("status.latest")),
      text("not_published"),
      call(
        "if",
        call("gt", field("status.reported"), {
          kind: "literal",
          type: "integer",
          value: 0,
        }),
        text("unrated"),
        call("coalesce", field("status.reason"), field("status.latest")),
      ),
    ),
  );
  common("status");
  nodes.push({
    id: "raw",
    type: "append",
    inputs: ["report_ratings", "status_ratings"],
  });
  return nodes;
}

/**
 * Inspectable ordinary preparation steps; no store logic enters query
 * execution. `templateVersion` is the store template version that builds it:
 * version 2 reads Google Play ratings from Play Console rating reports.
 */
export function buildStorePreparation(
  source: StoreTemplateSource,
  metric: StoreMetric,
  mappingId: string,
  productDatasetId: string,
  locale: Locale,
  templateVersion: StoreTemplateVersion = 1,
): PreparationGraph {
  const t = storeTemplateCopy(locale),
    apple = source.connectorId === "app-store-connect";
  const playReports = !apple && metric === "ratings" && templateVersion >= 2;
  const dataset =
    source.datasets[
      metric === "ratings"
        ? "store_ratings"
        : apple
          ? "sales_rows"
          : metric === "downloads"
            ? "install_rows"
            : "earning_rows"
    ]!;
  const nodes: PreparationNode[] = [
    ...(playReports
      ? playRatingReportNodes(source, t)
      : [{ id: "raw", type: "source" as const, datasetId: dataset }]),
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
    { id: "mapping", type: "source", datasetId: mappingId },
    { id: "products", type: "source", datasetId: productDatasetId },
  ];
  let current = "raw";
  const calculate = (
    fieldId: string,
    name: string,
    expression: DataExpression,
  ) => {
    const id = "calculate_" + fieldId;
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
    "Source app identity",
    call("concat", text(source.id + ":"), field("app_id")),
  );
  nodes.push({
    id: "join_names",
    type: "join",
    left: current,
    right: "names",
    keys: [{ left: "app_id", right: "resource_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "resource.",
  });
  current = "join_names";
  nodes.push({
    id: "join_mapping",
    type: "join",
    left: current,
    right: "mapping",
    keys: [{ left: "app_key", right: "app_key" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "mapping.",
  });
  current = "join_mapping";
  calculate(
    "product_id",
    "Product identity",
    call("coalesce", field("mapping.product_id"), field("app_key")),
  );
  nodes.push({
    id: "join_products",
    type: "join",
    left: current,
    right: "products",
    keys: [{ left: "product_id", right: "product_id" }],
    mode: "left",
    cardinality: "many_to_one",
    rightPrefix: "product.",
  });
  current = "join_products";
  calculate(
    "product_name",
    t.app,
    call(
      "coalesce",
      field("product.product_name"),
      field("resource.name"),
      field("app_id"),
    ),
  );
  calculate("store", t.store + " ID", text(apple ? "apple" : "google"));
  calculate(
    "store_name",
    t.store,
    text(apple ? "Apple App Store" : "Google Play"),
  );
  if (metric === "downloads") {
    if (apple) {
      nodes.push({
        id: "new_downloads",
        type: "filter",
        input: current,
        expression: call("in", field("product_type"), {
          kind: "literal",
          type: "json",
          value: Object.entries(PRODUCT_TYPES)
            .filter(([, category]) => category === "download")
            .map(([code]) => code),
        }),
      });
      current = "new_downloads";
    }
    // Explicit conversion retains exact decimals; the required Store grain in
    // the model keeps the two providers' different install definitions apart.
    calculate(
      "downloads",
      t.downloads,
      call("to_decimal", field(apple ? "units" : "daily_user_installs")),
    );
  } else if (metric === "proceeds") {
    if (!apple) calculate("day", t.day, field("transaction_day"));
    calculate(
      "amount",
      t.proceeds,
      apple
        ? call("multiply", field("units"), field("developer_proceeds_per_unit"))
        : field("merchant_amount"),
    );
    if (templateVersion >= 3) {
      // Version 3 (#620): rows without proceeds (free units, empty report
      // rows) are left out, so a currency without proceeds in the period
      // has no row; a remaining row without a currency (ISO "XXX") is named.
      nodes.push({
        id: "paid_rows",
        type: "filter",
        input: current,
        expression: call(
          "ne",
          call("coalesce", field("amount"), decimal("0")),
          decimal("0"),
        ),
      });
      current = "paid_rows";
      calculate(
        "currency_name",
        t.currencyName,
        call(
          "if",
          call(
            "eq",
            call("coalesce", field("amount.currency"), text("")),
            text(NO_CURRENCY),
          ),
          text(t.withoutCurrency),
          field("amount.currency"),
        ),
      );
    }
  } else {
    calculate(
      "listing_name",
      t.listing,
      call(
        "concat",
        call(
          "coalesce",
          field("resource.name"),
          field("app_name"),
          field("app_id"),
        ),
        text(" · "),
        field("store_name"),
      ),
    );
    calculate(
      "availability_label",
      t.availability,
      call(
        "if",
        call("eq", field("availability"), text("available")),
        text(t.available),
        call(
          "if",
          call("eq", field("availability"), text("unrated")),
          text(t.unrated),
          playReports
            ? [
                ["not_published", t.noRatingReport],
                ["permission_missing", t.noRatingAccess],
                ["invalid_report", t.unreadableRatingReport],
              ].reduceRight<DataExpression>(
                (otherwise, [value, label]) =>
                  call(
                    "if",
                    call("eq", field("availability"), text(value!)),
                    text(label!),
                    otherwise,
                  ),
                text(t.unavailable),
              )
            : call(
                "if",
                call("eq", field("availability"), text("not_listed")),
                text(t.notListed),
                text(t.unavailable),
              ),
        ),
      ),
    );
    // Version 2: the storefront has a display name, so a storefront value
    // can stay the same in every language (Play reports: "ALL").
    if (templateVersion >= 2 && apple)
      calculate("storefront_name", t.storefront, field("storefront"));
  }
  nodes.push({
    id: "output",
    type: "select",
    input: current,
    fields: storeOutputColumns(metric, templateVersion),
  });
  return { version: 1, nodes, outputs: ["output"] };
}

/** The columns of a store preparation's output, the same for both stores. */
export function storeOutputColumns(
  metric: StoreMetric,
  templateVersion: StoreTemplateVersion,
): string[] {
  const columns = [
    "app_key",
    "product_id",
    "product_name",
    "store",
    "store_name",
    "day",
  ];
  if (metric === "downloads") columns.push("country", "downloads");
  else if (metric === "proceeds")
    columns.push(
      "country",
      "amount",
      "amount.currency",
      ...(templateVersion >= 3 ? ["currency_name"] : []),
    );
  else
    columns.push(
      "listing_name",
      "storefront",
      ...(templateVersion >= 2 ? ["storefront_name"] : []),
      "captured_at",
      "rating",
      "rating_count",
      "availability_label",
    );
  return columns;
}

/** Up to 80 sources per graph; callers compose further graphs without an account-count ceiling. */
export function buildStoreAppend(inputs: string[]): PreparationGraph {
  const nodes: PreparationNode[] = inputs.map((datasetId, index) => ({
    id: `input_${index}`,
    type: "source",
    datasetId,
  }));
  let level = nodes.map((node) => node.id),
    round = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let offset = 0; offset < level.length; offset += 20) {
      const chunk = level.slice(offset, offset + 20);
      if (chunk.length === 1) {
        next.push(chunk[0]!);
        continue;
      }
      const id = `append_${round}_${offset}`;
      nodes.push({ id, type: "append", inputs: chunk });
      next.push(id);
    }
    level = next;
    round++;
  }
  return { version: 1, nodes, outputs: [level[0]!] };
}

const integer = (value: number): DataExpression => ({
  kind: "literal",
  type: "integer",
  value,
});

/**
 * Version 3 (#621): one display label per app, shared by all three models,
 * from the apps in `inputs` (the template passes the combined downloads
 * data only, so the proceeds and ratings sources never hold up or fail the
 * downloads model; an app without downloads keeps its name in every model).
 * Where apps of different stores share a display name, the label of each
 * app that lives in one store says which ("Example App · Google Play"); a
 * product the customer linked across stores keeps its name. Output
 * `labels`: product_id, product_label.
 */
export function buildStoreAppLabels(
  inputs: string[],
  locale: Locale,
): PreparationGraph {
  const t = storeTemplateCopy(locale);
  const appColumns = ["product_id", "product_name", "store", "store_name"];
  const nodes: PreparationNode[] = [];
  // Each metric's apps first (a few rows each), then the union.
  inputs.forEach((datasetId, index) => {
    nodes.push(
      { id: `facts_${index}`, type: "source", datasetId },
      {
        id: `apps_${index}`,
        type: "group",
        input: `facts_${index}`,
        keys: appColumns,
        aggregates: [{ id: "rows", name: t.rows, op: "count" }],
      },
      {
        id: `app_columns_${index}`,
        type: "select",
        input: `apps_${index}`,
        fields: appColumns,
      },
    );
  });
  const apps = inputs.length === 1 ? "app_columns_0" : "apps";
  if (inputs.length > 1)
    nodes.push({
      id: "apps",
      type: "append",
      inputs: inputs.map((_, index) => `app_columns_${index}`),
    });
  nodes.push(
    {
      id: "app_stores",
      type: "group",
      input: apps,
      keys: ["product_id"],
      aggregates: [
        {
          id: "stores",
          name: t.appStores,
          op: "distinct_count",
          fieldId: "store",
        },
      ],
    },
    {
      id: "one_per_app",
      type: "deduplicate",
      input: apps,
      keys: ["product_id"],
      keep: "first",
    },
    {
      id: "apps_by_name",
      type: "group",
      input: "one_per_app",
      keys: ["product_name"],
      aggregates: [{ id: "apps", name: t.appsWithName, op: "count" }],
    },
    {
      id: "join_app_stores",
      type: "join",
      left: "one_per_app",
      right: "app_stores",
      keys: [{ left: "product_id", right: "product_id" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "app_stores.",
    },
    {
      id: "join_apps_by_name",
      type: "join",
      left: "join_app_stores",
      right: "apps_by_name",
      keys: [{ left: "product_name", right: "product_name" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "apps_by_name.",
    },
    {
      id: "calculate_product_label",
      type: "calculate",
      input: "join_apps_by_name",
      fieldId: "product_label",
      name: t.appLabel,
      expression: call(
        "if",
        call(
          "and",
          call(
            "gt",
            call("coalesce", field("apps_by_name.apps"), integer(1)),
            integer(1),
          ),
          call(
            "eq",
            call("coalesce", field("app_stores.stores"), integer(0)),
            integer(1),
          ),
        ),
        call("concat", field("product_name"), text(" · "), field("store_name")),
        field("product_name"),
      ),
    },
    {
      id: "labels",
      type: "select",
      input: "calculate_product_label",
      fields: ["product_id", "product_label"],
    },
  );
  return { version: 1, nodes, outputs: ["labels"] };
}

/**
 * Version 3: one metric's combined data with the app label of
 * `buildStoreAppLabels` (the app's name where it has none). Output
 * `labelled`: the store columns plus product_label.
 */
export function buildStoreLabelled(
  metric: StoreMetric,
  factsId: string,
  labelsId: string,
  locale: Locale,
): PreparationGraph {
  const t = storeTemplateCopy(locale);
  const columns = storeOutputColumns(metric, 3);
  return {
    version: 1,
    nodes: [
      { id: "facts", type: "source", datasetId: factsId },
      { id: "labels", type: "source", datasetId: labelsId },
      {
        id: "join_labels",
        type: "join",
        left: "facts",
        right: "labels",
        keys: [{ left: "product_id", right: "product_id" }],
        mode: "left",
        cardinality: "many_to_one",
        rightPrefix: "app.",
      },
      {
        id: "calculate_product_label",
        type: "calculate",
        input: "join_labels",
        fieldId: "product_label",
        name: t.appLabel,
        expression: call(
          "coalesce",
          field("app.product_label"),
          field("product_name"),
        ),
      },
      {
        id: "labelled",
        type: "select",
        input: "calculate_product_label",
        fields: [...columns.slice(0, 3), "product_label", ...columns.slice(3)],
      },
    ],
    outputs: ["labelled"],
  };
}

/**
 * The model of one metric. Version 2 ratings: the storefront dimension has a
 * display name, and "Checked at" is the as-of day (a date: a Play report day
 * reads the same in every viewer time zone); rows are still ordered by
 * their capture time.
 */
export function buildStoreModel(
  metric: StoreMetric,
  datasetId: string,
  locale: Locale,
  templateVersion: StoreTemplateVersion = 1,
): SemanticModelDefinition {
  const t = storeTemplateCopy(locale);
  const dimensions: ModelDimension[] = [
    {
      id: "app",
      name: t.app,
      datasetId,
      fieldId: "product_id",
      labelFieldId: templateVersion >= 3 ? "product_label" : "product_name",
    },
    {
      id: "store",
      name: t.store,
      datasetId,
      fieldId: "store",
      labelFieldId: "store_name",
    },
    {
      id: "day",
      name: t.day,
      datasetId,
      fieldId: "day",
      timeAlignment: "reporting_date",
    },
  ];
  if (metric !== "ratings")
    dimensions.push({
      id: "country",
      name: t.country,
      datasetId,
      fieldId: "country",
    });
  if (metric === "downloads")
    return {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions,
      measures: [
        {
          id: "downloads",
          name: t.downloads,
          kind: "aggregate",
          datasetId,
          requiredDimensions: ["store"],
          aggregate: {
            id: "downloads",
            name: t.downloads,
            op: "sum",
            fieldId: "downloads",
          },
        },
      ],
    };
  if (metric === "proceeds") {
    dimensions.push({
      id: "currency",
      name: t.currency,
      datasetId,
      fieldId: "amount.currency",
      ...(templateVersion >= 3 ? { labelFieldId: "currency_name" } : {}),
    });
    return {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions,
      measures: [
        {
          id: "proceeds",
          name: t.proceeds,
          kind: "aggregate",
          datasetId,
          // Currencies never add up: group by currency or fix it to one value.
          requiredDimensions: ["currency"],
          aggregate: {
            id: "proceeds",
            name: t.proceeds,
            op: "sum",
            fieldId: "amount",
          },
        },
      ],
    };
  }
  dimensions.push(
    {
      id: "listing",
      name: t.listing,
      datasetId,
      fieldId: "app_key",
      labelFieldId: "listing_name",
    },
    {
      id: "storefront",
      name: t.storefront,
      datasetId,
      fieldId: "storefront",
      ...(templateVersion >= 2 ? { labelFieldId: "storefront_name" } : {}),
    },
  );
  return {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions,
    measures: [
      ["rating", t.rating, "rating"],
      ["rating_count", t.ratingCount, "rating_count"],
      ["checked", t.checked, templateVersion >= 2 ? "day" : "captured_at"],
      ["availability", t.availability, "availability_label"],
    ].map(([id, name, fieldId]) => ({
      id: id!,
      name: name!,
      kind: "aggregate" as const,
      datasetId,
      requiredDimensions: ["listing", "storefront"],
      aggregate: {
        id: id!,
        name: name!,
        op: "last" as const,
        fieldId: fieldId!,
        orderBy: "captured_at",
      },
    })),
  };
}

export function buildStoreDashboard(
  name: string,
  models: Record<StoreMetric, string>,
  locale: Locale,
  productId?: string,
): CreateDashboardRequest {
  return buildStoreDashboardTemplate(name, models, locale, productId).request;
}

/**
 * The store dashboard plus the template key of each widget, in reading
 * order, and (version 4) of each slide, in position order.
 */
export function buildStoreDashboardTemplate(
  name: string,
  models: Record<StoreMetric, string>,
  locale: Locale,
  productId?: string,
  /** Version 4: the overview plus one slide per app (not for one app). */
  portfolio?: StorePortfolio,
): {
  request: CreateDashboardRequest;
  widgetKeys: string[];
  slideKeys?: string[];
} {
  const t = storeTemplateCopy(locale);
  const all = (dimensionId: string) =>
    Object.values(models).map((modelId) => ({ modelId, dimensionId }));
  const filter = (
    id: string,
    name: string,
    type: "string" | "date",
    mode: "values" | "range",
    mappings: DashboardDataFilter["mappings"],
  ): DashboardDataFilter => ({
    id,
    name,
    type,
    mode,
    mappings,
    defaultValue: null,
  });
  const filters: DashboardDataFilter[] = [
    {
      ...filter("app", t.app, "string", "values", all("app")),
      ...(productId
        ? { fixedValue: { kind: "values" as const, values: [productId] } }
        : {}),
    },
    filter("store", t.store, "string", "values", all("store")),
    filter("day", t.day, "date", "range", all("day")),
    filter(
      "country",
      t.country,
      "string",
      "values",
      ["downloads", "proceeds"].map((metric) => ({
        modelId: models[metric as StoreMetric],
        dimensionId: "country",
      })),
    ),
    filter("currency", t.currency, "string", "values", [
      { modelId: models.proceeds, dimensionId: "currency" },
    ]),
    filter("storefront", t.storefront, "string", "values", [
      { modelId: models.ratings, dimensionId: "storefront" },
    ]),
  ];
  const widget = (
    metric: StoreMetric,
    x: number,
    y: number,
    w: number,
    h: number,
    groupBy: string[],
    measureIds: string[],
  ) => ({
    type: "measure" as const,
    x,
    y,
    w,
    h,
    title: t[metric],
    binding: {
      modelId: models[metric],
      groupBy,
      measureIds,
      exclusions:
        metric === "ratings"
          ? [
              { filterId: "country", reason: t.noCountry },
              { filterId: "currency", reason: t.noCurrency },
            ]
          : [
              { filterId: "storefront", reason: t.noStorefront },
              ...(metric === "downloads"
                ? [{ filterId: "currency", reason: t.noCurrency }]
                : []),
            ],
    },
    options: { view: "table" as const, limit: 20 },
  });
  if (portfolio && !productId)
    return buildPortfolioSlides(name, t, filters, widget, portfolio);
  const request: CreateDashboardRequest = {
    name,
    settings: { showHeader: true, autoAdvance: false, dataFilters: filters },
    slides: [
      {
        name: t.name,
        widgets: [
          widget("downloads", 0, 0, 6, 4, ["app", "store"], ["downloads"]),
          widget("proceeds", 6, 0, 6, 4, ["app", "currency"], ["proceeds"]),
          widget(
            "ratings",
            0,
            4,
            12,
            4,
            ["listing", "storefront"],
            ["rating", "rating_count", "checked", "availability"],
          ),
        ],
      },
    ],
  };
  return {
    request,
    widgetKeys: ["widget:downloads", "widget:proceeds", "widget:ratings"],
  };
}

/**
 * An app of a version 4 install as its slide needs it (#709), read from
 * the product identity (#708) when the install or an update is built,
 * never per device payload.
 */
export interface StoreAppIdentity {
  /** The app filter's value: `product:<id>` or `<connectionId>:<appId>`. */
  productId: string;
  name: string;
  /** Paid (revenue widgets) or free (none). */
  paid: boolean;
  /** The workspace image of its icon: the slide's logo. */
  icon: string | null;
  /** Its App Store app: revenue, downloads and the latest review. */
  appStore: { connectionId: string; appId: string } | null;
  /** The stores of its apps. */
  stores: StoreConnectorId[];
  /** Its website: the visitors widget. */
  website: { connectionId: string; projectId: string } | null;
}
/** What version 4 builds the dashboard's slides from. */
export interface StorePortfolio {
  /** Every app that can have a slide, in slide order. */
  apps: StoreAppIdentity[];
  /** The install's App Store connections: revenue in the overview. */
  appStore: { id: string; name: string }[];
}

/** Revenue and visitor tables of the overview (one per connection), at most. */
const OVERVIEW_TABLES = 2;
/** The connector widgets' period. */
const RECENT = "last_30_days" as const;
const ASC_PROCEEDS = "app_store_connect.proceeds",
  ASC_DOWNLOADS = "app_store_connect.downloads",
  VERCEL_VISITORS = "vercel.visitors";

/** A short stable key of an app's slide and widgets. */
export const appSlideKey = (productId: string) =>
  "app-" + createHash("sha256").update(productId).digest("hex").slice(0, 16);

/** The widgets an app's slide shows, in reading order. */
export function appSlideWidgets(app: StoreAppIdentity): string[] {
  return [
    ...(app.paid ? ["revenue"] : []),
    "downloads",
    ...(app.website ? ["visitors"] : []),
    "ratings",
    ...(app.appStore ? ["review"] : []),
  ];
}

/** The connections of the overview's revenue and visitor tables. */
function overviewTables(portfolio: StorePortfolio) {
  const websites = [
    ...new Set(
      portfolio.apps.flatMap((app) =>
        app.website ? [app.website.connectionId] : [],
      ),
    ),
  ].sort();
  return {
    revenue: [...portfolio.appStore]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, OVERVIEW_TABLES),
    visitors: websites.slice(0, OVERVIEW_TABLES),
  };
}

/**
 * The apps that get a slide: the first ones in order while the dashboard
 * stays within the Studio's limits (12 slides, 48 data widgets, the
 * overview included); the rest are `omitted` and show in the overview only.
 */
export function storeAppSlides(portfolio: StorePortfolio): {
  shown: StoreAppIdentity[];
  omitted: StoreAppIdentity[];
} {
  const tables = overviewTables(portfolio);
  let cost = 3 + tables.revenue.length + tables.visitors.length;
  const shown: StoreAppIdentity[] = [],
    omitted: StoreAppIdentity[] = [];
  for (const app of portfolio.apps) {
    const widgets = appSlideWidgets(app).length;
    if (
      omitted.length === 0 &&
      shown.length < STUDIO_LIMITS.slides - 1 &&
      cost + widgets <= STUDIO_LIMITS.dataWidgets
    ) {
      shown.push(app);
      cost += widgets;
    } else omitted.push(app);
  }
  return { shown, omitted };
}

type Slide = NonNullable<CreateDashboardRequest["slides"]>[number];
type Widget = Slide["widgets"][number];
type Unplaced = Widget extends infer W
  ? W extends unknown
    ? Omit<W, "x" | "w">
    : never
  : never;
type Placed = { key: string; widget: Widget };

/** One row of widgets over the grid's width, larger ones first. */
function row(widgets: { key: string; widget: Unplaced }[]): Placed[] {
  const count = widgets.length,
    base = Math.floor(STUDIO_GRID.columns / count),
    extra = STUDIO_GRID.columns - base * count;
  let x = 0;
  return widgets.map(({ key, widget }, index) => {
    const w = index < extra ? base + 1 : base;
    const placed = { key, widget: { ...widget, x, w } as Widget };
    x += w;
    return placed;
  });
}

/**
 * Version 4 (#709): the overview (version 3's tables, plus revenue in the
 * display currency per App Store connection and visitors per linked Vercel
 * connection), then one slide per app, scoped to it, with its icon as the
 * slide's logo; screens advance on their own.
 */
function buildPortfolioSlides(
  name: string,
  t: ReturnType<typeof storeTemplateCopy>,
  filters: DashboardDataFilter[],
  measure: (
    metric: StoreMetric,
    x: number,
    y: number,
    w: number,
    h: number,
    groupBy: string[],
    measureIds: string[],
  ) => Extract<Widget, { type: "measure" }>,
  portfolio: StorePortfolio,
): {
  request: CreateDashboardRequest;
  widgetKeys: string[];
  slideKeys: string[];
} {
  // Connector widgets cannot apply the model filters: each excludes every
  // shared filter, with the reason a viewer sees when one is active.
  const filterExclusions = filters.map((filter) => ({
    filterId: filter.id,
    reason: t.connectionOwn,
  }));
  const connector = {
    aggregation: "sum" as const,
    period: RECENT,
    displayCurrency: null,
    filterExclusions,
  };
  const table = (
    connectionId: string,
    metricKey: string,
    title: string,
    y: number,
  ): Unplaced => ({
    type: "table",
    y,
    h: 4,
    title,
    connectionId,
    metricKey,
    ...connector,
    dimensions: {},
    options: {
      groupBy: "resource",
      limit: 5,
      showChange: true,
      showOthers: false,
    },
  });
  const sized = (
    widget: Extract<Widget, { type: "measure" }>,
    view: "table" | "value",
    limit: number,
  ): Unplaced => {
    const { x: _x, w: _w, ...rest } = widget;
    return { ...rest, options: { view, limit } };
  };
  const tables = overviewTables(portfolio);
  const several = portfolio.appStore.length > 1;
  const overview: Placed[] = [
    ...row([
      {
        key: "widget:downloads",
        widget: sized(
          measure("downloads", 0, 0, 0, 4, ["app", "store"], ["downloads"]),
          "table",
          20,
        ),
      },
      {
        key: "widget:proceeds",
        widget: sized(
          measure("proceeds", 0, 0, 0, 4, ["app", "currency"], ["proceeds"]),
          "table",
          20,
        ),
      },
      ...tables.revenue.map((connection) => ({
        key: `widget:revenue:${connection.id}`,
        widget: table(
          connection.id,
          ASC_PROCEEDS,
          several
            ? `${t.revenueByApp} · ${connection.name}`.slice(0, 100)
            : t.revenueByApp,
          0,
        ),
      })),
    ]),
    ...row([
      {
        key: "widget:ratings",
        widget: sized(
          measure(
            "ratings",
            0,
            4,
            0,
            4,
            ["listing", "storefront"],
            ["rating", "rating_count", "checked", "availability"],
          ),
          "table",
          20,
        ),
      },
      ...tables.visitors.map((connectionId) => ({
        key: `widget:visitors:${connectionId}`,
        widget: table(connectionId, VERCEL_VISITORS, t.visitors, 4),
      })),
    ]),
  ];

  const appSlide = (app: StoreAppIdentity) => {
    const slideKey = appSlideKey(app.productId);
    const key = (kind: string) => `widget:${slideKey}:${kind}`;
    const store = app.appStore;
    // A product in both stores shows its App Store app's numbers here and
    // every store's in the overview.
    const titled = (title: string) =>
      app.stores.length > 1 ? `${title} · ${t.appStore}` : title;
    const metric = (
      connectionId: string,
      metricKey: string,
      resource: string,
      title: string,
    ): Unplaced => ({
      type: "metric",
      y: 0,
      h: 3,
      title,
      connectionId,
      metricKey,
      ...connector,
      dimensions: { resource },
      options: { showSparkline: true, showChange: true },
    });
    const band: { key: string; widget: Unplaced }[] = [];
    if (app.paid)
      band.push({
        key: key("revenue"),
        widget: store
          ? metric(
              store.connectionId,
              ASC_PROCEEDS,
              store.appId,
              titled(t.revenue),
            )
          : // Google Play only: proceeds per currency; no connection
            // metric converts them.
            sized(
              measure("proceeds", 0, 0, 0, 3, ["currency"], ["proceeds"]),
              "table",
              5,
            ),
      });
    if (store)
      band.push({
        key: key("downloads"),
        widget: metric(
          store.connectionId,
          ASC_DOWNLOADS,
          store.appId,
          titled(t.downloadsRecent),
        ),
      });
    else {
      // Google Play only: user installs over the date filter's range.
      const downloads = measure("downloads", 0, 0, 0, 3, [], ["downloads"]);
      band.push({
        key: key("downloads"),
        widget: sized(
          {
            ...downloads,
            binding: {
              ...downloads.binding,
              filter: call("eq", field("store"), text("google")),
            },
          },
          "value",
          20,
        ),
      });
    }
    if (app.website)
      band.push({
        key: key("visitors"),
        widget: metric(
          app.website.connectionId,
          VERCEL_VISITORS,
          app.website.projectId,
          t.visitors,
        ),
      });
    const lower: { key: string; widget: Unplaced }[] = [
      {
        key: key("ratings"),
        widget: sized(
          measure(
            "ratings",
            0,
            3,
            0,
            5,
            ["listing", "storefront"],
            ["rating", "rating_count"],
          ),
          "table",
          5,
        ),
      },
    ];
    if (store)
      lower.push({
        key: key("review"),
        widget: {
          type: "review",
          y: 3,
          h: 5,
          title: null,
          filterExclusions,
          connectionId: store.connectionId,
          dimensions: { resource: store.appId },
          imageId: null,
          options: { minRating: 1, requireText: true, showAuthor: true },
        },
      });
    const widgets = [...row(band), ...row(lower)];
    return {
      key: `slide:${slideKey}`,
      widgets,
      slide: {
        name: app.name.slice(0, STUDIO_LIMITS.slideNameLength),
        logoImageId: app.icon,
        scope: { app: { kind: "values" as const, values: [app.productId] } },
        widgets: widgets.map((placed) => placed.widget),
      } satisfies Slide,
    };
  };
  const slides = [
    {
      key: "slide:0",
      widgets: overview,
      slide: {
        name: t.name,
        widgets: overview.map((placed) => placed.widget),
      } satisfies Slide,
    },
    ...storeAppSlides(portfolio).shown.map(appSlide),
  ];
  return {
    request: {
      name,
      settings: { showHeader: true, autoAdvance: true, dataFilters: filters },
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
