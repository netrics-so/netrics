import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  deviceSelfResponseSchema,
  errorResponseSchema,
  lookupPairingResponseSchema,
  pollPairingResponseSchema,
  workspaceResponseSchema,
  type CreatePairingResponse,
  type Device,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  recordDeviceHeartbeat,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { defaultDisplayMode } from "./devices/service.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// The device platform (#406, ADR 0021): reported at pairing and in the
// heartbeat, copied at approval, steering the name and display mode
// defaults. Apps before #406 send neither and pair and beat as before.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
let foreignWorkspaceId: string;
let clientCounter = 0;

function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: {
    cookie?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<InjectResponse> {
  clientCounter += 1;
  const inject: InjectOptions = {
    method,
    url,
    // Each request from its own address, so the pairing limit stays apart.
    remoteAddress: `198.51.100.${clientCounter % 250}`,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.payload !== undefined
      ? { payload: options.payload as Record<string, unknown> }
      : {}),
  };
  return app.inject(inject);
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
  const response = await call("POST", "/v1/workspaces", {
    cookie,
    payload: { name: "Screens" },
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

/** Starts a pairing; `body` undefined sends no body at all (older apps). */
async function startPairing(body?: unknown): Promise<CreatePairingResponse> {
  const response = await call("POST", "/v1/device/pairings", {
    ...(body !== undefined ? { payload: body } : {}),
  });
  expect(response.statusCode, response.body).toBe(200);
  return createPairingResponseSchema.parse(response.json());
}

async function approveAndClaim(
  pairing: CreatePairingResponse,
  cookie = owner,
  workspace = workspaceId,
) {
  const approved = await call(
    "POST",
    `/v1/workspaces/${workspace}/devices/approve`,
    {
      cookie,
      payload: { code: pairing.code, name: "Screen", dashboardId: null },
    },
  );
  expect(approved.statusCode).toBe(200);
  const { device } = deviceResponseSchema.parse(approved.json());
  const result = pollPairingResponseSchema.parse(
    (
      await call("POST", "/v1/device/pairings/poll", {
        payload: {
          pairingId: pairing.pairingId,
          pollSecret: pairing.pollSecret,
        },
      })
    ).json(),
  );
  if (result.status !== "approved") throw new Error("not approved");
  return { device, accessToken: result.credentials.accessToken };
}

function heartbeat(token: string, payload: Record<string, unknown>) {
  return call("POST", "/v1/device/heartbeat", {
    payload: { appVersion: "tvos 1.0", uptimeSeconds: 1, ...payload },
    headers: { authorization: `Bearer ${token}` },
  });
}

async function listed(
  deviceId: string,
  workspace = workspaceId,
  cookie = owner,
): Promise<Device | undefined> {
  const response = await call("GET", `/v1/workspaces/${workspace}/devices`, {
    cookie,
  });
  return deviceListResponseSchema
    .parse(response.json())
    .devices.find((device) => device.id === deviceId);
}

function lookup(code: string, cookie: string | null = owner) {
  return call("POST", "/v1/device-pairings/lookup", {
    ...(cookie ? { cookie } : {}),
    payload: { code },
  });
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
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    devicePayloadCacheMs: 0,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("platform-owner@example.com");
  stranger = await signUp("platform-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  foreignWorkspaceId = await newWorkspace(stranger);
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("display mode default", () => {
  it("is scroll view for an iPhone and screen view otherwise", () => {
    expect(defaultDisplayMode("ios")).toBe("scroll");
    expect(defaultDisplayMode("ipados")).toBe("screen");
    expect(defaultDisplayMode("tvos")).toBe("screen");
    expect(defaultDisplayMode("web")).toBe("screen");
    expect(defaultDisplayMode(null)).toBe("screen");
  });
});

describe("older apps", () => {
  it("pair without a body and beat without a platform, as before", async () => {
    // No body and no content type, as the tvOS app and the kiosk send.
    const pairing = await startPairing();
    const [stored] = await admin`
      select platform from device_pairings where id = ${pairing.pairingId}`;
    expect(stored!.platform).toBeNull();

    const { device, accessToken } = await approveAndClaim(pairing);
    expect(device).toMatchObject({
      platform: null,
      displayMode: "screen",
      rotation: 0,
    });

    expect((await heartbeat(accessToken, {})).statusCode).toBe(204);
    expect(await listed(device.id)).toMatchObject({
      platform: null,
      displayMode: "screen",
      heartbeat: { appVersion: "tvos 1.0" },
    });
    const me = await call("GET", "/v1/device/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deviceSelfResponseSchema.parse(me.json()).device).toMatchObject({
      id: device.id,
      displayMode: "screen",
    });
  });

  it("accepts an empty JSON object", async () => {
    const pairing = await startPairing({});
    const { device } = await approveAndClaim(pairing);
    expect(device.platform).toBeNull();
  });
});

describe("platform at pairing", () => {
  it("copies the platform to the device with its display mode", async () => {
    for (const [platform, displayMode] of [
      ["tvos", "screen"],
      ["ipados", "screen"],
      ["ios", "scroll"],
      ["web", "screen"],
    ] as const) {
      const pairing = await startPairing({ platform });
      const [stored] = await admin`
        select platform from device_pairings where id = ${pairing.pairingId}`;
      expect(stored!.platform).toBe(platform);
      const { device } = await approveAndClaim(pairing);
      expect(device).toMatchObject({ platform, displayMode });
      expect(await listed(device.id)).toMatchObject({ platform, displayMode });

      const [event] = await admin`
        select metadata from audit_events
        where action = 'device.approved' and target = ${device.id}`;
      expect(event!.metadata).toMatchObject({ platform });
    }
  });

  it("ignores a platform it does not know", async () => {
    for (const platform of ["visionos", "TVOS", "", 5, null]) {
      const pairing = await startPairing({ platform });
      const { device } = await approveAndClaim(pairing);
      expect(device).toMatchObject({ platform: null, displayMode: "screen" });
    }
  });

  it("refuses a body that is not an object", async () => {
    for (const payload of [[], "tvos", 1]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/device/pairings",
        remoteAddress: "203.0.113.7",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("never changes what the device may do", async () => {
    const phone = await approveAndClaim(
      await startPairing({ platform: "ios" }),
    );
    const tv = await approveAndClaim(await startPairing({ platform: "tvos" }));
    for (const { accessToken } of [phone, tv]) {
      const auth = { authorization: `Bearer ${accessToken}` };
      expect(
        (await call("GET", "/v1/device/me", { headers: auth })).statusCode,
      ).toBe(200);
      expect(
        (await call("GET", "/v1/device/dashboard", { headers: auth }))
          .statusCode,
      ).toBe(200);
      // Device tokens stay out of user routes on every platform.
      expect(
        (
          await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
            headers: auth,
          })
        ).statusCode,
      ).toBe(401);
    }
  });
});

describe("platform in the heartbeat", () => {
  it("fills in a device without one and never replaces it", async () => {
    const { device, accessToken } = await approveAndClaim(await startPairing());
    expect(
      (await heartbeat(accessToken, { platform: "tvos" })).statusCode,
    ).toBe(204);
    expect((await listed(device.id))!.platform).toBe("tvos");
    // Later reports, including unknown values, keep it.
    for (const platform of ["web", "ios", "visionos"]) {
      expect((await heartbeat(accessToken, { platform })).statusCode).toBe(204);
    }
    await heartbeat(accessToken, {});
    expect(await listed(device.id)).toMatchObject({
      platform: "tvos",
      // Filling the platform later does not change the display mode.
      displayMode: "screen",
    });
  });

  it("keeps the platform reported at pairing", async () => {
    const { device, accessToken } = await approveAndClaim(
      await startPairing({ platform: "ipados" }),
    );
    await heartbeat(accessToken, { platform: "tvos" });
    expect((await listed(device.id))!.platform).toBe("ipados");
  });

  it("leaves an unknown platform as not reported", async () => {
    const { device, accessToken } = await approveAndClaim(await startPairing());
    expect(
      (await heartbeat(accessToken, { platform: "visionos" })).statusCode,
    ).toBe(204);
    expect((await listed(device.id))!.platform).toBeNull();
  });
});

describe("platform across workspaces", () => {
  it("is listed only inside the device's workspace", async () => {
    const ours = await approveAndClaim(await startPairing());
    const theirs = await approveAndClaim(
      await startPairing(),
      stranger,
      foreignWorkspaceId,
    );
    await heartbeat(ours.accessToken, { platform: "web" });
    expect((await listed(ours.device.id))!.platform).toBe("web");
    // The other workspace's device is untouched and invisible here.
    expect(await listed(theirs.device.id)).toBeUndefined();
    expect(
      (await listed(theirs.device.id, foreignWorkspaceId, stranger))!.platform,
    ).toBeNull();
    expect(
      await listed(ours.device.id, foreignWorkspaceId, stranger),
    ).toBeUndefined();
    expectError(
      await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
        cookie: stranger,
      }),
      404,
      "workspace_not_found",
    );
  });

  it("is not stored through another workspace (RLS and predicates)", async () => {
    const ours = await approveAndClaim(await startPairing());
    const beat = {
      appVersion: "tvos 1.0",
      uptimeSeconds: 1,
      lastError: null,
      platform: "tvos" as const,
    };
    // The predicate names our workspace, the transaction another: RLS hides
    // the row.
    expect(
      await withWorkspace(db, { workspaceId: foreignWorkspaceId }, (tx) =>
        recordDeviceHeartbeat(tx, workspaceId, ours.device.id, beat),
      ),
    ).toBe(false);
    // The transaction is ours, the predicate another workspace's: the
    // explicit workspace_id predicate finds nothing.
    expect(
      await withWorkspace(db, { workspaceId }, (tx) =>
        recordDeviceHeartbeat(tx, foreignWorkspaceId, ours.device.id, beat),
      ),
    ).toBe(false);
    const [row] = await admin`
      select platform, last_heartbeat_at from devices
      where id = ${ours.device.id}`;
    expect(row).toEqual({ platform: null, last_heartbeat_at: null });
  });
});

describe("pairing lookup", () => {
  it("tells a signed-in user the platform of a pending code", async () => {
    const pairing = await startPairing({ platform: "ios" });
    const loose = ` ${pairing.code.replace("-", " ").toLowerCase()} `;
    const response = await lookup(loose);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(lookupPairingResponseSchema.parse(response.json())).toEqual({
      pairing: { platform: "ios" },
    });
    // Nothing else about the pairing is in the answer.
    expect(Object.keys(response.json().pairing as object)).toEqual([
      "platform",
    ]);

    const silent = await startPairing();
    expect(
      lookupPairingResponseSchema.parse((await lookup(silent.code)).json()),
    ).toEqual({ pairing: { platform: null } });

    // The lookup changes nothing: the code is still pending and approvable.
    const { device } = await approveAndClaim(pairing);
    expect(device.platform).toBe("ios");
    // Once used, the code is gone for the lookup too.
    expectError(await lookup(pairing.code), 404, "pairing_not_found");
  });

  it("needs a session", async () => {
    const pairing = await startPairing({ platform: "tvos" });
    expectError(await lookup(pairing.code, null), 401, "unauthorized");
  });

  it("counts misses as failed approvals", async () => {
    const guesser = await signUp("platform-guesser@example.com");
    const pairing = await startPairing({ platform: "tvos" });
    for (let index = 0; index < 10; index += 1) {
      expectError(await lookup("AAAA-AAAA", guesser), 404, "pairing_not_found");
    }
    expectError(await lookup(pairing.code, guesser), 429, "too_many_attempts");
    const [failures] = await admin`
      select count(*)::int as n from device_pairing_failures f
      join users u on u.id = f.user_id
      where u.email = 'platform-guesser@example.com'`;
    expect(failures!.n).toBe(10);
  });

  it("refuses malformed codes", async () => {
    for (const code of ["", "short", "x".repeat(21)]) {
      expect((await lookup(code)).statusCode).toBe(400);
    }
  });
});
