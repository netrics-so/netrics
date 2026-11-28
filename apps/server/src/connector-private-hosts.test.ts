import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionPreviewResponseSchema,
  connectionResponseSchema,
  storedConnectionPreviewResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector } from "@netrics/connector-sdk";
import { posthogManifest } from "@netrics/connectors";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// A self-hosted PostHog on a private network (#892): the operator lists
// its host in NETRICS_CONNECTOR_PRIVATE_HOSTS, and every connector call of
// the API reaches it through runtime.fetch, the new-connection wizard's
// preview included (#935 review). Every name resolves to 127.0.0.1, a
// private address, where a stand-in for PostHog answers over plain http.

const LISTED = "posthog.internal.example";
const UNLISTED = "posthog.elsewhere.example";
const KEY = "phx_private_hosts_test_key";

let provider: Server;
let port: number;
/** Host headers the stand-in saw. */
const seen: string[] = [];

const lookup: LookupFunction = (_hostname, options, callback) => {
  const entry = { address: "127.0.0.1", family: 4 };
  if (options.all)
    (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [
      entry,
    ]);
  else callback(null, entry.address, entry.family);
};

/** The PostHog manifest; check and discover call the configured host. */
function registry(): ConnectorRegistry {
  const call = async (
    config: Record<string, unknown>,
    fetch: (url: string) => Promise<unknown>,
  ) => {
    await fetch(`http://${String(config.host)}:${port}/api/projects/`);
  };
  const posthog: Connector = {
    manifest: posthogManifest,
    check: async (context, runtime) => {
      await call(context.config, runtime.fetch);
      return { ok: true };
    },
    discover: async (context, runtime) => {
      await call(context.config, runtime.fetch);
      return [{ id: "1000", name: "Site", kind: "project" }];
    },
    sync: async () => {
      throw new Error("not used");
    },
  };
  const result = new ConnectorRegistry();
  result.register(posthog);
  return result;
}

let app: FastifyInstance;
let db: Database;
let cookie: string;
let workspaceId: string;

function call(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

beforeAll(async () => {
  provider = createServer((request, response) => {
    seen.push(String(request.headers.host));
    response.setHeader("connection", "close");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  port = await new Promise<number>((resolve) =>
    provider.listen(0, "127.0.0.1", () =>
      resolve((provider.address() as AddressInfo).port),
    ),
  );
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    NETRICS_CONNECTOR_PRIVATE_HOSTS: LISTED,
  });
  db = createDatabase(testDb.appUrl);
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
    // Tests only: names resolve to the stand-in, which speaks plain http.
    // No private host here: the allowance comes from the variable alone.
    executeOptions: { egress: { lookup, allowInsecureHttp: true } },
  });
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Private Hosts",
      email: "private-hosts@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Private" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  provider?.closeAllConnections();
  provider?.close();
});

describe("a PostHog on a listed private host (#892)", () => {
  it("is previewed, connected and previewed again through the API", async () => {
    seen.length = 0;
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/preview`,
      {
        connectorId: "posthog",
        config: { host: LISTED },
        credentials: { token: KEY },
      },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const previewed = connectionPreviewResponseSchema.parse(preview.json());
    expect(previewed.check.ok).toBe(true);
    expect(previewed.resources.map(({ id }) => id)).toEqual(["1000"]);

    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      {
        connectorId: "posthog",
        name: "Internal PostHog",
        config: { host: LISTED },
        credentials: { token: KEY },
      },
    );
    expect(created.statusCode, created.body).toBe(200);
    const id = connectionResponseSchema.parse(created.json()).connection.id;

    const stored = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/${id}/preview`,
      { config: { host: LISTED } },
    );
    expect(stored.statusCode, stored.body).toBe(200);
    expect(
      storedConnectionPreviewResponseSchema.parse(stored.json()).check.ok,
    ).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((host) => host === `${LISTED}:${port}`)).toBe(true);
  });

  it("refuses an unlisted private host in the wizard, before any request", async () => {
    seen.length = 0;
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/preview`,
      {
        connectorId: "posthog",
        config: { host: UNLISTED },
        credentials: { token: KEY },
      },
    );
    expect(preview.statusCode).toBe(400);
    expect(preview.body).toMatch(/non-public address/);
    expect(preview.body).not.toContain(KEY);
    expect(seen).toEqual([]);
  });
});
