import {
  appStoreConnectManifest,
  googlePlayManifest,
} from "@netrics/connectors";
import type { SourceDatasetDefinition } from "@netrics/contracts";
import type { DataTable, DataRow } from "@netrics/domain";
import type { StoreTemplateSource } from "./store-portfolio.js";
export const now = "2026-11-05T12:00:00.000Z";
export const apple: StoreTemplateSource = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Apple team",
  connectorId: "app-store-connect",
  datasets: { sales_rows: "apple-sales", store_ratings: "apple-ratings" },
};
export const google: StoreTemplateSource = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Play account",
  connectorId: "google-play",
  datasets: {
    install_rows: "play-installs",
    earning_rows: "play-earnings",
    store_ratings: "play-ratings",
  },
};
function records(
  definition: SourceDatasetDefinition,
  values: DataRow[],
): DataTable {
  return {
    fields: definition.fields,
    rows: values.map((row) =>
      Object.fromEntries(
        definition.fields.map((field) => [
          field.id,
          Object.hasOwn(row, field.id)
            ? row[field.id]
            : field.nullable
              ? null
              : field.type === "string"
                ? ""
                : field.type === "date"
                  ? "2026-10-01"
                  : field.type === "timestamp"
                    ? now
                    : field.type === "decimal"
                      ? "0"
                      : field.type === "json"
                        ? {}
                        : field.type === "boolean"
                          ? false
                          : 0,
        ]),
      ),
    ),
  };
}
const named = (ids: Array<[string, string]>, kind: string): DataTable => ({
  fields: ["resource_id", "name", "kind"].map((id) => ({
    id,
    name: id,
    type: "string",
    nullable: false,
  })),
  rows: ids.map(([resource_id, name]) => ({ resource_id, name, kind })),
});
const mapping: DataTable = {
  fields: ["app_key", "product_id"].map((id) => ({
    id,
    name: id,
    type: "string",
    nullable: false,
  })),
  rows: [
    {
      app_key: apple.id + ":a",
      product_id: "confirmed-product",
    },
    {
      app_key: google.id + ":com.example.alpha",
      product_id: "confirmed-product",
    },
    {
      app_key: google.id + ":__unmapped",
      product_id: google.id + ":__unmapped",
    },
  ],
};
const definition = (provider: "apple" | "google", key: string) =>
  (provider === "apple"
    ? appStoreConnectManifest
    : googlePlayManifest
  ).datasets!.find((dataset) => dataset.key === key)!;
export function inputs(): Map<string, DataTable> {
  return new Map([
    ["mapping", mapping],
    [
      "products",
      {
        fields: ["product_id", "product_name"].map((id) => ({
          id,
          name: id,
          type: "string",
          nullable: false,
        })),
        rows: [
          { product_id: "confirmed-product", product_name: "Example app" },
          {
            product_id: google.id + ":__unmapped",
            product_name: "Unallocated Play rows",
          },
        ],
      },
    ],
    [`resources:${apple.id}`, named([["a", "Apple Example"]], "iOS")],
    [
      `resources:${google.id}`,
      named(
        [
          ["com.example.alpha", "Android Example"],
          ["com.example.beta", "Other app"],
        ],
        "Android",
      ),
    ],
    [
      "apple-sales",
      records(definition("apple", "sales_rows"), [
        {
          app_id: "a",
          product_type: "1F",
          units: "10",
          developer_proceeds_per_unit: "0",
          currency: "USD",
          country: "US",
        },
        {
          app_id: "a",
          product_type: "IAY",
          units: "2",
          developer_proceeds_per_unit: "0.70",
          currency: "USD",
          country: "US",
        },
        {
          app_id: "a",
          product_type: "IAY",
          units: "-1",
          developer_proceeds_per_unit: "0.70",
          currency: "USD",
          country: "US",
        },
        {
          app_id: "a",
          product_type: "3F",
          units: "5",
          developer_proceeds_per_unit: "0",
          currency: "USD",
          country: "US",
        },
      ]),
    ],
    [
      "play-installs",
      records(definition("google", "install_rows"), [
        {
          app_id: "com.example.alpha",
          daily_user_installs: "10",
          country: "US",
        },
        {
          app_id: "com.example.alpha",
          daily_user_installs: null,
          country: "US",
        },
        { app_id: "com.example.beta", daily_user_installs: "4", country: "DE" },
      ]),
    ],
    [
      "play-earnings",
      records(definition("google", "earning_rows"), [
        ...["10", "-3", "-2", "0.6", "-0.1"].map((merchant_amount) => ({
          app_id: "com.example.alpha",
          merchant_amount,
          currency: "USD",
          country: "US",
        })),
        {
          app_id: "com.example.beta",
          merchant_amount: "70",
          currency: "EUR",
          country: "DE",
        },
        {
          app_id: "__unmapped",
          merchant_amount: "-1",
          currency: "USD",
          country: "",
        },
      ]),
    ],
    [
      "apple-ratings",
      records(definition("apple", "store_ratings"), [
        {
          app_id: "a",
          app_name: "Apple Example",
          storefront: "US",
          rating: "4.5",
          rating_count: 100,
          availability: "available",
        },
      ]),
    ],
    [
      "play-ratings",
      records(definition("google", "store_ratings"), [
        {
          app_id: "com.example.alpha",
          app_name: "Android Example",
          storefront: "US",
          locale: "en",
          form_factor: "store_default",
          rating: "4.1",
          rating_count: 50,
          availability: "available",
        },
      ]),
    ],
  ]);
}
