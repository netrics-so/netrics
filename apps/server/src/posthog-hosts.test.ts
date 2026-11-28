import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectorListResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  storedConnectionPreviewResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { CREDENTIAL_HOSTS_KEY } from "@netrics/connector-sdk";
import { createPostHogConnector } from "@netrics/connectors";
import { createDatabase, type Database, type Job } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// A stored key goes only to the host it was entered for (#884 review,
// SDK 0.2.20 `configuredHosts`): a connection's configured host is fixed,
// a preview or save naming another host is refused before any request,
// and the runtime refuses a stored key whose bound host differs from the
// configuration, even when the row was changed behind the API's back.

const OLD_HOST = "posthog.old.example";
const NEW_HOST = "posthog.new.example";
const KEY = "phx_server_host_test_key_old";
const OTHER_KEY = "phx_server_host_test_key_new";
const ORG = "0190b4c2-7d1e-7000-8000-000000000001";

/** Every request the stand-in for PostHog saw: host and key. */
const seen: Array<{ host: string; authorization: string | undefined }> = [];
/** Projects whose queries PostHog refuses (403). */
const refused = new Set<string>();

function answer(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

/** Any PostHog host: one organization, one project, empty answers. */
const provider: ConnectorRuntime = {
  signal: new AbortController().signal,
  fetch: async (raw, init) => {
    const url = new URL(raw);
    seen.push({ host: url.host, authorization: init?.headers?.authorization });
    const page = (results: unknown[]) => ({
      count: results.length,
      next: null,
      results,
    });
    if (url.pathname === "/api/organizations/")
      return answer(200, page([{ id: ORG, name: "Acme" }]));
    if (url.pathname === `/api/organizations/${ORG}/projects/`)
      return answer(
        200,
        page([
          { id: 1000, name: "Site" },
          { id: 1001, name: "App" },
        ]),
      );
    const project = /^\/api\/projects\/(\d+)\/query\/$/.exec(url.pathname)?.[1];
    if (project && refused.has(project))
      return answer(403, {
        type: "authentication_error",
        code: "permission_denied",
        detail: `API key does not have access to the requested project: ID ${project}.`,
      });
    if (project) {
      const query = (
        JSON.parse(init!.body!) as { query: Record<string, unknown> }
      ).query;
      if (query.kind === "TrendsQuery") {
        const range = query.dateRange as { date_from: string };
        return answer(200, {
          results: (query.series as unknown[]).map((_, order) => ({
            action: { order },
            data: [1],
            days: [range.date_from],
          })),
        });
      }
      return answer(200, { results: [], hasMore: false });
    }
    return answer(404, { detail: "Not found." });
  },
};

function registry(): ConnectorRegistry {
  const posthog = createPostHogConnector({ sleep: async () => {} });
  const offline: Connector = {
    manifest: posthog.manifest,
    check: (context) => posthog.check(context, provider),
    discover: (context) => posthog.discover(context, provider),
    sync: (context, request) => posthog.sync(context, request, provider),
  };
  const result = new ConnectorRegistry();
  result.register(offline);
  return result;
}

let app: FastifyInstance;
let db: Database;
let schedulerDb: Database;
let keyring: ReturnType<typeof createCredentialKeyring>;
let owner: postgres.Sql;
let cookie: string;
let workspaceId: string;
let connectionId: string;

function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

const connectionUrl = () =>
  `/v1/workspaces/${workspaceId}/connections/${connectionId}`;

/** Requests that went to the new host, or carried the stored key there. */
const toNewHost = () => seen.filter((request) => request.host === NEW_HOST);

async function storedConfig(): Promise<Record<string, unknown>> {
  const [row] = await owner`
    select config from connections where id = ${connectionId}`;
  return row!.config as Record<string, unknown>;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const schedulerUrl = new URL(testDb.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
  keyring = createCredentialKeyring(
    config.appEncryptionKey,
    config.appEncryptionKeysPrevious,
  );
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
  const catalogOwner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(catalogOwner, registry());
  await catalogOwner.$client.end({ timeout: 5 });
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    registry: registry(),
    checkDb: async () => true,
  });
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Host Owner",
      email: "posthog-hosts@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Hosts" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("the catalog's pickers (#891 review)", () => {
  it("advertises no picker for a connector that lists no choices", async () => {
    // This registry's PostHog has no configOptions method, though its
    // manifest names the field: the field stays a text field.
    const response = await call("GET", "/v1/connectors");
    expect(response.statusCode, response.body).toBe(200);
    const posthog = connectorListResponseSchema
      .parse(response.json())
      .connectors.find((entry) => entry.id === "posthog");
    expect(posthog).toBeDefined();
    expect(posthog!.configOptions).toBeUndefined();
  });
});

describe("a PostHog key stays with its host (#884 review)", () => {
  it("checks fresh credentials against the draft host before connecting", async () => {
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/preview`,
      {
        connectorId: "posthog",
        config: { host: OLD_HOST },
        credentials: { token: KEY },
      },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      {
        connectorId: "posthog",
        name: "Self-hosted",
        config: { host: OLD_HOST },
        credentials: { token: KEY },
      },
    );
    expect(created.statusCode, created.body).toBe(200);
    connectionId = connectionResponseSchema.parse(created.json()).connection.id;
    expect(seen.every((request) => request.host === OLD_HOST)).toBe(true);
    // The envelope holds the host the key was entered for.
    const [row] = await owner`
      select credentials_encrypted from connections where id = ${connectionId}`;
    const stored = JSON.parse(
      decryptCredentials(
        (row!.credentials_encrypted as Buffer).toString("utf8"),
        keyring,
        { workspaceId, connectionId },
      ),
    ) as Record<string, unknown>;
    expect(stored).toEqual({ token: KEY, [CREDENTIAL_HOSTS_KEY]: [OLD_HOST] });
  });

  it("refuses a stored-key preview with another host before any request", async () => {
    const response = await call("POST", `${connectionUrl()}/preview`, {
      config: { host: NEW_HOST },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "connection_host_fixed",
    );
    expect(toNewHost()).toEqual([]);
  });

  it("refuses to save another host, with the stored key or a new one", async () => {
    for (const body of [
      { config: { host: NEW_HOST } },
      { config: { host: NEW_HOST }, credentials: { token: OTHER_KEY } },
      { config: { host: "eu.posthog.com" } },
    ]) {
      const response = await call("PATCH", connectionUrl(), body);
      expect(response.statusCode, response.body).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error).toBe(
        "connection_host_fixed",
      );
    }
    expect(toNewHost()).toEqual([]);
    expect(seen.every((request) => request.host === OLD_HOST)).toBe(true);
    expect((await storedConfig()).host).toBe(OLD_HOST);
  });

  it("saves other settings on the same host with the stored key", async () => {
    const before = seen.length;
    const response = await call("PATCH", connectionUrl(), {
      config: { host: OLD_HOST, projects: "" },
    });
    expect(response.statusCode, response.body).toBe(200);
    const checks = seen.slice(before);
    expect(checks.length).toBeGreaterThan(0);
    expect(
      checks.every(
        (request) =>
          request.host === OLD_HOST &&
          request.authorization === `Bearer ${KEY}`,
      ),
    ).toBe(true);
    // And a preview on the same host lists the project.
    const preview = await call("POST", `${connectionUrl()}/preview`, {
      config: { host: OLD_HOST },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(
      storedConnectionPreviewResponseSchema.parse(preview.json()).check.ok,
    ).toBe(true);
  });

  it("never sends the stored key to a host written into the row directly", async () => {
    await owner`
      update connections
      set config = jsonb_set(config, '{host}', ${owner.json(NEW_HOST)})
      where id = ${connectionId}`;
    await createJobHandlers({
      registry: registry(),
      credentialKeyring: keyring,
    })["connection.sync"]!({
      job: {
        id: crypto.randomUUID(),
        kind: "connection.sync",
        workspaceId,
        connectionId,
        attempts: 0,
        payload: {},
      } as unknown as Job,
      appDb: db,
      schedulerDb,
      logger: pino({ level: "silent" }),
    }).catch(() => undefined);
    expect(toNewHost()).toEqual([]);
    // A refusal only new credentials (a new connection) can repair: an
    // auth failure with its reason code, not an outage that retries
    // (#884 review 2).
    const [run] = await owner`
      select error_class, error_code from sync_runs
      where connection_id = ${connectionId}
      order by started_at desc limit 1`;
    expect(run).toEqual({
      error_class: "auth",
      error_code: "connection.credentials_host_changed",
    });
    const [state] = await owner`
      select auth_state from connection_state
      where connection_id = ${connectionId}`;
    expect(state!.auth_state).toBe("auth_failed");
  });
});

describe("a project the key may not query (#884 review 2)", () => {
  it("connects and syncs the other projects through the worker", async () => {
    refused.add("1000");
    try {
      const created = await call(
        "POST",
        `/v1/workspaces/${workspaceId}/connections`,
        {
          connectorId: "posthog",
          name: "Partly readable",
          config: { host: "posthog.third.example" },
          credentials: { token: KEY },
        },
      );
      expect(created.statusCode, created.body).toBe(200);
      const id = connectionResponseSchema.parse(created.json()).connection.id;
      // The worker's run: the check, then the sync pages.
      await createJobHandlers({
        registry: registry(),
        credentialKeyring: keyring,
      })["connection.sync"]!({
        job: {
          id: crypto.randomUUID(),
          kind: "connection.sync",
          workspaceId,
          connectionId: id,
          attempts: 0,
          payload: {},
        } as unknown as Job,
        appDb: db,
        schedulerDb,
        logger: pino({ level: "silent" }),
      });
      const [run] = await owner`
        select status from sync_runs
        where connection_id = ${id}
        order by started_at desc limit 1`;
      expect(run!.status).toBe("succeeded");
      const resources = await owner`
        select distinct dimensions ->> 'resource' as resource
        from observations where connection_id = ${id}`;
      expect(resources.map((row) => row.resource)).toEqual(["1001"]);
    } finally {
      refused.clear();
    }
  });
});

describe("the project picker of a key limited to projects (#888 review)", () => {
  it("checks the stored selection, not the projects it leaves out", async () => {
    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      {
        connectorId: "posthog",
        name: "Named projects",
        config: { host: "posthog.fourth.example", projects: "1000, 1001" },
        credentials: { token: KEY },
      },
    );
    expect(created.statusCode, created.body).toBe(200);
    const id = connectionResponseSchema.parse(created.json()).connection.id;
    // Only 1001 is synced; the key then loses 1000.
    await owner`
      update connections
      set config = config || ${owner.json({ resourceSelection: ["1001"] })}
      where id = ${id}`;
    refused.add("1000");
    try {
      const before = seen.length;
      const preview = await call(
        "POST",
        `/v1/workspaces/${workspaceId}/connections/${id}/preview`,
        { config: { host: "posthog.fourth.example", projects: "1000, 1001" } },
      );
      expect(preview.statusCode, preview.body).toBe(200);
      const parsed = storedConnectionPreviewResponseSchema.parse(
        preview.json(),
      );
      expect(parsed.check).toEqual({ ok: true });
      expect(parsed.selection).toEqual(["1001"]);
      expect(
        seen
          .slice(before)
          .some((request) => request.host === "posthog.fourth.example"),
      ).toBe(true);
    } finally {
      refused.clear();
    }
  });
});

describe("the picker names projects as a sync does (#888 review)", () => {
  it("discovers a project under the spelling its stored selection uses", async () => {
    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      {
        connectorId: "posthog",
        name: "Two spellings",
        config: { host: "posthog.fifth.example", projects: "01000, 1000" },
        credentials: { token: KEY },
      },
    );
    expect(created.statusCode, created.body).toBe(200);
    const id = connectionResponseSchema.parse(created.json()).connection.id;
    await owner`
      update connections
      set config = config || ${owner.json({ resourceSelection: ["1000"] })}
      where id = ${id}`;
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/${id}/preview`,
      { config: { host: "posthog.fifth.example", projects: "01000, 1000" } },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const parsed = storedConnectionPreviewResponseSchema.parse(preview.json());
    expect(parsed.check).toEqual({ ok: true });
    expect(parsed.resources.map((resource) => resource.id)).toEqual(["1000"]);
  });
});
