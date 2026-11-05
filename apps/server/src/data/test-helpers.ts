import {
  sourceDatasetSchema,
  createDashboardRequestSchema,
} from "@netrics/contracts";
import type {
  DataExpression,
  PreparationGraph,
  SemanticModelDefinition,
  DataType,
  DashboardDataFilter,
} from "@netrics/domain";

export const campaignNow = new Date("2026-11-05T12:00:00.000Z");
export const field = (fieldId: string): DataExpression => ({
  kind: "field",
  fieldId,
});
const text = (value: string): DataExpression => ({
  kind: "literal",
  type: "string",
  value,
});
export const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const definition = (
  key: string,
  name: string,
  columns: Array<[string, string, DataType]>,
  money?: string,
) =>
  sourceDatasetSchema.parse({
    key,
    name,
    version: 1,
    mode: "snapshot",
    grain: "One imported row identified by its stable key",
    keyFields: [columns[0]![0]],
    retentionDays: null,
    fields: columns.map(([id, name, type]) => ({
      id,
      name,
      type,
      nullable: false,
      classification: "internal",
      ...(id === money
        ? { unit: "currency", currencyField: "currency", scale: 2 }
        : {}),
    })),
  });
export const campaignFixtures = {
  campaigns: {
    definition: definition("campaigns", "Campaigns", [
      ["campaign_id", "Campaign ID", "string"],
      ["campaign_name", "Campaign name", "string"],
      ["market", "Market", "string"],
    ]),
    records: [
      {
        values: {
          campaign_id: "launch",
          campaign_name: "Spring launch",
          market: "EU",
        },
      },
      {
        values: { campaign_id: "brand", campaign_name: "Brand", market: "US" },
      },
    ],
  },
  mapping: {
    definition: definition("campaign_mapping", "Confirmed campaign mapping", [
      ["source_key", "Source key", "string"],
      ["campaign_id", "Campaign ID", "string"],
    ]),
    records: [
      { values: { source_key: "ads:search-42", campaign_id: "launch" } },
      { values: { source_key: "ads:social-99", campaign_id: "launch" } },
      { values: { source_key: "web:spring-landing", campaign_id: "launch" } },
      { values: { source_key: "ads:brand-7", campaign_id: "brand" } },
      { values: { source_key: "web:always-on", campaign_id: "brand" } },
    ],
  },
  ads: {
    definition: definition(
      "advertising",
      "Advertising rows",
      [
        ["id", "Row ID", "string"],
        ["source_campaign", "Source campaign", "string"],
        ["day", "Day", "date"],
        ["keyword", "Keyword", "string"],
        ["spend", "Spend", "decimal"],
        ["currency", "Currency", "string"],
      ],
      "spend",
    ),
    records: [
      {
        values: {
          id: "a1",
          source_campaign: "search-42",
          day: "2026-11-01",
          keyword: "shoes",
          spend: "10.10",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "a2",
          source_campaign: "search-42",
          day: "2026-11-01",
          keyword: "boots",
          spend: "5.20",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "a3",
          source_campaign: "social-99",
          day: "2026-11-01",
          keyword: "feed",
          spend: "4.70",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "a4",
          source_campaign: "search-42",
          day: "2026-11-02",
          keyword: "shoes",
          spend: "10.00",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "a5",
          source_campaign: "brand-7",
          day: "2026-11-01",
          keyword: "brand",
          spend: "8.00",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "a6",
          source_campaign: "new-77",
          day: "2026-11-01",
          keyword: "new",
          spend: "2.00",
          currency: "EUR",
        },
      },
    ],
  },
  web: {
    definition: definition(
      "website",
      "Website campaign rows",
      [
        ["id", "Row ID", "string"],
        ["source_campaign", "Source campaign", "string"],
        ["day", "Day", "date"],
        ["visits", "Visits", "integer"],
        ["conversions", "Conversions", "integer"],
        ["revenue", "Revenue", "decimal"],
        ["currency", "Currency", "string"],
      ],
      "revenue",
    ),
    records: [
      {
        values: {
          id: "w1",
          source_campaign: "spring-landing",
          day: "2026-11-01",
          visits: 60,
          conversions: 2,
          revenue: "70.10",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "w2",
          source_campaign: "spring-landing",
          day: "2026-11-01",
          visits: 40,
          conversions: 1,
          revenue: "29.90",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "w3",
          source_campaign: "spring-landing",
          day: "2026-11-02",
          visits: 50,
          conversions: 1,
          revenue: "50.00",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "w4",
          source_campaign: "always-on",
          day: "2026-11-01",
          visits: 20,
          conversions: 0,
          revenue: "0.00",
          currency: "EUR",
        },
      },
      {
        values: {
          id: "w5",
          source_campaign: "unknown-77",
          day: "2026-11-01",
          visits: 10,
          conversions: 1,
          revenue: "12.50",
          currency: "EUR",
        },
      },
    ],
  },
  days: {
    definition: definition("campaign_days", "Reporting days", [
      ["day", "Day", "date"],
    ]),
    records: ["2026-11-01", "2026-11-02"].map((day) => ({ values: { day } })),
  },
  currencies: {
    definition: definition("campaign_currencies", "Currencies", [
      ["currency", "Currency", "string"],
    ]),
    records: [{ values: { currency: "EUR" } }],
  },
};
export type CampaignSources = Record<keyof typeof campaignFixtures, string>;

