import { randomUUID } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  customApiDraftResponseSchema,
  customApiTestResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  FIXTURE_SECRETS,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "@netrics/connectors/custom-api/testing";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
  type Transaction,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  releaseCustomApiTestLease,
  takeCustomApiTestLease,
  takeCustomApiTestSlot,
} from "./custom-api/test-rate.js";
import { loadConfig } from "./env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The builder's test request (#806): bounded, value-redacted answers, no
// request to a host the secrets were not entered for, and at most 30 test
// requests per workspace and minute.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const KEY = Buffer.alloc(32, 5).toString("base64");
const TOKEN = FIXTURE_SECRETS.token;

let fixture: CustomApiFixtureServer;
let app: FastifyInstance;
let blockedApp: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let workspaceId: string;
let clock = Date.now();

function call(
  method: "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  target: FastifyInstance = app,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie: owner },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return target.inject(options);
}

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function newWorkspace(name: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", { name });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const drafts = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/drafts`;

interface DraftInput {
  path?: string;
  records?: string;
  auth?: Record<string, unknown>;
  baseUrl?: string;
  pagination?: Record<string, unknown>;
  fields?: Record<string, unknown>[];
  window?: Record<string, unknown>;
}

const STATS_FIELDS = [
  { id: "date", name: "Date", path: "date", type: "date" },
  { id: "orders", name: "Orders", path: "orders", type: "integer" },
  {
    id: "revenue",
    name: "Revenue",
    path: "revenue.amount",
    type: "decimal",
    currencyField: "currency",
  },
  {
    id: "currency",
    name: "Currency",
    path: "revenue.currency",
    type: "string",
  },
];

function draftDefinition(input: DraftInput = {}) {
  return {
    name: "Builder stats",
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: input.baseUrl ?? fixture.origin,
      },
    ],
    auth: input.auth ?? { type: "bearer" },
    defaults: { timeZone: "UTC" },
    stream: {
      key: "stats",
      name: "Stats",
      request: { path: input.path ?? "/builder/stats" },
      pagination: input.pagination ?? {
        type: "cursor",
        cursorPath: "meta.next",
        param: "cursor",
      },
      records: input.records ?? "data",
      fields: input.fields ?? STATS_FIELDS,
      mode: "upsert",
      ...(input.window ? { window: input.window } : {}),
    },
  };
}

const statsDraft = () => draftDefinition();

async function newDraft(
  secrets: Record<string, string> | null = { token: TOKEN },
  definition: Record<string, unknown> = statsDraft(),
  workspace = workspaceId,
): Promise<string> {
  const created = await call("POST", drafts(workspace), {});
  expect(created.statusCode, created.body).toBe(201);
  const id = customApiDraftResponseSchema.parse(created.json()).draft.id;
  const stored = await call("PUT", `${drafts(workspace)}/${id}`, {
    definition,
    environmentId: "production",
    ...(secrets ? { secrets } : {}),
  });
  expect(stored.statusCode, stored.body).toBe(200);
  return id;
}

function testRequest(
  id: string,
  body: Record<string, unknown>,
  workspace = workspaceId,
  target = app,
) {
  return call(
    "POST",
    `${drafts(workspace)}/${id}/test`,
    { environmentId: "production", ...body },
    target,
  );
}

function parsed(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  return customApiTestResponseSchema.parse(response.json());
}

beforeAll(async () => {
  fixture = await startCustomApiFixtureServer({ tls: true });
  const testDb = await createTestDatabase();
  const env = {
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: KEY,
  };
  const config = loadConfig(env);
  db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const now = () => new Date(clock);
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    now,
    executeOptions: {
      egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
    },
  });
  // Same instance without the private host allowlist (hosted).
  blockedApp = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    now,
    executeOptions: { egress: { tlsCa: fixture.ca! } },
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("tests-owner@example.com");
  workspaceId = await newWorkspace("Test requests");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await blockedApp?.close();
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await fixture?.close();
});

beforeEach(async () => {
  // A fresh rate window for every case, and room below the draft limit.
  clock += 61_000;
  await admin`delete from custom_api_test_rate`;
  await admin`delete from connections where status = 'draft'`;
  fixture.reset();
});

