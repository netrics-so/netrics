import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CREDENTIAL_HOST_MISMATCH_CODE,
  CREDENTIAL_HOST_MISMATCH_MESSAGE,
} from "@netrics/connector-runtime";
import {
  connectionListResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  metricQueryResponseSchema,
  metricResourcesResponseSchema,
  workspaceListResponseSchema,
  workspaceMetricListResponseSchema,
} from "@netrics/contracts";
import {
  AGREEMENTS_CODE,
  AGREEMENTS_MESSAGE,
  demoManifest,
  HETZNER_CLOUD_TOKEN_FORBIDDEN_CODE,
  HETZNER_CLOUD_TOKEN_FORBIDDEN_MESSAGE,
  HETZNER_CLOUD_TOKEN_REJECTED_CODE,
  HETZNER_CLOUD_TOKEN_REJECTED_MESSAGE,
  HTTP_CHECK_HEADERS_INVALID_CODE,
  HTTP_CHECK_HEADERS_INVALID_MESSAGE,
  HTTP_CHECK_NAME_DUPLICATE_CODE,
  HTTP_CHECK_NAME_DUPLICATE_MESSAGE,
  HTTP_CHECK_NO_CHECKS_CODE,
  HTTP_CHECK_NO_CHECKS_MESSAGE,
  HTTP_CHECK_STATUS_INVALID_CODE,
  HTTP_CHECK_STATUS_INVALID_MESSAGE,
  HTTP_CHECK_TEXT_INVALID_CODE,
  HTTP_CHECK_TEXT_INVALID_MESSAGE,
  HTTP_CHECK_URL_INVALID_CODE,
  HTTP_CHECK_URL_INVALID_MESSAGE,
  HTTP_CHECK_URL_SECRET_CODE,
  HTTP_CHECK_URL_SECRET_MESSAGE,
  KEY_MISMATCH_CODE,
  KEY_MISMATCH_MESSAGE,
  POSTHOG_HOST_INVALID_CODE,
  POSTHOG_HOST_INVALID_MESSAGE,
  POSTHOG_INSIGHTS_INVALID_CODE,
  POSTHOG_INSIGHTS_INVALID_MESSAGE,
  POSTHOG_KEY_REJECTED_CODE,
  POSTHOG_KEY_REJECTED_MESSAGE,
  POSTHOG_PROJECTS_INVALID_CODE,
  POSTHOG_PROJECTS_INVALID_MESSAGE,
  POSTHOG_PROJECTS_REQUIRED_CODE,
  POSTHOG_PROJECTS_REQUIRED_MESSAGE,
  POSTHOG_SCOPE_MISSING_CODE,
  POSTHOG_SCOPE_MISSING_MESSAGE,
  RAILWAY_TOKEN_REJECTED_CODE,
  RAILWAY_TOKEN_REJECTED_MESSAGE,
  RAILWAY_WORKSPACE_DENIED_CODE,
  RAILWAY_WORKSPACE_DENIED_MESSAGE,
  ROLE_CODE,
  ROLE_MESSAGE,
  vercelManifest,
} from "@netrics/connectors";
import {
  CUSTOM_API_GRAPHQL_ERRORS,
  CUSTOM_API_MESSAGES,
  CustomApiGraphqlError,
} from "@netrics/connectors/custom-api";
import {
  localizedProviderMessage,
  PROVIDER_MESSAGE_CODES,
  providerMessageForCode,
  sharedEn,
} from "@netrics/domain";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import {
  appleAdsProvider,
  appStoreConnectProvider,
} from "./signed-keys/providers/index.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

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
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);
  afterAll(async () => world.close());

  it("stores each manifest's translations in its jsonb row", async () => {
    const rows = await world.admin`
      select id, manifest -> 'translations' as translations,
             manifest ->> 'sdkVersion' as sdk_version
      from connectors where id <> 'custom-api' order by id`;
    expect(rows.map((row) => row.id)).toEqual([
      "app-store-connect",
      "apple-ads",
      "demo",
      "google-play",
      "google-search-console",
      "hetzner-cloud",
      "http-check",
      "posthog",
      "railway",
      "vercel",
    ]);
    const demo = rows.find((row) => row.id === "demo")!;
    expect(demo.translations).toEqual(demoManifest.translations);
    expect(demo.sdk_version).toBe("^0.2.7");
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
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);
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
    expect(demo.metrics.map((metric) => metric.name)).toEqual([
      "Besucher",
      "Registrierungen",
    ]);

    // Field titles, descriptions and setup steps of the wizard.
    const vercel = connectors.find((entry) => entry.id === "vercel")!;
    const de = vercelManifest.translations!.de!;
    expect(vercel.name).toBe("Vercel");
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
    const german = await catalog({ "accept-language": "de-DE,de;q=0.9" });
    expect(german.find((entry) => entry.id === "demo")!.name).toBe(
      "Demo-Connector",
    );
    // The wizard texts the web's server components fetch (#770).
    const appStore = german.find((entry) => entry.id === "app-store-connect")!;
    expect(appStore.description).toMatch(/^Downloads, In-App-Käufe/);
    expect(
      (appStore.configSchema.properties as Record<string, { title: string }>)
        .vendorNumber!.title,
    ).toBe("Anbieternummer");
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
  }, TEST_DATABASE_SETUP_TIMEOUT_MS);
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

