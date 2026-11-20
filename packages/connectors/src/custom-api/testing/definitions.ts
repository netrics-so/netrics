// Custom API definitions pointing at the fixture server, one per route
// group. Built through the definition schema (defaults applied), with the
// fixture origin as base URL: a plain-http origin is not a valid stored
// definition (https only), which is fine for package tests that never store
// one; a tls fixture origin gives a document the schema accepts.

import {
  customApiDefinitionSchema,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";

export const FIXTURE_DEFINITION_NAMES = [
  "pages",
  "offset",
  "cursor",
  "next_body",
  "next_link",
  "stats",
  "daily",
  "daily_unix",
  "daily_replace",
  "api_key_header",
  "api_key_query",
  "api_key_query_400",
  "api_key_query_echo",
  "bearer",
  "bearer_custom",
  "basic",
  "next_off_host",
  "redirect_off_host",
  "repeat_cursor",
  "endless",
  "bad_values",
  "not_json",
  "deep",
  "rate_limited",
  "photos",
  "photos_bearer",
] as const;
export type FixtureDefinitionName = (typeof FIXTURE_DEFINITION_NAMES)[number];

const PLACEHOLDER_ORIGIN = "https://fixture.invalid";

const itemFields = [
  { id: "id", name: "ID", path: "id", type: "integer", nullable: false },
  { id: "name", name: "Name", path: "name", type: "string" },
  {
    id: "created",
    name: "Created",
    path: "created_at",
    type: "timestamp",
    nullable: false,
  },
  { id: "price", name: "Price", path: "price", type: "decimal", scale: 2 },
];
const idOnly = [
  { id: "id", name: "ID", path: "id", type: "integer", nullable: false },
];

function itemStream(
  key: string,
  path: string,
  pagination: Record<string, unknown>,
  records = "data",
  extra: Record<string, unknown> = {},
) {
  return {
    key,
    name: key,
    request: { path, ...extra },
    pagination,
    records,
    fields: itemFields,
    keyFields: ["id"],
    mode: "upsert",
    reportingField: "created",
  };
}

const dailyFields = [
  { id: "day", name: "Day", path: "date", type: "date", nullable: false },
  { id: "orders", name: "Orders", path: "orders", type: "integer" },
  {
    id: "revenue",
    name: "Revenue",
    path: "revenue.amount",
    type: "decimal",
    scale: 2,
    currencyField: "currency",
  },
  {
    id: "currency",
    name: "Currency",
    path: "revenue.currency",
    type: "string",
    nullable: false,
  },
];

function dailyStream(mode: "upsert" | "replace_window", unix: boolean) {
  return {
    key: "daily",
    name: "Daily",
    request: {
      path: "/daily",
      query: {
        from: "{{window.start}}",
        to: "{{window.end}}",
        ...(unix ? { fmt: "unix" } : {}),
      },
    },
    records: "data",
    fields: unix
      ? dailyFields.map((field) =>
          field.id === "day" ? { ...field, format: "unix_seconds" } : field,
        )
      : dailyFields,
    keyFields: ["day"],
    mode,
    reportingField: "day",
    window: {
      type: "date",
      stepDays: 31,
      lookbackDays: 3,
      backfillDays: 365,
      paramFormat: unix ? "unix_seconds" : "date",
    },
  };
}

function simple(
  key: string,
  path: string,
  fields: Record<string, unknown>[] = idOnly,
) {
  return {
    key,
    name: key,
    request: { path },
    records: "data",
    fields,
    keyFields: ["id"],
    mode: "upsert",
  };
}

function rawDefinition(name: FixtureDefinitionName): Record<string, unknown> {
  const none = { type: "none" };
  const pageNumber = {
    type: "page_number",
    param: "page",
    start: 1,
    sizeParam: "per_page",
    size: 10,
  };
  const cursor = { type: "cursor", cursorPath: "meta.next", param: "cursor" };
  let auth: Record<string, unknown> = none;
  let stream: Record<string, unknown>;
  let images: Record<string, unknown> | undefined;
  switch (name) {
    case "pages":
      stream = itemStream("items", "/items/pages", pageNumber);
      break;
    case "offset":
      stream = itemStream(
        "items",
        "/items/offset",
        {
          type: "offset",
          offsetParam: "offset",
          limitParam: "limit",
          limit: 10,
        },
        "items",
      );
      break;
    case "cursor":
      stream = itemStream("items", "/items/cursor", cursor);
      break;
    case "next_body":
      stream = itemStream("items", "/items/next-body", {
        type: "next_url",
        source: "body",
        path: "links.next",
      });
      break;
    case "next_link":
      stream = itemStream("items", "/items/next-link", {
        type: "next_url",
        source: "link_header",
      });
      break;
    case "stats":
      stream = {
        key: "stats",
        name: "Stats",
        request: { path: "/stats" },
        records: "",
        fields: [
          {
            id: "as_of",
            name: "As of",
            path: "as_of",
            type: "date",
            nullable: false,
          },
          {
            id: "visitors",
            name: "Visitors",
            path: "visitors",
            type: "integer",
          },
        ],
        keyFields: ["as_of"],
        mode: "snapshot",
      };
      break;
    case "daily":
      stream = dailyStream("upsert", false);
      break;
    case "daily_unix":
      stream = dailyStream("upsert", true);
      break;
    case "daily_replace":
      stream = dailyStream("replace_window", false);
      break;
    case "api_key_header":
      auth = { type: "api_key", placement: "header", name: "X-Api-Key" };
      stream = itemStream("items", "/auth/api-key-header", none);
      break;
    case "api_key_query":
    case "api_key_query_400":
      auth = { type: "api_key", placement: "query", name: "api_key" };
      stream = itemStream(
        "items",
        "/auth/api-key-query",
        none,
        "data",
        name === "api_key_query_400" ? { query: { bad: "1" } } : {},
      );
      break;
    case "api_key_query_echo":
      auth = { type: "api_key", placement: "query", name: "api_key" };
      stream = itemStream("items", "/auth/api-key-query-echo", {
        type: "next_url",
        source: "body",
        path: "links.next",
      });
      break;
    case "bearer":
      auth = { type: "bearer" };
      stream = itemStream("items", "/auth/bearer", none);
      break;
    case "bearer_custom":
      auth = { type: "bearer", headerName: "X-Token", prefix: "Token" };
      stream = itemStream("items", "/auth/bearer-custom", none);
      break;
    case "basic":
      auth = { type: "basic" };
      stream = itemStream("items", "/auth/basic", none);
      break;
    case "next_off_host":
      stream = itemStream("items", "/edge/next-off-host", {
        type: "next_url",
        source: "body",
        path: "links.next",
      });
      break;
    case "redirect_off_host":
      stream = itemStream("items", "/edge/redirect-off-host", none);
      break;
    case "repeat_cursor":
      stream = itemStream("items", "/edge/repeat-cursor", cursor);
      break;
    case "endless":
      stream = {
        ...itemStream("items", "/edge/endless", cursor),
        mode: "snapshot",
      };
      break;
    case "bad_values":
      stream = simple("values", "/edge/bad-values", [
        ...idOnly,
        { id: "orders", name: "Orders", path: "orders", type: "integer" },
      ]);
      break;
    case "not_json":
      stream = simple("items", "/edge/not-json");
      break;
    case "deep":
      stream = simple("items", "/edge/deep");
      break;
    case "rate_limited":
      stream = simple("items", "/edge/429");
      break;
    case "photos":
    case "photos_bearer":
      // An image stream: the newest 3 photos' images are copied.
      if (name === "photos_bearer") auth = { type: "bearer" };
      images = { hosts: ["127.0.0.1"], newestItems: 3 };
      stream = {
        key: "photos",
        name: "Photos",
        request: { path: "/photos" },
        records: "data",
        fields: [
          {
            id: "id",
            name: "ID",
            path: "id",
            type: "integer",
            nullable: false,
          },
          {
            id: "taken_at",
            name: "Taken at",
            path: "taken_at",
            type: "timestamp",
            nullable: false,
          },
          { id: "title", name: "Title", path: "title", type: "string" },
          {
            id: "photo",
            name: "Photo",
            path: "photo",
            type: "string",
            role: "image",
          },
        ],
        keyFields: ["id"],
        mode: "upsert",
        reportingField: "taken_at",
      };
      break;
  }
  return {
    schemaVersion: 1,
    name: `Fixture ${name}`,
    environments: [
      { id: "production", name: "Production", baseUrl: PLACEHOLDER_ORIGIN },
      { id: "staging", name: "Staging", baseUrl: PLACEHOLDER_ORIGIN },
    ],
    auth,
    defaults: { refreshMinutes: 60, timeZone: "UTC" },
    streams: [stream],
    ...(images ? { images } : {}),
  };
}

/** A definition against the fixture server at `origin` (both environments point there). */
export function fixtureDefinition(
  name: FixtureDefinitionName,
  origin: string,
): CustomApiDefinition {
  const parsed = customApiDefinitionSchema.parse(rawDefinition(name));
  return {
    ...parsed,
    environments: parsed.environments.map((environment) => ({
      ...environment,
      baseUrl: origin,
    })),
  };
}
