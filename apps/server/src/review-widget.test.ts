import { randomBytes } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  errorResponseSchema,
  latestReviewResponseSchema,
  workspaceResponseSchema,
  type Dashboard,
  type DeviceDashboardV3Response,
  type DeviceWidgetV3,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, encryptCredentials } from "./credentials.js";
import { createDeviceService } from "./devices/service.js";
import { loadConfig } from "./env.js";
import { capturingLogger } from "./oauth/test-provider.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The latest-review widget (#340, ADR 0019 section 12) end to end: stored,
// validated (a connector without reviews is refused), shown in the screens'
// payload (newest matching review, no id, the nickname only with "Show
// author") and in the Studio's data (with the id that "Hide this review"
// takes); without a reviews key the widget asks for one. Review text never
// reaches a log.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const NOW = new Date("2026-10-04T10:00:00Z");
const APP = "1000000001";
const OTHER_APP = "1000000002";
const SECRET_BODY = "Synthetic body only the widget may show";
const SECRET_NICK = "synthetic-nickname";

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;
let reviewsConnection: string;
let keylessConnection: string;
let demoConnection: string;
const logs: string[] = [];

/**
 * App Store Connect as it ships, with its continuous `reviews` stream
 * (ADR 0025, #703): review widgets show when reviews were last checked.
 * Without stored rows nothing changes, so every other test here also
 * checks that payloads stay as they were.
 */
const registry = new ConnectorRegistry();
registry.register(createAppStoreConnectConnector());
registry.register(createDemoConnector());

function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return app.inject(options);
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