/** Customer-authored graphs; the executor has no advertising/website branch. */
export function campaignPreparation(
  source: "ads" | "web",
  sources: CampaignSources,
): PreparationGraph {
  // Separately authored columns have different IDs even when labels agree.
  const identityFields =
    source === "web"
      ? {
          id: "website_campaign_id",
          name: "website_campaign_name",
          market: "website_market",
        }
      : { id: "campaign_id", name: "campaign_name", market: "market" };
  const nodes: PreparationGraph["nodes"] = [
    { id: "raw", type: "source", datasetId: sources[source] },
    { id: "aliases", type: "source", datasetId: sources.mapping },
    { id: "campaigns", type: "source", datasetId: sources.campaigns },
    {
      id: "source_key",
      type: "calculate",
      input: "raw",
      fieldId: "source_key",
      name: "Source key",
      expression: call("concat", text(source + ":"), field("source_campaign")),
    },
    {
      id: "mapping",
      type: "join",
      left: "source_key",
      right: "aliases",
      keys: [{ left: "source_key", right: "source_key" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "mapping.",
      rightNamePrefix: "Mapping / ",
    },
    {
      id: "identity",
      type: "calculate",
      input: "mapping",
      fieldId: identityFields.id,
      name: "Campaign ID",
      expression: call(
        "coalesce",
        field("mapping.campaign_id"),
        field("source_key"),
      ),
    },
    {
      id: "names",
      type: "join",
      left: "identity",
      right: "campaigns",
      keys: [{ left: identityFields.id, right: "campaign_id" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "campaign.",
      rightNamePrefix: "Campaign / ",
    },
    {
      id: "label",
      type: "calculate",
      input: "names",
      fieldId: identityFields.name,
      name: "Campaign name",
      expression: call(
        "coalesce",
        field("campaign.campaign_name"),
        call(
          "concat",
          text("Unmapped " + source + " · "),
          field("source_campaign"),
        ),
      ),
    },
    {
      id: "market",
      type: "calculate",
      input: "label",
      fieldId: identityFields.market,
      name: "Market",
      expression: call(
        "coalesce",
        field("campaign.market"),
        text("Unassigned"),
      ),
    },
  ];
  if (source === "web")
    nodes.push({
      id: "has_conversions",
      type: "calculate",
      input: "market",
      fieldId: "has_conversions",
      name: "Has conversions",
      expression: call("gt", field("conversions"), {
        kind: "literal",
        type: "integer",
        value: 0,
      }),
    });
  return { version: 1, nodes, outputs: [nodes.at(-1)!.id] };
}
export function campaignDimension(ads: string, web: string): PreparationGraph {
  return {
    version: 1,
    nodes: [
      { id: "ads", type: "source", datasetId: ads },
      { id: "web", type: "source", datasetId: web },
      {
        id: "ad_columns",
        type: "select",
        input: "ads",
        fields: ["campaign_id", "campaign_name", "market"],
      },
      {
        id: "web_columns",
        type: "select",
        input: "web",
        fields: [
          "website_campaign_id",
          "website_campaign_name",
          "website_market",
        ],
      },
      {
        id: "combined",
        type: "append",
        inputs: ["ad_columns", "web_columns"],
        columnMappings: {
          web_columns: {
            website_campaign_id: "campaign_id",
            website_campaign_name: "campaign_name",
            website_market: "market",
          },
        },
      },
      {
        id: "unique_campaigns",
        type: "deduplicate",
        input: "combined",
        keys: ["campaign_id"],
        keep: "last",
      },
    ],
    outputs: ["unique_campaigns"],
  };
}
export function campaignModel(
  sources: CampaignSources,
  ads: string,
  web: string,
  campaigns: string,
): SemanticModelDefinition {
  const aggregate = (
    id: string,
    name: string,
    datasetId: string,
    fieldId: string,
    op: "sum" | "any" = "sum",
  ) => ({
    id,
    name,
    kind: "aggregate" as const,
    datasetId,
    aggregate: { id, name, op, fieldId },
  });
  return {
    version: 1,
    datasets: [ads, web, campaigns, sources.days, sources.currencies],
    relationships: [
      ...[ads, web].flatMap((datasetId, index) => [
        {
          id: `campaign_${index}`,
          from: {
            datasetId,
            fieldId: index === 0 ? "campaign_id" : "website_campaign_id",
          },
          to: { datasetId: campaigns, fieldId: "campaign_id" },
          cardinality: "many_to_one" as const,
        },
        {
          id: `day_${index}`,
          from: { datasetId, fieldId: "day" },
          to: { datasetId: sources.days, fieldId: "day" },
          cardinality: "many_to_one" as const,
        },
        {
          id: `currency_${index}`,
          from: { datasetId, fieldId: "currency" },
          to: { datasetId: sources.currencies, fieldId: "currency" },
          cardinality: "many_to_one" as const,
        },
      ]),
    ],
    dimensions: [
      {
        id: "campaign",
        name: "Campaign",
        datasetId: campaigns,
        fieldId: "campaign_id",
        labelFieldId: "campaign_name",
      },
      {
        id: "market",
        name: "Campaign market",
        datasetId: campaigns,
        fieldId: "market",
      },
      {
        id: "day",
        name: "Day",
        datasetId: sources.days,
        fieldId: "day",
        timeAlignment: "reporting_date",
      },
      {
        id: "currency",
        name: "Currency",
        datasetId: sources.currencies,
        fieldId: "currency",
      },
      {
        id: "keyword",
        name: "Advertising keyword",
        datasetId: ads,
        fieldId: "keyword",
      },
    ],
    measures: [
      aggregate("spend", "Ad spend", ads, "spend"),
      aggregate("revenue", "Website revenue", web, "revenue"),
      aggregate("visits", "Visits", web, "visits"),
      aggregate("conversions", "Conversions", web, "conversions"),
      aggregate(
        "any_conversions",
        "Has conversions",
        web,
        "has_conversions",
        "any",
      ),
      {
        id: "contribution",
        name: "Contribution",
        kind: "formula",
        expression: call("subtract", field("revenue"), field("spend")),
      },
      {
        id: "roas",
        name: "Revenue / ad spend",
        kind: "formula",
        expression: call("divide", field("revenue"), field("spend")),
      },
      {
        id: "profitable",
        name: "Revenue exceeds ad spend",
        kind: "formula",
        expression: call(
          "gt",
          field("contribution"),
          call("multiply", field("spend"), {
            kind: "literal",
            type: "decimal",
            value: "0",
          }),
        ),
      },
    ],
  };
}
export function campaignDashboard(
  modelId: string,
  name = "Campaign overview",
  fixedCampaign?: string,
) {
  const filters: DashboardDataFilter[] = [
    {
      id: "campaign",
      name: "Campaign",
      type: "string",
      mode: "values",
      defaultValue: null,
      mappings: [{ modelId, dimensionId: "campaign" }],
      ...(fixedCampaign
        ? { fixedValue: { kind: "values", values: [fixedCampaign] } }
        : {}),
    },
    {
      id: "market",
      name: "Campaign market",
      type: "string",
      mode: "values",
      defaultValue: null,
      mappings: [{ modelId, dimensionId: "market" }],
    },
    {
      id: "day",
      name: "Day",
      type: "date",
      mode: "range",
      defaultValue: null,
      mappings: [{ modelId, dimensionId: "day" }],
    },
  ];
  return createDashboardRequestSchema.parse({
    name,
    settings: { dataFilters: filters },
    slides: [
      {
        widgets: [
          {
            type: "measure",
            x: 0,
            y: 0,
            w: 12,
            h: 5,
            title: "Campaign performance",
            binding: {
              modelId,
              measureIds: [
                "spend",
                "revenue",
                "contribution",
                "roas",
                "visits",
                "any_conversions",
              ],
              groupBy: ["campaign", "currency"],
              exclusions: [],
            },
            options: { view: "table", limit: 20 },
          },
          {
            type: "measure",
            x: 0,
            y: 5,
            w: 6,
            h: 3,
            title: "Revenue exceeds ad spend",
            binding: {
              modelId,
              measureIds: ["profitable"],
              groupBy: [],
              exclusions: [],
            },
            options: { view: "value", limit: 20 },
          },
        ],
      },
    ],
  });
}
