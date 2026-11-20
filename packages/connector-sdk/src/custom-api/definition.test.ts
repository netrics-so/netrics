import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DATASET_LIMITS, sourceDatasetSchema } from "../datasets.js";
import {
  CUSTOM_API_ISSUE_CODES,
  CUSTOM_API_LIMITS,
  customApiDefinitionSchema,
  customApiIssues,
  customApiStreamSchema,
  type CustomApiDefinition,
} from "./definition.js";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixture = (name: string): Doc =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );

function minimal(): Doc {
  return {
    schemaVersion: 1,
    name: "Minimal",
    environments: [
      { id: "prod", name: "Production", baseUrl: "https://api.example.com" },
    ],
    auth: { type: "none" },
    streams: [
      {
        key: "items",
        name: "Items",
        request: { path: "/items" },
        fields: [{ id: "id", name: "ID", path: "id", type: "string" }],
        keyFields: ["id"],
        mode: "snapshot",
      },
    ],
  };
}

/** A minimal document with a non-null key, then `change` applied. */
function doc(change: (d: Doc) => void): Doc {
  const d = minimal();
  d.streams[0].fields[0].nullable = false;
  change(d);
  return d;
}

const dateField = {
  id: "day",
  name: "Day",
  path: "day",
  type: "date",
  nullable: false,
};
const dateWindow = {
  type: "date",
  stepDays: 1,
  backfillDays: 30,
  paramFormat: "date",
};

const secretInQuery = doc((d) => {
  d.variables = [{ id: "token", label: "Token", secret: true }];
  d.streams[0].request.query = { token: "{{token}}" };
});
const unknownPlaceholder = doc((d) => {
  d.streams[0].request.path = "/items/{{account_id}}";
});
const windowWithoutWindow = doc((d) => {
  d.streams[0].request.query = { from: "{{window.start}}" };
});
const wrongPagePlaceholder = doc((d) => {
  d.streams[0].pagination = { type: "page_number", param: "page" };
  d.streams[0].request.query = { c: "{{page.cursor}}" };
});
const authHeader = doc((d) => {
  d.streams[0].request.headers = { Authorization: "Bearer x" };
});
const httpBase = doc((d) => {
  d.environments[0].baseUrl = "http://api.example.com";
});
const userinfoBase = doc((d) => {
  d.environments[0].baseUrl = "https://user:pass@api.example.com";
});
const reservedParam = doc((d) => {
  d.auth = {
    type: "oauth_authorization_code",
    authorizeUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    scopes: ["read"],
    authorizeParams: { redirect_uri: "https://evil.example.com" },
  };
});
const imageOnInteger = doc((d) => {
  d.streams[0].fields.push({
    id: "n",
    name: "N",
    path: "n",
    type: "integer",
    role: "image",
  });
});
const imageWithoutReporting = doc((d) => {
  d.streams[0].fields.push({
    id: "url",
    name: "URL",
    path: "url",
    type: "string",
    role: "image",
  });
});
const replaceWithoutWindow = doc((d) => {
  d.streams[0].fields.push(dateField);
  d.streams[0].reportingField = "day";
  d.streams[0].mode = "replace_window";
});
const nullableKey = minimal();
const clash = doc((d) => {
  d.streams[0].request.query = { cursor: "x" };
  d.streams[0].pagination = {
    type: "cursor",
    cursorPath: "next",
    param: "cursor",
  };
});
const tooManyStreams = doc((d) => {
  d.streams = Array.from({ length: 21 }, (_, i) => ({
    ...d.streams[0],
    key: `s${i}`,
  }));
});

function issuesOf(input: unknown) {
  const result = customApiDefinitionSchema.safeParse(input);
  expect(result.success).toBe(false);
  return customApiIssues(result.error!);
}

