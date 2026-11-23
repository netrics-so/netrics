// Custom API definitions pointing at the fixture server, one per route
// group. Built through the definition schema (defaults applied), with the
// fixture origin as base URL: a plain-http origin is not a valid stored
// definition (https only), which is fine for package tests that never store
// one; a tls fixture origin gives a document the schema accepts.

import {
  CUSTOM_API_SCHEMA_VERSION,
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
  "api_key_self_link",
  "next_cycle",
  "next_reorder",
  "bearer",
  "bearer_custom",
  "basic",
  "next_off_host",
  "redirect_off_host",
  "repeat_cursor",
  "endless",
  "bad_values",
  "bad_pages",
  "not_json",
  "deep",
  "rate_limited",
  "photos",
  "photos_bearer",
  "oauth_client_credentials",
  "oauth_client_credentials_basic",
  "oauth_code",
  "oauth_code_no_pkce",
  "graphql",
  "graphql_number",
  "graphql_omit",
  "graphql_errors",
  "graphql_redirect",
  "json_offset",
  "redirect_same_host",
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
    case "oauth_client_credentials":
    case "oauth_client_credentials_basic":
      auth = {
        type: "oauth_client_credentials",
        tokenUrl: `${PLACEHOLDER_ORIGIN}/oauth/token`,
        scopes: ["items.read"],
        clientAuth:
          name === "oauth_client_credentials_basic" ? "basic" : "body",
      };
      stream = itemStream("items", "/oauth/api/items", { type: "none" });
      break;
    case "oauth_code":
    case "oauth_code_no_pkce":
      auth = {
        type: "oauth_authorization_code",
        authorizeUrl: `${PLACEHOLDER_ORIGIN}/oauth/authorize`,
        tokenUrl: `${PLACEHOLDER_ORIGIN}/oauth/token`,
        revokeUrl: `${PLACEHOLDER_ORIGIN}/oauth/revoke`,
        scopes: ["items.read"],
        pkce: name === "oauth_code",
        authorizeParams: { audience: "netrics" },
      };
      stream = itemStream("items", "/oauth/api/items", { type: "none" });
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
    case "graphql":
    case "graphql_number":
    case "graphql_omit":
    case "graphql_errors":
    case "graphql_redirect": {
      const path = {
        graphql: "/graphql/string-cursor",
        graphql_number: "/graphql/number-cursor",
        graphql_omit: "/graphql/omit-cursor",
        graphql_errors: "/graphql/errors",
        graphql_redirect: "/graphql/redirect",
      }[name];
      stream = itemStream(
        "items",
        path,
        {
          type: "cursor",
          cursorPath: "data.items.pageInfo.endCursor",
          bodyPath: "variables.after",
          ...(name === "graphql_omit" ? { firstPage: "omit" } : {}),
        },
        "data.items.nodes",
        {
          method: "POST",
          body: {
            kind: "graphql",
            query:
              "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id name created_at price } pageInfo { endCursor } } }",
            variables: { first: 10, after: null },
          },
        },
      );
      break;
    }
    case "json_offset":
      stream = itemStream(
        "items",
        "/query",
        {
          type: "offset",
          offsetBodyPath: "page.offset",
          limitBodyPath: "page.limit",
          limit: 10,
        },
        "items",
        {
          method: "POST",
          body: {
            kind: "json",
            value: { kind: "ItemsQuery", page: { offset: 0, limit: 0 } },
            readOnlyConfirmed: true,
          },
        },
      );
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
    case "api_key_self_link":
      auth = { type: "api_key", placement: "query", name: "api_key" };
      stream = itemStream(
        "items",
        name === "api_key_self_link"
          ? "/auth/api-key-self-link"
          : "/auth/api-key-query-echo",
        {
          type: "next_url",
          source: "body",
          path: "links.next",
        },
      );
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
    case "next_cycle":
    case "next_reorder":
      stream = itemStream(
        "items",
        name === "next_cycle" ? "/edge/next-cycle" : "/edge/next-reorder",
        { type: "next_url", source: "body", path: "links.next" },
      );
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
    case "redirect_same_host":
      stream = itemStream("items", "/edge/redirect-same-host", none);
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
    case "bad_pages":
      stream = {
        ...simple("values", "/edge/bad-pages"),
        pagination: { ...pageNumber, size: 2 },
      };
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
    schemaVersion: CUSTOM_API_SCHEMA_VERSION,
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
  /** OAuth endpoint URLs point at the fixture too. */
  const at = (url: string) => url.replace(PLACEHOLDER_ORIGIN, origin);
  const auth = parsed.auth;
  return {
    ...parsed,
    auth:
      auth.type === "oauth_client_credentials"
        ? { ...auth, tokenUrl: at(auth.tokenUrl) }
        : auth.type === "oauth_authorization_code"
          ? {
              ...auth,
              authorizeUrl: at(auth.authorizeUrl),
              tokenUrl: at(auth.tokenUrl),
              ...(auth.revokeUrl ? { revokeUrl: at(auth.revokeUrl) } : {}),
            }
          : auth,
    environments: parsed.environments.map((environment) => ({
      ...environment,
      baseUrl: origin,
    })),
  };
}