describe("the custom API test request", () => {
  it("returns the first page, record arrays, suggestions, mapped rows and a log per page", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, { definition: statsDraft(), pages: 2 }),
    );
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(body.recordArrays[0]).toEqual({ path: "data", length: 3 });
    expect(body.records).toEqual({ path: "data", count: 3, found: true });
    expect(body.suggestions.find((s) => s.path === "date")).toMatchObject({
      type: "date",
      format: "iso",
    });
    expect(
      body.suggestions.find((s) => s.path === "revenue.amount"),
    ).toMatchObject({ type: "decimal" });
    expect(body.rows).toHaveLength(6);
    expect(body.rows[0]).toEqual({
      date: "2024-01-01",
      orders: 1,
      revenue: "12.50",
      currency: "EUR",
    });
    expect(body.log.map((l) => [l.page, l.status])).toEqual([
      [1, 200],
      [2, 200],
    ]);
    expect(body.log[1]!.url).toMatch(/cursor=/);
    expect(body.stopped).toBe("end");
    expect(body.response).toMatchObject({ status: 200, truncated: false });
    expect(body.draft.secretsSet).toEqual(["token"]);
    expect(body.window).toBeNull();
  });

  it("stores the tested definition on the draft", async () => {
    const id = await newDraft();
    const definition = draftDefinition({ path: "/builder/echo" });
    parsed(await testRequest(id, { definition }));
    const [row] = await admin`select config from connections where id = ${id}`;
    expect(row!.config.draft.definition.stream.request.path).toBe(
      "/builder/echo",
    );
  });

  it("never returns the token, even when the API echoes it", async () => {
    const id = await newDraft();
    const res = await testRequest(id, {
      definition: draftDefinition({
        path: "/builder/echo",
        pagination: { type: "none" },
        fields: [{ id: "url", name: "URL", path: "url", type: "string" }],
      }),
    });
    const body = parsed(res);
    expect(body.ok).toBe(true);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain(encodeURIComponent(TOKEN));
    expect(res.body).toContain("[redacted]");
    expect(body.response!.body).toMatchObject({
      whoami: "[redacted]",
    });
  });

  it("redacts an API key sent as a query parameter from the log URL and an error body", async () => {
    const auth = { type: "api_key", placement: "query", name: "api_key" };
    const key = { apiKey: FIXTURE_SECRETS.apiKey };
    const definition = draftDefinition({
      path: "/auth/api-key-query",
      auth,
      pagination: { type: "none" },
      fields: [{ id: "id", name: "ID", path: "id", type: "integer" }],
    });
    const id = await newDraft(key, definition);
    const res = await testRequest(id, { definition });
    const body = parsed(res);
    expect(body.ok).toBe(true);
    expect(body.log[0]!.url).toContain("api_key=[redacted]");
    expect(res.body).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(fixture.requests[0]!.query.api_key).toBe(FIXTURE_SECRETS.apiKey);

    // An error page that quotes the key.
    const bad = {
      ...definition,
      stream: {
        ...definition.stream,
        request: { ...definition.stream.request, query: { bad: "1" } },
      },
    };
    const failed = await testRequest(id, { definition: bad });
    const failedBody = parsed(failed);
    expect(failedBody.error?.code).toBe("custom_api_http_error");
    expect(failedBody.response?.status).toBe(400);
    expect(failed.body).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(JSON.stringify(failedBody.response!.body)).toContain("[redacted]");
  });

  it("returns no part of a 32-character key the API echoes in a URL, not even across a cut (review #820)", async () => {
    const key = "k3y5ecretZq8LmN0pW2xR7vT4bY6cH9d";
    const prefix = `${fixture.origin}/builder/echo-query?pad=`;
    // The key starts a few characters before the 80-character sample cut.
    const pad = "p".repeat(
      Math.max(1, 70 - prefix.length - "&api_key=".length),
    );
    const definition = draftDefinition({
      path: "/builder/echo-query",
      auth: { type: "api_key", placement: "query", name: "api_key" },
      pagination: { type: "none" },
      fields: [{ id: "url", name: "URL", path: "url", type: "string" }],
    });
    definition.stream.request = {
      path: "/builder/echo-query",
      query: { pad },
    } as never;
    const id = await newDraft({ apiKey: key }, definition);
    const res = await testRequest(id, { definition });
    const body = parsed(res);
    expect(body.ok).toBe(true);
    const echoed = String(
      (fixture.requests[0]!.query as Record<string, string>).api_key,
    );
    expect(echoed).toBe(key);
    const at = `${prefix}${pad}&api_key=`.length;
    expect(at).toBeLessThan(79);
    expect(at + key.length).toBeGreaterThan(79);
    expect(body.suggestions[0]!.samples[0]).toContain("[redacted]");
    for (let i = 0; i + 6 <= key.length; i++)
      expect(res.body).not.toContain(key.slice(i, i + 6));
  });

  it("keeps the whole answer within 1 MiB and says it cut the rows", async () => {
    const definition = draftDefinition({
      path: "/builder/wide",
      auth: { type: "none" },
      pagination: { type: "none" },
      fields: Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        name: `F${i}`,
        path: `f${i}`,
        type: "string",
      })),
    });
    const id = await newDraft(null, definition);
    const res = await testRequest(id, { definition });
    const body = parsed(res);
    expect(body.ok).toBe(true);
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(1_048_576);
    expect(body.truncated).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(body.rows))).toBeLessThanOrEqual(
      524_288,
    );
  });

  it("makes no request when the base URL host changed after the secret was entered", async () => {
    const id = await newDraft();
    const moved = draftDefinition({ baseUrl: "https://other.example.test/v1" });
    const res = await testRequest(id, { definition: moved });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("custom_api_credentials_host_changed");
    expect(fixture.requests).toHaveLength(0);
    // The secret is gone: the Login step asks for it again.
    const [row] = await admin`
      select credentials_encrypted from connections where id = ${id}`;
    expect(row!.credentials_encrypted).toBeNull();
    const again = parsed(await testRequest(id, { definition: statsDraft() }));
    expect(again.error?.code).toBe("custom_api_secret_missing");
    expect(fixture.requests).toHaveLength(0);
  });

  it("says which JSON type it found when the record path is not a list", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, {
        definition: draftDefinition({ records: "meta.next" }),
      }),
    );
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({
      code: "custom_api_records_not_array",
      message: expect.stringContaining("string"),
    });
    expect(body.response?.status).toBe(200);
    expect(body.recordArrays[0]).toEqual({ path: "data", length: 3 });
  });

  it("reports a rejected login as auth rejected without the secret", async () => {
    const id = await newDraft({ token: "wrong-token-value" });
    const res = await testRequest(id, { definition: statsDraft() });
    const body = parsed(res);
    expect(body.error?.code).toBe("custom_api_auth_rejected");
    expect(body.log[0]!.status).toBe(401);
    expect(res.body).not.toContain("wrong-token-value");
  });

  it("refuses a private address outside the instance allowlist", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(
        id,
        { definition: statsDraft() },
        workspaceId,
        blockedApp,
      ),
    );
    expect(body.error?.code).toBe("custom_api_destination_blocked");
    expect(body.error?.message).toBe(
      "netrics may not reach this address. Custom APIs must be public https hosts.",
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("names the private-host allowance when the instance has one (#834)", async () => {
    const definition = draftDefinition({
      baseUrl: fixture.origin.replace("127.0.0.1", "localhost"),
    });
    const id = await newDraft({ token: TOKEN }, definition);
    const body = parsed(await testRequest(id, { definition }));
    expect(body.error?.code).toBe("custom_api_destination_blocked");
    expect(body.error?.message).toContain("NETRICS_CUSTOM_API_PRIVATE_HOSTS");
    expect(fixture.requests).toHaveLength(0);
  });

  it("stops at the page limit and says so", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, { definition: statsDraft(), pages: 1 }),
    );
    expect(body.stopped).toBe("page_limit");
    expect(body.rows).toHaveLength(3);
  });

  it("answers 404 for a pruned draft", async () => {
    const id = await newDraft();
    await admin`delete from connections where id = ${id}`;
    const res = await testRequest(id, { definition: statsDraft() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("custom_api_draft_not_found");
    expect(
      (await testRequest(randomUUID(), { definition: statsDraft() }))
        .statusCode,
    ).toBe(404);
  });

  it("returns at most 256 KiB of response body for a huge page", async () => {
    const definition = draftDefinition({
      path: "/builder/huge",
      auth: { type: "none" },
      pagination: { type: "none" },
      fields: [{ id: "id", name: "ID", path: "id", type: "integer" }],
    });
    const id = await newDraft(null, definition);
    const res = await testRequest(id, { definition });
    const body = parsed(res);
    expect(body.ok).toBe(true);
    expect(body.response!.truncated).toBe(true);
    expect(body.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(body.response!.body)),
    ).toBeLessThanOrEqual(262_144);
    expect(body.records.count).toBe(100_000);
    expect(body.rows).toHaveLength(100);
    expect(body.stopped).toBe("record_limit");
    expect(body.suggestions.map((s) => s.path)).toEqual(["id", "name"]);
  });

  it("reads the default window: the last step ending today", async () => {
    const definition = draftDefinition({
      window: {
        type: "date",
        stepDays: 7,
        backfillDays: 30,
        paramFormat: "date",
      },
    });
    definition.stream.request = {
      path: "/builder/stats",
      query: { from: "{{window.start}}", to: "{{window.end}}" },
    } as never;
    const id = await newDraft({ token: TOKEN }, definition);
    const body = parsed(await testRequest(id, { definition }));
    const today = new Date(clock).toISOString().slice(0, 10);
    expect(body.window?.end).toBe(
      new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    expect(fixture.requests[0]!.query.from).toBe(body.window!.start);
    const explicit = parsed(
      await testRequest(id, {
        definition,
        window: {
          start: "2024-03-01T00:00:00.000Z",
          end: "2024-03-04T00:00:00.000Z",
        },
      }),
    );
    expect(explicit.rows[0]).toMatchObject({ date: "2024-03-01" });
  });

  it("asks for a missing secret before any request", async () => {
    const id = await newDraft(null);
    const body = parsed(await testRequest(id, { definition: statsDraft() }));
    expect(body.error?.code).toBe("custom_api_secret_missing");
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses a secret connection value named like a credential, without a request (review #824)", async () => {
    const id = await newDraft();
    const response = await testRequest(id, {
      definition: {
        ...statsDraft(),
        variables: [{ id: "password", label: "Password", secret: true }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({ error: "custom_api_variable_reserved" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("still follows a same-host redirect of a GET request (ADR 0027)", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, {
        definition: draftDefinition({
          path: "/edge/redirect-same-host",
          pagination: { type: "none" },
          fields: [{ id: "id", name: "ID", path: "id", type: "integer" }],
        }),
      }),
    );
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(fixture.requests.map((r) => r.path)).toEqual([
      "/edge/redirect-same-host",
      "/items/pages",
    ]);
  });
});

describe("read-only POST test requests (ADR 0030)", () => {
  const ID_FIELD = [{ id: "id", name: "ID", path: "id", type: "integer" }];
  const QUERY =
    "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { endCursor } } }";

  function graphqlDraft(path = "/graphql/string-cursor", query = QUERY) {
    const base = draftDefinition({
      path,
      records: "data.items.nodes",
      fields: ID_FIELD,
      pagination: {
        type: "cursor",
        cursorPath: "data.items.pageInfo.endCursor",
        bodyPath: "variables.after",
      },
    });
    return {
      ...base,
      stream: {
        ...base.stream,
        request: {
          method: "POST",
          path,
          body: {
            kind: "graphql",
            query,
            variables: { first: 10, after: null },
          },
        },
      },
    };
  }

  function jsonDraft(kind = "ItemsQuery", value = "v1") {
    const base = draftDefinition({
      path: "/query",
      records: "items",
      fields: ID_FIELD,
      pagination: {
        type: "offset",
        offsetBodyPath: "page.offset",
        limitBodyPath: "page.limit",
        limit: 10,
      },
    });
    return {
      ...base,
      variables: [{ id: "tenant", label: "Tenant", secret: false }],
      stream: {
        ...base.stream,
        request: {
          method: "POST",
          path: "/query",
          body: {
            kind: "json",
            value: {
              kind,
              tenant: "{{tenant}}",
              version: value,
              page: { offset: 0, limit: 0 },
            },
          },
        },
      },
    };
  }

  it("sends a GraphQL query and pages through its variables", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, { definition: graphqlDraft(), pages: 3 }),
    );
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(body.log.map((l) => [l.method, l.status])).toEqual([
      ["POST", 200],
      ["POST", 200],
      ["POST", 200],
    ]);
    expect(body.rows).toHaveLength(25);
    expect(
      fixture.requests.map((r) => JSON.parse(r.body!).variables.after),
    ).toEqual([null, "c10", "c20"]);
  });

  it.each([
    ["a mutation", "mutation { deleteItems { id } }"],
    ["a subscription", "subscription { items { id } }"],
    ["two operations", "query A { a } query B { b }"],
    ["a fragment definition", "query A { ...F } fragment F on Query { a }"],
  ])(
    "refuses %s before anything is sent, as a saved definition does",
    async (_label, query) => {
      const id = await newDraft();
      const response = await testRequest(id, {
        definition: graphqlDraft("/graphql/string-cursor", query),
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        error: "invalid_request",
        issues: [
          {
            path: "definition.stream.request.body.query",
            code: "graphql_operation",
          },
        ],
      });
      expect(fixture.requests).toHaveLength(0);
    },
  );

  it("refuses page placeholders in the body and reserved URL parameters", async () => {
    const id = await newDraft();
    const definition = graphqlDraft();
    definition.stream.request.body.variables.after =
      "{{page.cursor}}" as unknown as null;
    (definition.stream.request as Record<string, unknown>).query = {
      operationName: "Items",
    };
    const response = await testRequest(id, { definition });
    expect(response.statusCode, response.body).toBe(400);
    const codes = (
      response.json() as { issues: { code: string }[] }
    ).issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "placeholder_page_in_body",
        "graphql_param_reserved",
      ]),
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("fails on GraphQL errors without the response's error text", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, { definition: graphqlDraft("/graphql/errors") }),
    );
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({
      code: "custom_api_graphql_errors",
      message:
        "The GraphQL API answered with errors (graphql_errors): stream stats, HTTP 200, 2 errors.",
    });
  });

  it("follows no redirect of a POST: the 3xx fails the test", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, { definition: graphqlDraft("/graphql/redirect") }),
    );
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({
      code: "custom_api_http_error",
      message:
        "The API answered HTTP 307, a redirect. A POST request follows no redirects.",
    });
    expect(fixture.requests.map((r) => r.path)).toEqual(["/graphql/redirect"]);
  });

  it("sends a JSON body only with the confirmation of exactly that request", async () => {
    const id = await newDraft();
    const variables = { tenant: "acme" };
    const unconfirmed = await testRequest(id, {
      definition: jsonDraft(),
      variables,
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
    const { error, readOnlyConfirmation } = unconfirmed.json() as {
      error: string;
      readOnlyConfirmation: string;
    };
    expect(error).toBe("custom_api_read_only_unconfirmed");
    expect(readOnlyConfirmation).toMatch(/^[0-9a-f]{64}$/);

    const wrong = await testRequest(id, {
      definition: jsonDraft(),
      variables,
      readOnlyConfirmation: "0".repeat(64),
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      error: "custom_api_read_only_unconfirmed",
      readOnlyConfirmation,
    });
    expect(fixture.requests).toHaveLength(0);

    const confirmed = parsed(
      await testRequest(id, {
        definition: jsonDraft(),
        variables,
        readOnlyConfirmation,
        pages: 3,
      }),
    );
    expect(confirmed.ok, JSON.stringify(confirmed.error)).toBe(true);
    expect(confirmed.rows).toHaveLength(25);
    expect(fixture.requests.map((r) => JSON.parse(r.body!))).toEqual(
      [0, 10, 20].map((offset) => ({
        kind: "ItemsQuery",
        tenant: "acme",
        version: "v1",
        page: { offset, limit: 10 },
      })),
    );
  });

  /** A JSON body that reads a date window and is echoed back by /query-echo. */
  function windowedDraft(path = "/query") {
    const base = jsonDraft();
    return {
      ...base,
      stream: {
        ...base.stream,
        request: {
          ...base.stream.request,
          path,
          body: {
            kind: "json",
            value: {
              kind: "ItemsQuery",
              from: "{{window.start}}",
              to: "{{window.end}}",
              page: { offset: 0, limit: 0 },
            },
          },
        },
        window: {
          type: "date",
          stepDays: 1,
          backfillDays: 30,
          paramFormat: "date",
        },
      },
    };
  }

  it("confirms the window it sends: another window needs another confirmation", async () => {
    const id = await newDraft();
    const marchFirst = {
      start: "2024-03-01T00:00:00.000Z",
      end: "2024-03-02T00:00:00.000Z",
    };
    const marchSecond = {
      start: "2024-03-02T00:00:00.000Z",
      end: "2024-03-03T00:00:00.000Z",
    };
    const confirmationFor = async (window: typeof marchFirst) => {
      const response = await testRequest(id, {
        definition: windowedDraft(),
        variables: { tenant: "acme" },
        window,
      });
      expect(response.statusCode, response.body).toBe(400);
      return (response.json() as { readOnlyConfirmation: string })
        .readOnlyConfirmation;
    };
    const first = await confirmationFor(marchFirst);
    expect(await confirmationFor(marchSecond)).not.toBe(first);
    // A confirmation for one window does not send another.
    const other = await testRequest(id, {
      definition: windowedDraft(),
      variables: { tenant: "acme" },
      window: marchSecond,
      readOnlyConfirmation: first,
    });
    expect(other.statusCode).toBe(400);
    expect(fixture.requests).toHaveLength(0);
    // The confirmed window is the one sent.
    const sent = parsed(
      await testRequest(id, {
        definition: windowedDraft(),
        variables: { tenant: "acme" },
        window: marchFirst,
        readOnlyConfirmation: first,
      }),
    );
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    expect(JSON.parse(fixture.requests[0]!.body!)).toMatchObject({
      from: "2024-03-01",
      to: "2024-03-02",
    });
  });

  it("redacts the body it sent from the response preview", async () => {
    const id = await newDraft();
    const window = {
      start: "2024-03-01T00:00:00.000Z",
      end: "2024-03-02T00:00:00.000Z",
    };
    const definition = windowedDraft("/query-echo");
    const unconfirmed = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
    });
    const { readOnlyConfirmation } = unconfirmed.json() as {
      readOnlyConfirmation: string;
    };
    const res = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
      readOnlyConfirmation,
    });
    const body = parsed(res);
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    const sentBody = fixture.requests[0]!.body!;
    expect(sentBody).toContain('"from":"2024-03-01"');
    expect(body.response!.body).toMatchObject({ echo: "[redacted]" });
    expect(res.body).not.toContain(JSON.stringify(sentBody).slice(1, -1));
    // The public log carries no body.
    expect(JSON.stringify(body.log)).not.toContain("ItemsQuery");
  });

  it("redacts the body it sent when the API echoes it as JSON, in the preview and the suggestions (#885)", async () => {
    const id = await newDraft();
    const window = {
      start: "2024-03-01T00:00:00.000Z",
      end: "2024-03-02T00:00:00.000Z",
    };
    const definition = windowedDraft("/query-echo-json");
    const unconfirmed = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
    });
    const { readOnlyConfirmation } = unconfirmed.json() as {
      readOnlyConfirmation: string;
    };
    const res = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
      readOnlyConfirmation,
    });
    const body = parsed(res);
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(JSON.parse(fixture.requests[0]!.body!)).toMatchObject({
      kind: "ItemsQuery",
      from: "2024-03-01",
    });
    expect(body.response!.body).toEqual({
      items: [{ id: 1, request: "[redacted]" }],
      json: "[redacted]",
    });
    expect(body.suggestions.map((s) => [s.path, s.samples])).toEqual([
      ["id", ["1"]],
      ["request", ["[redacted]"]],
    ]);
    expect(res.body).not.toContain("ItemsQuery");
    expect(body.recordArrays.map((a) => a.path)).toEqual(["items"]);
  });

  it("redacts mapped cells read from a body the API echoes as JSON (#930 review)", async () => {
    const window = {
      start: "2024-03-01T00:00:00.000Z",
      end: "2024-03-02T00:00:00.000Z",
    };
    const run = async (records: string, fields: unknown[]) => {
      const id = await newDraft();
      const base = windowedDraft("/query-echo-json");
      const definition = {
        ...base,
        stream: { ...base.stream, records, fields },
      };
      const unconfirmed = await testRequest(id, {
        definition,
        variables: { tenant: "acme" },
        window,
      });
      const { readOnlyConfirmation } = unconfirmed.json() as {
        readOnlyConfirmation: string;
      };
      const res = await testRequest(id, {
        definition,
        variables: { tenant: "acme" },
        window,
        readOnlyConfirmation,
      });
      const body = parsed(res);
      expect(body.ok, JSON.stringify(body.error)).toBe(true);
      expect(res.body).not.toContain("ItemsQuery");
      return body.rows;
    };
    // Fields under an echoed value of the record: those cells only.
    expect(
      await run("items", [
        ...ID_FIELD,
        {
          id: "query_kind",
          name: "Kind",
          path: "request.kind",
          type: "string",
        },
        {
          id: "page_limit",
          name: "Limit",
          path: "request.page.limit",
          type: "integer",
        },
      ]),
    ).toEqual([{ id: 1, query_kind: "[redacted]", page_limit: "[redacted]" }]);
    // Records that are the echoed body: every cell.
    expect(
      await run("json", [
        { id: "query_kind", name: "Kind", path: "kind", type: "string" },
      ]),
    ).toEqual([{ query_kind: "[redacted]" }]);
  });

  it("redacts a large non-ASCII body it sent without a 500 (review round 2)", async () => {
    const id = await newDraft();
    const window = {
      start: "2024-03-01T00:00:00.000Z",
      end: "2024-03-02T00:00:00.000Z",
    };
    const definition = windowedDraft("/query-echo");
    // About 60 KB of non-ASCII text, just inside the template limit.
    const text = "ü€ö".repeat(2_800);
    (definition.stream.request.body.value as Record<string, unknown>).notes = [
      text,
      text,
      text,
    ];
    const unconfirmed = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
    const { readOnlyConfirmation } = unconfirmed.json() as {
      readOnlyConfirmation: string;
    };
    const res = await testRequest(id, {
      definition,
      variables: { tenant: "acme" },
      window,
      readOnlyConfirmation,
    });
    const body = parsed(res);
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(body.response!.body).toMatchObject({ echo: "[redacted]" });
    expect(res.body).not.toContain(text);
  });

  it("answers graphql_errors for an error envelope on a 400", async () => {
    const id = await newDraft();
    const body = parsed(
      await testRequest(id, {
        definition: graphqlDraft("/graphql/errors-400"),
      }),
    );
    expect(body.error).toEqual({
      code: "custom_api_graphql_errors",
      message:
        "The GraphQL API answered with errors (graphql_errors): stream stats, HTTP 400, 1 error.",
    });
  });

  it("refuses a page value in a POST path before anything is sent", async () => {
    const id = await newDraft();
    const definition = graphqlDraft();
    definition.stream.request.path = "/graphql/{{page.cursor}}";
    const response = await testRequest(id, { definition });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      issues: [
        {
          path: "definition.stream.request.path",
          code: "placeholder_page_in_post_path",
        },
      ],
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it("clears the confirmation when the request changes, not when a secret does", async () => {
    const id = await newDraft();
    const confirmationOf = async (
      definition: Record<string, unknown>,
      variables: Record<string, string>,
    ) => {
      const response = await testRequest(id, { definition, variables });
      expect(response.statusCode, response.body).toBe(400);
      return (response.json() as { readOnlyConfirmation: string })
        .readOnlyConfirmation;
    };
    const base = await confirmationOf(jsonDraft(), { tenant: "acme" });
    // The body template, a non-secret value it uses, the pagination rule,
    // a header template and the auth placement each change it.
    expect(
      await confirmationOf(jsonDraft("Other"), { tenant: "acme" }),
    ).not.toBe(base);
    expect(await confirmationOf(jsonDraft(), { tenant: "other" })).not.toBe(
      base,
    );
    const paged = jsonDraft();
    (paged.stream.pagination as { limit: number }).limit = 5;
    expect(await confirmationOf(paged, { tenant: "acme" })).not.toBe(base);
    const headed = jsonDraft();
    (headed.stream.request as Record<string, unknown>).headers = {
      "X-Mode": "read",
    };
    expect(await confirmationOf(headed, { tenant: "acme" })).not.toBe(base);
    const keyed = {
      ...jsonDraft(),
      auth: { type: "api_key", placement: "header", name: "X-Key" },
    };
    expect(await confirmationOf(keyed, { tenant: "acme" })).not.toBe(base);
    // A new secret value leaves it as it was: secrets are never part of it.
    const stored = await call("PUT", `${drafts()}/${id}`, {
      definition: jsonDraft(),
      environmentId: "production",
      secrets: { token: `${TOKEN}-rotated` },
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(await confirmationOf(jsonDraft(), { tenant: "acme" })).toBe(base);
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("the test request rate limit", () => {
  // 31 sequential test requests, each with its rate and lease round trips:
  // a 20 s timeout leaves room for a machine running every suite at once.
  it("allows 30 test requests per workspace per minute and answers the 31st with 429 and Retry-After, without a request", async () => {
    const workspace = await newWorkspace("Rate limited");
    const definition = draftDefinition({
      path: "/stats",
      auth: { type: "none" },
      pagination: { type: "none" },
      records: "",
      fields: [
        { id: "visitors", name: "V", path: "visitors", type: "integer" },
      ],
    });
    const first = await newDraft(null, definition, workspace);
    const second = await newDraft(null, definition, workspace);
    for (let i = 0; i < 30; i++) {
      const res = await testRequest(
        i % 2 ? first : second,
        { definition },
        workspace,
      );
      expect(res.statusCode, `${i}: ${res.body}`).toBe(200);
    }
    const requests = fixture.requests.length;
    expect(requests).toBe(30);
    // The window runs on the database clock: 10 s into it.
    await admin`update custom_api_test_rate
      set window_start = now() - interval '10 seconds'
      where workspace_id = ${workspace}`;
    const limited = await testRequest(first, { definition }, workspace);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "custom_api_test_rate_limited" });
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(retryAfter).toBe(50);
    expect(fixture.requests).toHaveLength(requests);
    // Another workspace has its own budget.
    const other = await newDraft(null, definition);
    expect((await testRequest(other, { definition })).statusCode).toBe(200);
    await admin`update custom_api_test_rate
      set window_start = now() - interval '61 seconds'
      where workspace_id = ${workspace}`;
    expect(
      (await testRequest(first, { definition }, workspace)).statusCode,
    ).toBe(200);
  }, 20_000);

  it("runs one test per draft across API processes", async () => {
    const workspace = await newWorkspace("Busy draft");
    const definition = draftDefinition({
      path: "/stats",
      auth: { type: "none" },
      pagination: { type: "none" },
      records: "",
      fields: [
        { id: "visitors", name: "V", path: "visitors", type: "integer" },
      ],
    });
    const draft = await newDraft(null, definition, workspace);
    const lease = () => admin`
      select custom_api_test_until from connection_state
      where connection_id = ${draft}`;
    // Another API process is testing this draft.
    await admin`update connection_state
      set custom_api_test_until = now() + interval '1 minute'
      where connection_id = ${draft}`;
    fixture.reset();
    const busy = await testRequest(draft, { definition }, workspace);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "custom_api_test_busy" });
    expect(fixture.requests).toHaveLength(0);
    // Its lease ran out (the process died): the next test runs and ends
    // its own lease.
    await admin`update connection_state
      set custom_api_test_until = now() - interval '1 second'
      where connection_id = ${draft}`;
    expect(
      (await testRequest(draft, { definition }, workspace)).statusCode,
    ).toBe(200);
    expect((await lease())[0]!.custom_api_test_until).toBeNull();
  });

  it("never releases a lease another test took after its own ran out", async () => {
    const workspace = await newWorkspace("Outlived lease");
    const draft = await newDraft(null, statsDraft(), workspace);
    const inWs = <T>(fn: (tx: Transaction) => Promise<T>) =>
      withWorkspace(db, { workspaceId: workspace }, fn);
    const first = await inWs((tx) =>
      takeCustomApiTestLease(tx, workspace, draft),
    );
    expect(first).not.toBeNull();
    expect(
      await inWs((tx) => takeCustomApiTestLease(tx, workspace, draft)),
    ).toBeNull();
    // The first test outlives its lease; another process takes the draft.
    await admin`update connection_state
      set custom_api_test_until = now() - interval '1 second'
      where connection_id = ${draft}`;
    const second = await inWs((tx) =>
      takeCustomApiTestLease(tx, workspace, draft),
    );
    expect(second).not.toBeNull();
    // The first test ends: the second one's lease stays.
    await inWs((tx) => releaseCustomApiTestLease(tx, workspace, draft, first!));
    expect(
      await inWs((tx) => takeCustomApiTestLease(tx, workspace, draft)),
    ).toBeNull();
    await inWs((tx) =>
      releaseCustomApiTestLease(tx, workspace, draft, second!),
    );
    expect(
      await inWs((tx) => takeCustomApiTestLease(tx, workspace, draft)),
    ).not.toBeNull();
  });

  it("keeps the window on the database clock, not the API's", async () => {
    const workspace = await newWorkspace("Skewed clock");
    const definition = draftDefinition({
      path: "/stats",
      auth: { type: "none" },
      pagination: { type: "none" },
      records: "",
      fields: [
        { id: "visitors", name: "V", path: "visitors", type: "integer" },
      ],
    });
    const draft = await newDraft(null, definition, workspace);
    // This API process runs an hour ahead.
    const saved = clock;
    clock = Date.now() + 3_600_000;
    try {
      expect(
        (await testRequest(draft, { definition }, workspace)).statusCode,
      ).toBe(200);
    } finally {
      clock = saved;
    }
    const [row] = await admin`
      select abs(extract(epoch from window_start - now())) as skew
      from custom_api_test_rate where workspace_id = ${workspace}`;
    expect(Number(row!.skew)).toBeLessThan(30);
  });

  it("counts the rate limit atomically under concurrent tests", async () => {
    const workspace = await newWorkspace("Concurrent tests");
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        withWorkspace(db, { workspaceId: workspace }, (tx) =>
          takeCustomApiTestSlot(tx, workspace),
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(30);
  });
});