async function newWorkspace(cookie: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Reviews",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

/** An App Store Connect connection, with or without a reviews key. */
async function ascConnection(
  workspace: string,
  name: string,
  reviewsKey: boolean,
): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, 'app-store-connect', ${name}) returning id`;
  const id = row!.id as string;
  const envelope = encryptCredentials(
    JSON.stringify({
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      keyId: "2X9R4HXF34",
      privateKey: "synthetic",
      ...(reviewsKey
        ? { reviews: { keyId: "CS5UPP0RT1", privateKey: "synthetic" } }
        : {}),
    }),
    KEYRING,
    { workspaceId: workspace, connectionId: id },
  );
  await admin`
    update connections
    set credentials_encrypted = ${Buffer.from(envelope, "utf8")}
    where id = ${id}`;
  await admin`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds)
    values (${id}, ${workspace}, ${new Date(NOW.getTime() - 60_000)}, 3600)`;
  for (const resource of [APP, OTHER_APP]) {
    await admin`
      insert into connection_resources (connection_id, workspace_id,
        resource_id, name, kind)
      values (${id}, ${workspace}, ${resource},
        ${resource === APP ? "Wurfel" : "Ledger"}, 'app')`;
  }
  return id;
}

async function insertReview(
  connectionId: string,
  review: {
    id: string;
    resource?: string;
    rating: number;
    title?: string | null;
    body?: string | null;
    author?: string | null;
    createdAt: string;
    workspace?: string;
  },
) {
  await admin`
    insert into app_reviews (connection_id, workspace_id, provider_review_id,
      resource_id, rating, title, body, author, territory, created_at)
    values (${connectionId}, ${review.workspace ?? workspaceId}, ${review.id},
      ${review.resource ?? APP}, ${review.rating}, ${review.title ?? null},
      ${review.body ?? null}, ${review.author ?? null}, 'DE',
      ${review.createdAt})`;
}

const reviewWidget = (
  connectionId: string,
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  type: "review",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  connectionId,
  options,
  ...extra,
});

async function create(
  widgets: unknown[],
  cookie = owner,
  workspace = workspaceId,
): Promise<InjectResponse> {
  return call("POST", `/v1/workspaces/${workspace}/dashboards`, cookie, {
    name: "Reviews",
    slides: [{ name: null, widgets }],
  });
}

function parsed(response: InjectResponse): Dashboard {
  expect(response.statusCode, response.body).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

async function insertDevice(dashboardId: string): Promise<string> {
  const [row] = await admin`
    insert into devices (workspace_id, name, dashboard_id)
    values (${workspaceId}, 'TV', ${dashboardId}) returning id`;
  return row!.id as string;
}

const devices = () =>
  createDeviceService({
    db,
    pairingUrl: "http://localhost:3000/devices/approve",
    now: () => NOW,
    payloadCacheMs: 0,
    credentialKeyring: KEYRING,
    registry,
  });

async function reviewsOf(deviceId: string) {
  const result = await devices().dashboard(
    { workspaceId, deviceId },
    undefined,
    3,
  );
  if (!result.ok) throw new Error(result.error);
  const payload = result.value as DeviceDashboardV3Response;
  expect(deviceDashboardV3ResponseSchema.parse(payload)).toEqual(payload);
  return payload.slides[0]!.widgets.filter(
    (widget): widget is Extract<DeviceWidgetV3, { type: "review" }> =>
      widget.type === "review",
  );
}

function latest(
  connectionId: string,
  body: Record<string, unknown> = {},
  cookie = owner,
  workspace = workspaceId,
) {
  return call(
    "POST",
    `/v1/workspaces/${workspace}/connections/${connectionId}/reviews/latest`,
    cookie,
    body,
  );
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "debug",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    registry,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
    logger: capturingLogger(logs),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("review-owner@example.com");
  stranger = await signUp("review-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  strangerWorkspaceId = await newWorkspace(stranger);
  reviewsConnection = await ascConnection(workspaceId, "Apps", true);
  keylessConnection = await ascConnection(workspaceId, "Keyless", false);
  const [demo] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  demoConnection = demo!.id as string;

  await insertReview(reviewsConnection, {
    id: "newest-two-stars",
    rating: 2,
    title: "Meh",
    body: "Two stars",
    author: "low",
    createdAt: "2026-10-04T09:00:00Z",
  });
  await insertReview(reviewsConnection, {
    id: "no-text",
    rating: 5,
    author: "silent",
    createdAt: "2026-10-04T08:00:00Z",
  });
  await insertReview(reviewsConnection, {
    id: "five-stars",
    rating: 5,
    title: "Finally",
    body: SECRET_BODY,
    author: SECRET_NICK,
    createdAt: "2026-10-04T07:00:00Z",
  });
  await insertReview(reviewsConnection, {
    id: "other-app",
    resource: OTHER_APP,
    rating: 5,
    title: "Ledger",
    body: "Other app's newest",
    author: "ledger",
    createdAt: "2026-10-04T09:30:00Z",
  });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("the latest-review widget", () => {
  it("is stored with its connection, app, icon and options", async () => {
    const dashboard = parsed(
      await create([
        reviewWidget(
          reviewsConnection,
          { minRating: 4 },
          { dimensions: { resource: APP } },
        ),
      ]),
    );
    const widget = dashboard.slides[0]!.widgets[0]!;
    expect(widget).toMatchObject({
      type: "review",
      connectionId: reviewsConnection,
      dimensions: { resource: APP },
      imageId: null,
      resourceName: "Wurfel",
      options: { minRating: 4, requireText: true, showAuthor: true },
    });
    expect(dashboard.slides[0]!.formatWarnings).toEqual([]);
  });

  it("refuses a connector without reviews, an unknown app and a stranger's connection", async () => {
    const refused = async (response: InjectResponse) => {
      expect(response.statusCode).toBe(400);
      return errorResponseSchema.parse(response.json()).error;
    };
    expect(await refused(await create([reviewWidget(demoConnection)]))).toBe(
      "reviews_not_supported",
    );
    expect(
      await refused(
        await create([
          reviewWidget(
            reviewsConnection,
            {},
            { dimensions: { resource: "x" } },
          ),
        ]),
      ),
    ).toBe("unknown_resource");
    expect(
      await refused(
        await create(
          [reviewWidget(reviewsConnection)],
          stranger,
          strangerWorkspaceId,
        ),
      ),
    ).toBe("connection_not_found");
    expect(
      await refused(
        await create([
          reviewWidget(reviewsConnection, {}, { dimensions: { route: "/" } }),
        ]),
      ),
    ).toBe("invalid_request");
    // Below its minimum of 4 × 3.
    expect(
      await refused(
        await create([{ ...reviewWidget(reviewsConnection), h: 2 }]),
      ),
    ).toBe("widget_too_small");
  });

  it("shows the newest matching review on screens, without its id", async () => {
    const dashboard = parsed(
      await create([
        reviewWidget(
          reviewsConnection,
          { minRating: 4 },
          { dimensions: { resource: APP } },
        ),
        { ...reviewWidget(reviewsConnection, { requireText: false }), x: 4 },
        {
          ...reviewWidget(reviewsConnection, { showAuthor: false }),
          x: 8,
          title: "Fans",
        },
      ]),
    );
    const [four, any, anonymous] = await reviewsOf(
      await insertDevice(dashboard.id),
    );
    expect(four).toMatchObject({
      label: "Latest review · Wurfel",
      imageId: null,
      min: { w: 4, h: 3 },
      data: {
        status: "ok",
        review: {
          rating: 5,
          title: "Finally",
          body: SECRET_BODY,
          author: SECRET_NICK,
          territory: "DE",
          createdAt: "2026-10-04T07:00:00.000Z",
        },
      },
    });
    expect(four!.data.review).not.toHaveProperty("id");
    // All apps, text not required: the other app's newer review.
    expect(any!.label).toBe("Latest review");
    expect(any!.data.review?.body).toBe("Other app's newest");
    // "Show author" off: no nickname reaches the payload.
    expect(anonymous!.label).toBe("Fans");
    expect(anonymous!.data.review?.author).toBeNull();
    expect(JSON.stringify(anonymous)).not.toContain("ledger");
  });

  it("reaches released screens in schema 2 as one more widget type", async () => {
    const dashboard = parsed(await create([reviewWidget(reviewsConnection)]));
    const deviceId = await insertDevice(dashboard.id);
    const result = await devices().dashboard(
      { workspaceId, deviceId },
      undefined,
      2,
    );
    if (!result.ok) throw new Error(result.error);
    const payload = deviceDashboardV2ResponseSchema.parse(result.value);
    expect(payload.slides[0]!.widgets[0]!.type).toBe("review");
  });

  it("asks for a reviews key when the connection has none", async () => {
    const dashboard = parsed(await create([reviewWidget(keylessConnection)]));
    const [widget] = await reviewsOf(await insertDevice(dashboard.id));
    expect(widget!.data).toEqual({
      status: "auth_failed",
      updatedAt: "2026-10-04T09:59:00.000Z",
      review: null,
    });
    const studio = latestReviewResponseSchema.parse(
      (await latest(keylessConnection)).json(),
    );
    expect(studio.status).toBe("auth_failed");
  });

  it("filters by app, stars and text for the Studio", async () => {
    const response = await latest(reviewsConnection, {
      resource: APP,
      minRating: 5,
      requireText: true,
    });
    expect(response.statusCode).toBe(200);
    // five-stars matches; hide it below, then none does.
    expect(latestReviewResponseSchema.parse(response.json()).review?.id).toBe(
      "five-stars",
    );
  });

  it("gives the Studio the review id, and Hide this review removes it everywhere", async () => {
    const dashboard = parsed(
      await create([
        reviewWidget(
          reviewsConnection,
          { minRating: 5 },
          { dimensions: { resource: APP } },
        ),
      ]),
    );
    const deviceId = await insertDevice(dashboard.id);
    const before = latestReviewResponseSchema.parse(
      (await latest(reviewsConnection, { resource: APP, minRating: 5 })).json(),
    );
    expect(before.review?.id).toBe("five-stars");

    const hidden = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/${reviewsConnection}/reviews/five-stars/hide`,
      owner,
    );
    expect(hidden.statusCode).toBe(204);

    const after = latestReviewResponseSchema.parse(
      (await latest(reviewsConnection, { resource: APP, minRating: 5 })).json(),
    );
    expect(after).toMatchObject({ status: "no_data", review: null });
    const [widget] = await reviewsOf(deviceId);
    expect(widget!.data).toMatchObject({ status: "no_data", review: null });
  });

  it("is refused for another workspace and for connectors without reviews", async () => {
    expect(
      (await latest(reviewsConnection, {}, stranger, strangerWorkspaceId))
        .statusCode,
    ).toBe(404);
    // A non-member naming this workspace: not found, like any workspace.
    expect((await latest(reviewsConnection, {}, stranger)).statusCode).toBe(
      404,
    );
    const demo = await latest(demoConnection);
    expect(demo.statusCode).toBe(400);
    expect(errorResponseSchema.parse(demo.json()).error).toBe(
      "reviews_not_supported",
    );
    expect((await latest(reviewsConnection, { minRating: 6 })).statusCode).toBe(
      400,
    );
  });

  it("never logs review text or nicknames", () => {
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET_BODY);
    expect(all).not.toContain(SECRET_NICK);
  });
});

