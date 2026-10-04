import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionListResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  metricQueryResponseSchema,
  metricResourcesResponseSchema,
  workspaceListResponseSchema,
  workspaceMetricListResponseSchema,
} from "@netrics/contracts";
import { demoManifest, vercelManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// #257 (ADR 0016 section 6): the catalog keeps connector translations, and
// the API names connectors and metrics in the caller's language.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface World {
  app: FastifyInstance;
  admin: Sql;
  close(): Promise<void>;
}

async function createWorld(env: Record<string, string> = {}): Promise<World> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    ...env,
  });
  const db: Database = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
  });
  const admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  return {
    app,
    admin,
    async close() {
      await app.close();
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const session = cookies.find((c) =>
    c?.startsWith("better-auth.session_token="),
  );
  if (!session) {
    throw new Error("expected a session cookie");
  }
  return session.split(";")[0]!;
}

async function signUp(
  world: World,
  email: string,
  acceptLanguage?: string,
): Promise<string> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
    payload: { name: email.split("@")[0], email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function call(
  world: World,
  cookie: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await world.app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    ...(payload ? { payload } : {}),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as unknown;
}

describe("connector catalog sync", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld();
  }, 30_000);
  afterAll(async () => world.close());

  it("stores each manifest's translations in its jsonb row", async () => {
    const rows = await world.admin`
      select id, manifest -> 'translations' as translations,
             manifest ->> 'sdkVersion' as sdk_version
      from connectors order by id`;
    expect(rows.map((row) => row.id)).toEqual([
      "app-store-connect",
      "demo",
      "google-search-console",
      "vercel",
    ]);
    const demo = rows.find((row) => row.id === "demo")!;
    expect(demo.translations).toEqual(demoManifest.translations);
    expect(demo.sdk_version).toBe("^0.2.6");
    for (const row of rows) {
      expect(row.translations, row.id as string).toHaveProperty("de.name");
    }
  });
});

describe("the API in the caller's language", () => {
  let world: World;
  let cookie: string;
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    world = await createWorld();
    cookie = await signUp(world, "owner@example.com");
    await call(world, cookie, "POST", "/v1/workspaces", { name: "Acme" });
    workspaceId = workspaceListResponseSchema.parse(
      await call(world, cookie, "GET", "/v1/workspaces"),
    ).workspaces[0]!.id;
    connectionId = connectionResponseSchema.parse(
      await call(
        world,
        cookie,
        "POST",
        `/v1/workspaces/${workspaceId}/connections`,
        { connectorId: "demo", name: "Demo" },
      ),
    ).connection.id;
  }, 60_000);
  afterAll(async () => world.close());

  const setLocale = (locale: "en" | "de" | null) =>
    call(world, cookie, "PATCH", "/v1/me", { locale });

  async function catalog(headers?: Record<string, string>) {
    return connectorListResponseSchema.parse(
      await call(world, cookie, "GET", "/v1/connectors", undefined, headers),
    ).connectors;
  }

  async function metrics() {
    return workspaceMetricListResponseSchema.parse(
      await call(world, cookie, "GET", `/v1/workspaces/${workspaceId}/metrics`),
    ).metrics;
  }

  it("answers in English by default", async () => {
    await setLocale("en");
    const demo = (await catalog()).find((entry) => entry.id === "demo")!;
    expect(demo.name).toBe("Demo Connector");
    expect(demo.description).toBe(demoManifest.description);
    const visitors = (await metrics()).find(
      (metric) => metric.key === "demo.visitors",
    )!;
    expect(visitors).toMatchObject({
      name: "Visitors",
      description: "Daily unique visitors per demo site.",
      dimensionNames: { resource: "Resource" },
    });
  });

  it("answers in German for a German user", async () => {
    await setLocale("de");
    const connectors = await catalog();
    const demo = connectors.find((entry) => entry.id === "demo")!;
    expect(demo.name).toBe("Demo-Connector");
    expect(demo.description).toBe(demoManifest.translations!.de!.description);

    // Field titles, descriptions and setup steps of the wizard.
    const vercel = connectors.find((entry) => entry.id === "vercel")!;
    const de = vercelManifest.translations!.de!;
    expect(vercel.name).toBe("Vercel Web Analytics");
    expect(
      (vercel.configSchema.properties as Record<string, { title: string }>)
        .teamId!.title,
    ).toBe("Team-ID");
    const token = vercel.authStrategies[0]!;
    expect(token.strategy === "token" ? token.setup?.steps : null).toEqual(
      de.setupSteps,
    );
    expect(token.strategy === "token" ? token.tokenLabel : null).toBe(
      de.credentials!.token!.title,
    );

    const visitors = (await metrics()).find(
      (metric) => metric.key === "demo.visitors",
    )!;
    expect(visitors).toMatchObject({
      name: "Besucher",
      description: "Eindeutige Besucher pro Tag und Demo-Website.",
      dimensionNames: { resource: "Website" },
    });

    const query = metricQueryResponseSchema.parse(
      await call(
        world,
        cookie,
        "POST",
        `/v1/workspaces/${workspaceId}/metrics/query`,
        { connectionId, metricKey: "demo.signups", period: "last_7_days" },
      ),
    );
    expect(query.metric.name).toBe("Registrierungen");

    const resources = metricResourcesResponseSchema.parse(
      await call(
        world,
        cookie,
        "POST",
        `/v1/workspaces/${workspaceId}/metrics/resources`,
        { connectionId, metricKey: "demo.visitors" },
      ),
    );
    expect(resources.resourceNoun).toEqual({
      singular: "Website",
      plural: "Websites",
    });

    const connections = connectionListResponseSchema.parse(
      await call(
        world,
        cookie,
        "GET",
        `/v1/workspaces/${workspaceId}/connections`,
      ),
    ).connections;
    expect(connections[0]!.connectorName).toBe("Demo-Connector");
  });

  it("keeps the English resource noun for English callers", async () => {
    await setLocale("en");
    const resources = metricResourcesResponseSchema.parse(
      await call(
        world,
        cookie,
        "POST",
        `/v1/workspaces/${workspaceId}/metrics/resources`,
        { connectionId, metricKey: "demo.visitors" },
      ),
    );
    expect(resources.resourceNoun).toEqual({
      singular: "site",
      plural: "sites",
    });
  });

  it("follows Accept-Language when the user has no setting", async () => {
    await setLocale(null);
    expect(
      (await catalog({ "accept-language": "de-DE,de;q=0.9" })).find(
        (entry) => entry.id === "demo",
      )!.name,
    ).toBe("Demo-Connector");
    expect(
      (await catalog({ "accept-language": "fr" })).find(
        (entry) => entry.id === "demo",
      )!.name,
    ).toBe("Demo Connector");
  });
});

describe("the instance default language", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld({ NETRICS_DEFAULT_LOCALE: "de" });
  }, 30_000);
  afterAll(async () => world.close());

  it("comes before Accept-Language and after the user's setting", async () => {
    const cookie = await signUp(world, "default@example.com", "en");
    await call(world, cookie, "PATCH", "/v1/me", { locale: null });
    const demoName = async () =>
      connectorListResponseSchema
        .parse(
          await call(world, cookie, "GET", "/v1/connectors", undefined, {
            "accept-language": "en",
          }),
        )
        .connectors.find((entry) => entry.id === "demo")!.name;
    expect(await demoName()).toBe("Demo-Connector");
    await call(world, cookie, "PATCH", "/v1/me", { locale: "en" });
    expect(await demoName()).toBe("Demo Connector");
  });
});