describe("customApiDefinitionSchema", () => {
  it("accepts every fixture", () => {
    for (const name of ["v1-shop", "v1-all-auth", "v1-images"]) {
      const result = customApiDefinitionSchema.safeParse(fixture(name));
      expect(
        result.success,
        `${name}: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
    }
  });

  it("fills defaults", () => {
    const input = minimal();
    input.streams[0].fields.push({
      id: "key",
      name: "Key",
      path: "key",
      type: "string",
      nullable: false,
    });
    input.streams[0].keyFields = ["key"];
    const parsed = customApiDefinitionSchema.parse(input);
    expect(parsed.defaults).toEqual({ refreshMinutes: 60, timeZone: "UTC" });
    expect(parsed.variables).toEqual([]);
    expect(parsed.streams[0]!.pagination).toEqual({ type: "none" });
    expect(parsed.streams[0]!.window).toEqual({ type: "none" });
    expect(parsed.streams[0]!.records).toBe("");
    expect(parsed.streams[0]!.request).toEqual({
      path: "/items",
      query: {},
      headers: {},
    });
    expect(parsed.streams[0]!.retentionDays).toBeNull();
    expect(parsed.streams[0]!.fields[0]).toMatchObject({
      nullable: true,
      classification: "internal",
    });
  });

  it("fills auth, window and image defaults", () => {
    const bearer = customApiDefinitionSchema.parse(
      doc((d) => (d.auth = { type: "bearer" })),
    );
    expect(bearer.auth).toEqual({
      type: "bearer",
      headerName: "Authorization",
      prefix: "Bearer",
    });
    const code = customApiDefinitionSchema.parse(
      doc(
        (d) =>
          (d.auth = {
            type: "oauth_authorization_code",
            authorizeUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: [],
          }),
      ),
    );
    expect(code.auth).toMatchObject({
      pkce: true,
      clientAuth: "body",
      authorizeParams: {},
    });
    const windowed = customApiDefinitionSchema.parse(
      doc((d) => {
        d.streams[0].fields.push(dateField);
        d.streams[0].reportingField = "day";
        d.streams[0].mode = "upsert";
        d.streams[0].window = dateWindow;
        d.images = { hosts: ["img.example.com"] };
      }),
    );
    expect(windowed.streams[0]!.window).toMatchObject({
      lookbackDays: 0,
      endInclusive: false,
    });
    expect(windowed.images).toEqual({
      hosts: ["img.example.com"],
      newestItems: 12,
    });
  });

  it.each<[string, Doc, string, string]>([
    [
      "a secret variable in a query value",
      secretInQuery,
      "placeholder_secret_outside_auth",
      "streams.0.request.query.token",
    ],
    [
      "an unknown placeholder",
      unknownPlaceholder,
      "placeholder_unknown",
      "streams.0.request.path",
    ],
    [
      "window.start without a window",
      windowWithoutWindow,
      "placeholder_window_without_window",
      "streams.0.request.query.from",
    ],
    [
      "page.cursor with page_number paging",
      wrongPagePlaceholder,
      "placeholder_page_without_pagination",
      "streams.0.request.query.c",
    ],
    [
      "an Authorization request header",
      authHeader,
      "header_forbidden",
      "streams.0.request.headers.Authorization",
    ],
    ["http base URL", httpBase, "environment_url", "environments.0.baseUrl"],
    [
      "base URL with credentials",
      userinfoBase,
      "environment_url",
      "environments.0.baseUrl",
    ],
    [
      "a reserved authorize param",
      reservedParam,
      "oauth_param_reserved",
      "auth.authorizeParams.redirect_uri",
    ],
    [
      "an image role on an integer",
      imageOnInteger,
      "field_role_type",
      "streams.0.fields.1.role",
    ],
    [
      "an image stream without a reporting field",
      imageWithoutReporting,
      "image_stream_needs_reporting_field",
      "streams.0.reportingField",
    ],
    [
      "replace_window without a window",
      replaceWithoutWindow,
      "mode_window",
      "streams.0.mode",
    ],
    [
      "a nullable key field",
      nullableKey,
      "key_field_invalid",
      "streams.0.keyFields",
    ],
    [
      "a cursor param equal to a query key",
      clash,
      "pagination_param_clash",
      "streams.0.pagination.param",
    ],
    ["21 streams", tooManyStreams, "invalid", "streams"],
  ])("rejects %s", (_name, input, code, path) => {
    expect(issuesOf(input)).toContainEqual(
      expect.objectContaining({ code, path }),
    );
  });

  it.each<[string, Doc, string, string]>([
    [
      "a placeholder syntax error",
      doc((d) => (d.streams[0].request.path = "/items/{{ a b }}")),
      "placeholder_syntax",
      "streams.0.request.path",
    ],
    [
      "a request path without a leading slash",
      doc((d) => (d.streams[0].request.path = "items")),
      "invalid",
      "streams.0.request.path",
    ],
    [
      "a records path syntax error",
      doc((d) => (d.streams[0].records = "data..items")),
      "path_syntax",
      "streams.0.records",
    ],
    [
      "a field path syntax error",
      doc((d) => (d.streams[0].fields[0].path = "a[-1]")),
      "path_syntax",
      "streams.0.fields.0.path",
    ],
    [
      "a base URL with a query",
      doc((d) => (d.environments[0].baseUrl = "https://api.example.com?x=1")),
      "environment_url",
      "environments.0.baseUrl",
    ],
    [
      "a base URL with a trailing slash",
      doc((d) => (d.environments[0].baseUrl = "https://api.example.com/v1/")),
      "environment_url",
      "environments.0.baseUrl",
    ],
    [
      "a base URL with a fragment",
      doc((d) => (d.environments[0].baseUrl = "https://api.example.com#x")),
      "environment_url",
      "environments.0.baseUrl",
    ],
    [
      "a duplicate environment id",
      doc((d) => d.environments.push({ ...d.environments[0] })),
      "duplicate_id",
      "environments.1.id",
    ],
    [
      "a duplicate variable id",
      doc(
        (d) =>
          (d.variables = [
            { id: "a", label: "A" },
            { id: "a", label: "B" },
          ]),
      ),
      "duplicate_id",
      "variables.1.id",
    ],
    [
      "a duplicate stream key",
      doc((d) => d.streams.push({ ...d.streams[0] })),
      "duplicate_id",
      "streams.1.key",
    ],
    [
      "a duplicate field id",
      doc((d) =>
        d.streams[0].fields.push({ ...d.streams[0].fields[0], nullable: true }),
      ),
      "duplicate_id",
      "streams.0.fields.1.id",
    ],
    [
      "an invalid header name",
      doc((d) => (d.streams[0].request.headers = { "X Bad": "1" })),
      "header_name",
      "streams.0.request.headers.X Bad",
    ],
    [
      "a lower-case cookie header",
      doc((d) => (d.streams[0].request.headers = { cookie: "a=b" })),
      "header_forbidden",
      "streams.0.request.headers.cookie",
    ],
    [
      "a forbidden auth header",
      doc(
        (d) =>
          (d.auth = { type: "basic", headers: { "Proxy-Authorization": "x" } }),
      ),
      "header_forbidden",
      "auth.headers.Proxy-Authorization",
    ],
    [
      "an API key in the Host header",
      doc(
        (d) =>
          (d.auth = { type: "api_key", placement: "header", name: "Host" }),
      ),
      "header_forbidden",
      "auth.name",
    ],
    [
      "an API key header that is not a token",
      doc(
        (d) =>
          (d.auth = { type: "api_key", placement: "header", name: "X Key" }),
      ),
      "header_name",
      "auth.name",
    ],
    [
      "a bearer header named Cookie",
      doc((d) => (d.auth = { type: "bearer", headerName: "Cookie" })),
      "header_forbidden",
      "auth.headerName",
    ],
    [
      "auth headers on OAuth",
      doc(
        (d) =>
          (d.auth = {
            type: "oauth_client_credentials",
            tokenUrl: "https://auth.example.com/token",
            scopes: [],
            headers: { "X-Key": "{{key}}" },
          }),
      ),
      "oauth_secret_variable",
      "auth.headers",
    ],
    [
      "an http token URL",
      doc(
        (d) =>
          (d.auth = {
            type: "oauth_client_credentials",
            tokenUrl: "http://auth.example.com/token",
            scopes: [],
          }),
      ),
      "invalid",
      "auth.tokenUrl",
    ],
    [
      "a page param equal to the API key query name",
      doc((d) => {
        d.auth = { type: "api_key", placement: "query", name: "page" };
        d.streams[0].pagination = { type: "page_number", param: "page" };
      }),
      "pagination_param_clash",
      "streams.0.pagination.param",
    ],
    [
      "an API key query name equal to a request query key",
      doc((d) => {
        d.auth = { type: "api_key", placement: "query", name: "key" };
        d.streams[0].request.query = { key: "x" };
      }),
      "pagination_param_clash",
      "streams.0.request.query.key",
    ],
    [
      "offset and limit params with the same name",
      doc(
        (d) =>
          (d.streams[0].pagination = {
            type: "offset",
            offsetParam: "n",
            limitParam: "n",
            limit: 10,
          }),
      ),
      "pagination_param_clash",
      "streams.0.pagination.limitParam",
    ],
    [
      "a size param without a size",
      doc(
        (d) =>
          (d.streams[0].pagination = {
            type: "page_number",
            param: "page",
            sizeParam: "per_page",
          }),
      ),
      "invalid",
      "streams.0.pagination.size",
    ],
    [
      "page.size with page_number paging without a size",
      doc((d) => {
        d.streams[0].pagination = { type: "page_number", param: "page" };
        d.streams[0].request.query = { n: "{{page.size}}" };
      }),
      "placeholder_page_without_pagination",
      "streams.0.request.query.n",
    ],
    [
      "a window placeholder in a header",
      doc(
        (d) => (d.streams[0].request.headers = { "X-From": "{{window.end}}" }),
      ),
      "placeholder_window_without_window",
      "streams.0.request.headers.X-From",
    ],
    [
      "a secret variable in the path",
      doc((d) => {
        d.variables = [{ id: "key", label: "Key", secret: true }];
        d.streams[0].request.path = "/{{key}}";
      }),
      "placeholder_secret_outside_auth",
      "streams.0.request.path",
    ],
    [
      "a page placeholder in auth headers",
      doc(
        (d) =>
          (d.auth = { type: "none", headers: { "X-P": "{{page.number}}" } }),
      ),
      "placeholder_unknown",
      "auth.headers.X-P",
    ],
    [
      "an unknown key field",
      doc((d) => (d.streams[0].keyFields = ["nope"])),
      "key_field_invalid",
      "streams.0.keyFields",
    ],
    [
      "a json key field",
      doc((d) => {
        d.streams[0].fields[0].type = "json";
      }),
      "key_field_invalid",
      "streams.0.keyFields",
    ],
    [
      "a nullable reporting field",
      doc((d) => {
        d.streams[0].fields.push({ ...dateField, nullable: true });
        d.streams[0].reportingField = "day";
      }),
      "reporting_field_invalid",
      "streams.0.reportingField",
    ],
    [
      "a string reporting field",
      doc((d) => (d.streams[0].reportingField = "id")),
      "reporting_field_invalid",
      "streams.0.reportingField",
    ],
    [
      "a snapshot with a window",
      doc((d) => {
        d.streams[0].fields.push(dateField);
        d.streams[0].reportingField = "day";
        d.streams[0].window = dateWindow;
      }),
      "mode_window",
      "streams.0.mode",
    ],
    [
      "money without a currency field",
      doc((d) =>
        d.streams[0].fields.push({
          id: "amount",
          name: "Amount",
          path: "amount",
          type: "decimal",
          unit: "currency",
        }),
      ),
      "money_field",
      "streams.0.fields.1.unit",
    ],
    [
      "a currency field that does not exist",
      doc((d) =>
        d.streams[0].fields.push({
          id: "amount",
          name: "Amount",
          path: "amount",
          type: "decimal",
          currencyField: "currency",
        }),
      ),
      "field_unknown",
      "streams.0.fields.1.currencyField",
    ],
    [
      "money on a float",
      doc((d) =>
        d.streams[0].fields.push(
          {
            id: "amount",
            name: "Amount",
            path: "amount",
            type: "number",
            currencyField: "currency",
          },
          {
            id: "currency",
            name: "Currency",
            path: "currency",
            type: "string",
            nullable: false,
          },
        ),
      ),
      "money_field",
      "streams.0.fields.1.currencyField",
    ],
    [
      "a scale on a string",
      doc((d) => (d.streams[0].fields[0].scale = 2)),
      "scale_type",
      "streams.0.fields.0.scale",
    ],
    [
      "a personal field without retention",
      doc((d) =>
        d.streams[0].fields.push({
          id: "email",
          name: "Email",
          path: "email",
          type: "string",
          classification: "personal",
        }),
      ),
      "personal_retention",
      "streams.0.fields.1.retentionDays",
    ],
    [
      "a format on a string",
      doc((d) => (d.streams[0].fields[0].format = "iso")),
      "field_format_type",
      "streams.0.fields.0.format",
    ],
    [
      "a calendar format on a timestamp",
      doc((d) =>
        d.streams[0].fields.push({
          id: "at",
          name: "At",
          path: "at",
          type: "timestamp",
          format: "dd.MM.yyyy",
        }),
      ),
      "field_format_type",
      "streams.0.fields.1.format",
    ],
    [
      "an unknown time zone",
      doc((d) => (d.defaults = { timeZone: "Mars/Olympus" })),
      "invalid",
      "defaults.timeZone",
    ],
    [
      "an image host with a scheme",
      doc((d) => (d.images = { hosts: ["https://img.example.com"] })),
      "invalid",
      "images.hosts.0",
    ],
    [
      "an unknown property",
      doc((d) => (d.streams[0].extra = true)),
      "invalid",
      "streams.0",
    ],
    [
      "a newer schema version",
      doc((d) => (d.schemaVersion = 2)),
      "invalid",
      "schemaVersion",
    ],
    [
      "a document over the size limit",
      doc((d) => {
        d.streams = Array.from({ length: 20 }, (_, s) => ({
          ...d.streams[0],
          key: `s${s}`,
          request: {
            path: "/items",
            headers: Object.fromEntries(
              Array.from({ length: 10 }, (_, h) => [
                `X-H${h}`,
                "v".repeat(1_500),
              ]),
            ),
          },
        }));
      }),
      "document_too_large",
      "",
    ],
  ])("rejects %s", (_name, input, code, path) => {
    expect(issuesOf(input)).toContainEqual(
      expect.objectContaining({ code, path }),
    );
  });

  it.each<[string, Doc]>([
    [
      "secret variables in auth headers",
      doc((d) => {
        d.variables = [
          { id: "key", label: "Key", secret: true },
          { id: "tenant", label: "Tenant" },
        ];
        d.auth = {
          type: "none",
          headers: { "X-Key": "{{key}}", "X-Tenant": "{{tenant}}" },
        };
      }),
    ],
    [
      "page.offset and page.size with a sized page_number",
      doc((d) => {
        d.streams[0].pagination = {
          type: "page_number",
          param: "page",
          start: 0,
          sizeParam: "size",
          size: 25,
        };
        d.streams[0].request.query = {
          o: "{{page.offset}}",
          s: "{{page.size}}",
          n: "{{page.number}}",
        };
      }),
    ],
    [
      "page.cursor with cursor paging",
      doc((d) => {
        d.streams[0].pagination = {
          type: "cursor",
          cursorPath: "meta.next",
          param: "after",
        };
        d.streams[0].request.headers = { "X-Cursor": "{{page.cursor}}" };
      }),
    ],
    [
      "client credentials with basic client auth",
      doc(
        (d) =>
          (d.auth = {
            type: "oauth_client_credentials",
            tokenUrl: "https://auth.example.com/oauth/token?tenant=a",
            scopes: ["read", "write"],
            clientAuth: "basic",
          }),
      ),
    ],
    [
      "a bearer token with an empty prefix in a custom header",
      doc(
        (d) => (d.auth = { type: "bearer", headerName: "X-Token", prefix: "" }),
      ),
    ],
    [
      "a base URL with a port and path",
      doc(
        (d) =>
          (d.environments[0].baseUrl = "https://api.example.com:8443/v2/beta"),
      ),
    ],
  ])("accepts %s", (_name, input) => {
    const result = customApiDefinitionSchema.safeParse(input);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("never puts input values into issues", () => {
    const input = doc((d) => {
      d.variables = [
        {
          id: "key",
          label: "API key",
          secret: true,
          value: "sk_live_abcdef",
        },
      ];
      d.streams[0].request.query = { key: "{{key}}" };
      d.streams[0].request.headers = { "X-Key": "sk_live_abcdef".repeat(200) };
      d.environments[0].baseUrl = "https://sk_live_abcdef@api.example.com";
      d.images = { hosts: ["sk_live_abcdef/"] };
    });
    const issues = issuesOf(input);
    expect(issues.length).toBeGreaterThan(1);
    expect(JSON.stringify(issues)).not.toContain("sk_live_abcdef");
  });

  it("caps issues at 20", () => {
    const input = doc((d) => {
      d.streams[0].request.query = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`q${i}`, `{{unknown_${i}}}`]),
      );
    });
    const result = customApiDefinitionSchema.safeParse(input);
    expect(result.error!.issues.length).toBeGreaterThan(20);
    expect(customApiIssues(result.error!)).toHaveLength(20);
  });

  it("uses only known issue codes", () => {
    const all = [
      secretInQuery,
      unknownPlaceholder,
      authHeader,
      httpBase,
      reservedParam,
      clash,
    ].flatMap(issuesOf);
    for (const issue of all)
      expect([...CUSTOM_API_ISSUE_CODES, "invalid"]).toContain(issue.code);
  });

  it("drops __proto__ keys instead of polluting prototypes", () => {
    const input = doc(() => {});
    input.streams[0].request.headers = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"Accept":"x"}',
    );
    const result = customApiDefinitionSchema.safeParse(input);
    if (result.success) {
      const headers = result.data.streams[0]!.request.headers;
      expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
      expect(Object.keys(headers)).toEqual(["Accept"]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("yields a valid source dataset for every stream", () => {
    for (const name of ["v1-shop", "v1-all-auth", "v1-images"]) {
      const definition: CustomApiDefinition = customApiDefinitionSchema.parse(
        fixture(name),
      );
      for (const stream of definition.streams) {
        const result = sourceDatasetSchema.safeParse({
          key: stream.key,
          name: stream.name,
          version: 1,
          fields: stream.fields.map(
            ({ path: _path, format: _format, role: _role, ...field }) => field,
          ),
          keyFields: stream.keyFields,
          grain: stream.name,
          mode: stream.mode,
          reportingField: stream.reportingField,
          reportingTimeZone: definition.defaults.timeZone,
          retentionDays: stream.retentionDays,
        });
        expect(result.success, `${name}/${stream.key}`).toBe(true);
      }
    }
  });

  it("keeps limits in step with the dataset limits", () => {
    expect(CUSTOM_API_LIMITS.streams).toBe(DATASET_LIMITS.datasets);
    expect(CUSTOM_API_LIMITS.fieldsPerStream).toBe(DATASET_LIMITS.fields);
  });

  it("exports an extendable strict stream schema", () => {
    const extended = customApiStreamSchema.extend({});
    expect(
      extended.safeParse({ ...minimal().streams[0], extra: 1 }).success,
    ).toBe(false);
  });
});