describe("review widget freshness (ADR 0025, #704)", () => {
  const minutesAgo = (minutes: number) =>
    new Date(NOW.getTime() - minutes * 60_000);

  async function withRows<T>(run: () => Promise<T>): Promise<T> {
    // The connection entry, and one per app: each app's reviews are read
    // on their own.
    for (const [resource, minutes] of [
      ["", 30],
      [APP, 10],
      [OTHER_APP, 20],
    ] as const)
      await admin`
        insert into connection_freshness (workspace_id, connection_id,
          stream, resource, checked_at)
        values (${workspaceId}, ${reviewsConnection}, 'reviews',
          ${resource}, ${minutesAgo(minutes)})`;
    try {
      return await run();
    } finally {
      await admin`
        delete from connection_freshness
        where connection_id = ${reviewsConnection}`;
    }
  }

  const checked = (minutes: number) => ({
    kind: "continuous",
    stream: "Reviews",
    fetchedAt: minutesAgo(minutes).toISOString(),
  });

  it("gives screens the app's reviews stream, by widget app or slide scope", async () => {
    const dashboard = parsed(
      await create([
        reviewWidget(reviewsConnection, {}, { dimensions: { resource: APP } }),
        reviewWidget(reviewsConnection, {}, { y: 3 }),
      ]),
    );
    // A second slide scoped to the other app (#707).
    const [slide] = await admin`
      insert into dashboard_slides (dashboard_id, workspace_id, position,
        scope)
      values (${dashboard.id}, ${workspaceId}, 1,
        ${admin.json({
          app: {
            kind: "values",
            values: [`${reviewsConnection}:${OTHER_APP}`],
          },
        })})
      returning id`;
    await admin`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id)
      values (${slide!.id as string}, ${dashboard.id}, ${workspaceId},
        'review', 0, 0, 4, 3, ${reviewsConnection})`;
    const deviceId = await insertDevice(dashboard.id);
    const before = await devices().dashboard(
      { workspaceId, deviceId },
      undefined,
      3,
    );
    await withRows(async () => {
      const result = await devices().dashboard(
        { workspaceId, deviceId },
        undefined,
        3,
      );
      if (!result.ok) throw new Error(result.error);
      const payload = deviceDashboardV3ResponseSchema.parse(result.value);
      const data = payload.slides.flatMap((slide) =>
        slide.widgets.flatMap((widget) =>
          widget.type === "review" ? [widget.data] : [],
        ),
      );
      expect(data.map((entry) => entry.freshness)).toEqual([
        checked(10),
        // Every app: the least recently checked row.
        checked(30),
        checked(20),
      ]);
      expect(data[0]!.status).toBe("ok");
      // Schema 2 carries the same.
      const v2 = await devices().dashboard(
        { workspaceId, deviceId },
        undefined,
        2,
      );
      if (!v2.ok) throw new Error(v2.error);
      const reviews = deviceDashboardV2ResponseSchema
        .parse(v2.value)
        .slides[0]!.widgets.filter((widget) => widget.type === "review");
      expect(reviews[0]!.data).toMatchObject({ freshness: checked(10) });
      if (!before.ok) throw new Error(before.error);
      expect(result.value.version).not.toBe(before.value.version);
    });
    // Without rows the payload is what it was.
    const after = await devices().dashboard(
      { workspaceId, deviceId },
      undefined,
      3,
    );
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("freshness");
  });

  it("gives the Studio the same for the widget's app", async () => {
    await withRows(async () => {
      const app = latestReviewResponseSchema.parse(
        (await latest(reviewsConnection, { resource: APP })).json(),
      );
      expect(app.freshness).toEqual(checked(10));
      const all = latestReviewResponseSchema.parse(
        (await latest(reviewsConnection)).json(),
      );
      expect(all.freshness).toEqual(checked(30));
    });
    const none = latestReviewResponseSchema.parse(
      (await latest(reviewsConnection, { resource: APP })).json(),
    );
    expect(none).not.toHaveProperty("freshness");
  });
});