describe("provider reason codes (#795)", () => {
  // Every code this server records is one the catalog words in English
  // and German: a new refusal with a code and no text fails here.
  const recorded: Array<[code: string | undefined, english: string]> = [
    [
      appleAdsProvider.exchange!.invalidClientCode,
      appleAdsProvider.exchange!.invalidClient,
    ],
    ...[appleAdsProvider, appStoreConnectProvider].flatMap(
      ({ authFailure }): Array<[string | undefined, string]> => [
        [authFailure.codes?.unauthorized, authFailure.unauthorized],
        [authFailure.codes?.forbidden, authFailure.forbidden],
      ],
    ),
    [KEY_MISMATCH_CODE, KEY_MISMATCH_MESSAGE],
    [ROLE_CODE, ROLE_MESSAGE],
    [AGREEMENTS_CODE, AGREEMENTS_MESSAGE],
    [RAILWAY_TOKEN_REJECTED_CODE, RAILWAY_TOKEN_REJECTED_MESSAGE],
    [RAILWAY_WORKSPACE_DENIED_CODE, RAILWAY_WORKSPACE_DENIED_MESSAGE],
    [POSTHOG_KEY_REJECTED_CODE, POSTHOG_KEY_REJECTED_MESSAGE],
    [POSTHOG_SCOPE_MISSING_CODE, POSTHOG_SCOPE_MISSING_MESSAGE],
    [POSTHOG_HOST_INVALID_CODE, POSTHOG_HOST_INVALID_MESSAGE],
    [POSTHOG_INSIGHTS_INVALID_CODE, POSTHOG_INSIGHTS_INVALID_MESSAGE],
    [POSTHOG_PROJECTS_REQUIRED_CODE, POSTHOG_PROJECTS_REQUIRED_MESSAGE],
    [POSTHOG_PROJECTS_INVALID_CODE, POSTHOG_PROJECTS_INVALID_MESSAGE],
    [HETZNER_CLOUD_TOKEN_REJECTED_CODE, HETZNER_CLOUD_TOKEN_REJECTED_MESSAGE],
    [HETZNER_CLOUD_TOKEN_FORBIDDEN_CODE, HETZNER_CLOUD_TOKEN_FORBIDDEN_MESSAGE],
    [HTTP_CHECK_NO_CHECKS_CODE, HTTP_CHECK_NO_CHECKS_MESSAGE],
    [HTTP_CHECK_URL_INVALID_CODE, HTTP_CHECK_URL_INVALID_MESSAGE],
    [HTTP_CHECK_URL_SECRET_CODE, HTTP_CHECK_URL_SECRET_MESSAGE],
    [HTTP_CHECK_NAME_DUPLICATE_CODE, HTTP_CHECK_NAME_DUPLICATE_MESSAGE],
    [HTTP_CHECK_STATUS_INVALID_CODE, HTTP_CHECK_STATUS_INVALID_MESSAGE],
    [HTTP_CHECK_TEXT_INVALID_CODE, HTTP_CHECK_TEXT_INVALID_MESSAGE],
    [HTTP_CHECK_HEADERS_INVALID_CODE, HTTP_CHECK_HEADERS_INVALID_MESSAGE],
    [CREDENTIAL_HOST_MISMATCH_CODE, CREDENTIAL_HOST_MISMATCH_MESSAGE],
  ];

  it("are worded by the catalog in English and German", () => {
    expect(recorded).toHaveLength(26);
    for (const [code, english] of recorded) {
      expect(code, english).toEqual(expect.any(String));
      expect(providerMessageForCode(code, "en"), code).toBe(english);
      const german = providerMessageForCode(code, "de");
      expect(german, code).toEqual(expect.any(String));
      expect(german, code).not.toBe(english);
    }
    expect(new Set(recorded.map(([code]) => code)).size).toBe(26);
    expect([...recorded.map(([code]) => code), ...generic].sort()).toEqual(
      Object.keys(PROVIDER_MESSAGE_CODES).sort(),
    );
  });

  // Codes whose recorded message carries values (ADR 0030: the stream, the
  // HTTP status and the number of GraphQL errors): the catalog words a
  // generic sentence in English and German, the message keeps the values.
  const generic = [CUSTOM_API_GRAPHQL_ERRORS];

  it("word value-carrying codes generically in English and German", () => {
    const recordedMessage = new CustomApiGraphqlError("items", 400, 2).message;
    for (const code of generic) {
      const english = providerMessageForCode(code, "en");
      const german = providerMessageForCode(code, "de");
      expect(english, code).toEqual(expect.any(String));
      expect(german, code).toEqual(expect.any(String));
      expect(german).not.toBe(english);
      expect(english).not.toBe(recordedMessage);
    }
    expect(recordedMessage).toContain("stream items, HTTP 400, 2 errors");
  });
});

describe("custom API connector messages", () => {
  it("are the catalog's English entries and translate to German", () => {
    for (const [code, english] of Object.entries(CUSTOM_API_MESSAGES)) {
      expect(
        sharedEn.providerMessages.customApi[
          code as keyof typeof CUSTOM_API_MESSAGES
        ],
      ).toBe(english);
      const german = localizedProviderMessage(english, "de");
      expect(german).not.toBeNull();
      expect(german).not.toBe(english);
    }
  });
});
