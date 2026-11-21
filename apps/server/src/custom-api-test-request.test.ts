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
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { takeCustomApiTestSlot } from "./custom-api/test-rate.js";
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
});

describe("the test request rate limit", () => {
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
    clock += 10_000;
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
    clock += 51_000;
    expect(
      (await testRequest(first, { definition }, workspace)).statusCode,
    ).toBe(200);
  });

  it("counts the rate limit atomically under concurrent tests", async () => {
    const workspace = await newWorkspace("Concurrent tests");
    const at = new Date(clock);
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        withWorkspace(db, { workspaceId: workspace }, (tx) =>
          takeCustomApiTestSlot(tx, workspace, at),
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(30);
  });
});
