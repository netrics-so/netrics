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
import type { CreateDashboardRequest } from "@netrics/contracts";

export type StoreConnectorId = "app-store-connect" | "google-play";
export type StoreMetric = "downloads" | "proceeds" | "ratings";
/** The store template versions this module builds (see store-template.ts). */
export type StoreTemplateVersion = 1 | 2 | 3;
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
 * from the apps of every metric's combined data (the selected apps that
 * report anything). Where apps of different stores share a display name,
 * the label of each app that lives in one store says which ("Example App ·
 * Google Play"); a product the customer linked across stores keeps its
 * name. `inputs`: the combined downloads, proceeds and ratings data.
 * Output `labels`: product_id, product_label.
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
  nodes.push(
    {
      id: "apps",
      type: "append",
      inputs: inputs.map((_, index) => `app_columns_${index}`),
    },
    {
      id: "app_stores",
      type: "group",
      input: "apps",
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
      input: "apps",
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

/** The store dashboard plus the template key of each widget, in reading order. */
export function buildStoreDashboardTemplate(
  name: string,
  models: Record<StoreMetric, string>,
  locale: Locale,
  productId?: string,
): { request: CreateDashboardRequest; widgetKeys: string[] } {
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
