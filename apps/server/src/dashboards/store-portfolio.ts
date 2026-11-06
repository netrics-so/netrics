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
        unallocated: "Nicht zugeordnete Berichtszeilen",
        noCurrency: "Dieser Wert ist kein Geldbetrag.",
        noCountry:
          "Bewertungen verwenden das Bewertungsland, nicht das Installations- oder Verkaufsland.",
        noStorefront:
          "Dieses Maß verwendet das Installations- oder Verkaufsland, nicht das Bewertungsland.",
      }
    : {
        name: "App portfolio",
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
        unallocated: "Unallocated report rows",
        noCurrency: "This value is not a monetary amount.",
        noCountry:
          "Ratings use the listing country rather than the install or sale country.",
        noStorefront:
          "This measure uses the install or sale country rather than the listing country.",
      };

/** Inspectable ordinary preparation steps; no store logic enters query execution. */
export function buildStorePreparation(
  source: StoreTemplateSource,
  metric: StoreMetric,
  mappingId: string,
  productDatasetId: string,
  locale: Locale,
): PreparationGraph {
  const t = storeTemplateCopy(locale),
    apple = source.connectorId === "app-store-connect";
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
    { id: "raw", type: "source", datasetId: dataset },
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
  const columns = [
    "app_key",
    "product_id",
    "product_name",
    "store",
    "store_name",
    "day",
  ];
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
    columns.push("country", "downloads");
  } else if (metric === "proceeds") {
    if (!apple) calculate("day", t.day, field("transaction_day"));
    calculate(
      "amount",
      t.proceeds,
      apple
        ? call("multiply", field("units"), field("developer_proceeds_per_unit"))
        : field("merchant_amount"),
    );
    columns.push("country", "amount", "amount.currency");
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
          call(
            "if",
            call("eq", field("availability"), text("not_listed")),
            text(t.notListed),
            text(t.unavailable),
          ),
        ),
      ),
    );
    columns.push(
      "listing_name",
      "storefront",
      "captured_at",
      "rating",
      "rating_count",
      "availability_label",
    );
  }
  nodes.push({ id: "output", type: "select", input: current, fields: columns });
  return { version: 1, nodes, outputs: ["output"] };
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

export function buildStoreModel(
  metric: StoreMetric,
  datasetId: string,
  locale: Locale,
): SemanticModelDefinition {
  const t = storeTemplateCopy(locale);
  const dimensions: ModelDimension[] = [
    {
      id: "app",
      name: t.app,
      datasetId,
      fieldId: "product_id",
      labelFieldId: "product_name",
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
    { id: "storefront", name: t.storefront, datasetId, fieldId: "storefront" },
  );
  return {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions,
    measures: [
      ["rating", t.rating, "rating"],
      ["rating_count", t.ratingCount, "rating_count"],
      ["checked", t.checked, "captured_at"],
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
  return {
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
}
