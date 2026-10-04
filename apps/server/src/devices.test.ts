import { readFileSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  dashboardResponseSchema,
  deviceDashboardResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  deviceListResponseSchema,
  imageResponseSchema,
  deviceResponseSchema,
  deviceSelfResponseSchema,
  errorResponseSchema,
  pollPairingResponseSchema,
  refreshDeviceTokenResponseSchema,
  serverInfoResponseSchema,
  workspaceResponseSchema,
  type CreatePairingResponse,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { addDays, civilDate } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  approveUrlFor,
  CODE_ALPHABET,
  createDeviceService,
} from "./devices/service.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";
import { hashToken } from "./tokens.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let stranger: string;
let workspaceId: string;
let dashboardId: string;
let foreignDashboardId: string;
let clientCounter = 0;

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  options: {
    cookie?: string;
    payload?: unknown;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<InjectResponse> {
  const inject: InjectOptions = {
    method,
    url,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.ip ? { remoteAddress: options.ip } : {}),
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

async function newDashboard(cookie: string, workspace: string) {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspace}/dashboards`,
    {
      cookie,
      payload: { name: "Lobby" },
    },
  );
  return dashboardResponseSchema.parse(response.json()).dashboard.id;
}

/** Each test pairs from its own address, so the creation limit stays apart. */
function freshIp(): string {
  clientCounter += 1;
  return `198.51.100.${clientCounter}`;
}

async function startPairing(ip = freshIp()): Promise<CreatePairingResponse> {
  const response = await call("POST", "/v1/device/pairings", { ip });
  expect(response.statusCode).toBe(200);
  return createPairingResponseSchema.parse(response.json());
}

function poll(pairing: CreatePairingResponse, pollSecret = pairing.pollSecret) {
  return call("POST", "/v1/device/pairings/poll", {
    payload: { pairingId: pairing.pairingId, pollSecret },
  });
}

function approve(
  cookie: string,
  body: Record<string, unknown>,
  workspace = workspaceId,
) {
  return call("POST", `/v1/workspaces/${workspace}/devices/approve`, {
    cookie,
    payload: { name: "Lobby TV", dashboardId, ...body },
  });
}

/** Pairs a new device and returns it with its credentials. */
async function pair(
  name = "Credential TV",
  dashboard: string | null = dashboardId,
) {
  const pairing = await startPairing();
  const approved = await approve(owner, {
    code: pairing.code,
    name,
    dashboardId: dashboard,
  });
  const { device } = deviceResponseSchema.parse(approved.json());
  const result = pollPairingResponseSchema.parse((await poll(pairing)).json());
  if (result.status !== "approved") throw new Error("not approved");
  return { device, ...result.credentials };
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

async function resolves(token: string): Promise<boolean> {
  const rows =
    await admin`select * from resolve_principal_token(${hashToken(token)})`;
  return rows.length === 1;
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
    // Tests change data between reads; the memo has its own tests.
    devicePayloadCacheMs: 0,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("tv-owner@example.com");
  editor = await signUp("tv-editor@example.com");
  stranger = await signUp("tv-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "tv-editor@example.com",
    "editor",
  );
  expect(added.statusCode).toBe(200);
  dashboardId = await newDashboard(owner, workspaceId);
  foreignDashboardId = await newDashboard(
    stranger,
    await newWorkspace(stranger),
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("server identification", () => {
  it("names the product, the device API version and the pairing URL", async () => {
    const response = await call("GET", "/v1/server");
    expect(response.statusCode).toBe(200);
    expect(serverInfoResponseSchema.parse(response.json())).toEqual({
      product: "netrics",
      deviceApiVersion: 1,
      version: "0.0.0-dev",
      pairingUrl: "http://localhost:3000/devices/approve",
      // Released apps keep working: the API version stays 1, and new apps
      // ask for schema 2 or 3 only when it is listed (ADR 0015 section 7,
      // ADR 0017 section 9).
      dashboardSchemas: [1, 2, 3],
    });
  });

  it("reports a configured pairing URL", () => {
    const base = {
      DATABASE_URL: "postgres://netrics_app:x@localhost:5433/netrics",
      WEB_ORIGIN: "https://app.example.com",
    };
    expect(loadConfig(base).pairingUrl).toBe(
      "https://app.example.com/devices/approve",
    );
    expect(
      loadConfig({ ...base, NETRICS_PAIRING_URL: "https://netrics.tv/link" })
        .pairingUrl,
    ).toBe("https://netrics.tv/link");
    // Reported exactly as configured; clients drop scheme and trailing slash.
    expect(
      loadConfig({ ...base, NETRICS_PAIRING_URL: "https://netrics.tv" })
        .pairingUrl,
    ).toBe("https://netrics.tv");
    expect(
      loadConfig({ ...base, NETRICS_PAIRING_URL: "https://netrics.tv/" })
        .pairingUrl,
    ).toBe("https://netrics.tv/");
  });
});

describe("approve URL", () => {
  it("puts the code in the path of a bare origin", () => {
    expect(approveUrlFor("https://netrics.tv", "ABCD-EFGH")).toBe(
      "https://netrics.tv/ABCD-EFGH",
    );
    expect(approveUrlFor("https://netrics.tv/", "ABCD-EFGH")).toBe(
      "https://netrics.tv/ABCD-EFGH",
    );
    expect(approveUrlFor("http://nas.local:8080", "ABCD-EFGH")).toBe(
      "http://nas.local:8080/ABCD-EFGH",
    );
  });

  it("adds ?code= to any other URL", () => {
    expect(
      approveUrlFor("https://app.example.com/devices/approve", "ABCD-EFGH"),
    ).toBe("https://app.example.com/devices/approve?code=ABCD-EFGH");
    expect(approveUrlFor("https://netrics.tv/link", "ABCD-EFGH")).toBe(
      "https://netrics.tv/link?code=ABCD-EFGH",
    );
    expect(approveUrlFor("https://netrics.tv/?via=tv", "ABCD-EFGH")).toBe(
      "https://netrics.tv/?via=tv&code=ABCD-EFGH",
    );
  });

  it("is what a pairing on a hosted-style server reports", async () => {
    const service = createDeviceService({
      db,
      pairingUrl: "https://netrics.tv",
    });
    const result = await service.createPairing(freshIp());
    if (!result.ok) throw new Error(result.error);
    expect(result.value.pairingUrl).toBe("https://netrics.tv");
    expect(result.value.approveUrl).toBe(
      `https://netrics.tv/${result.value.code}`,
    );
    expect(createPairingResponseSchema.parse(result.value).approveUrl).toMatch(
      /^https:\/\/netrics\.tv\/[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );
  });
});

describe("pairing", () => {
  it("pairs a device once: code, approval, credentials", async () => {
    const pairing = await startPairing();
    expect(pairing.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    for (const char of pairing.code.replace("-", "")) {
      expect(CODE_ALPHABET).toContain(char);
    }
    expect(pairing.approveUrl).toBe(
      `http://localhost:3000/devices/approve?code=${pairing.code}`,
    );
    expect(
      pollPairingResponseSchema.parse((await poll(pairing)).json()),
    ).toEqual({ status: "pending", expiresAt: pairing.expiresAt });

    // Editors may not approve; owners may, typing the code loosely.
    expectError(
      await approve(editor, { code: pairing.code }),
      403,
      "forbidden",
    );
    const loose = ` ${pairing.code.replace("-", " ").toLowerCase()} `;
    const approved = await approve(owner, { code: loose });
    expect(approved.statusCode).toBe(200);
    const { device } = deviceResponseSchema.parse(approved.json());
    expect(device).toMatchObject({
      name: "Lobby TV",
      dashboardId,
      revokedAt: null,
    });

    const claimed = await poll(pairing);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.headers["cache-control"]).toBe("no-store");
    const result = pollPairingResponseSchema.parse(claimed.json());
    if (result.status !== "approved") throw new Error("not approved");
    expect(result.device).toEqual({ id: device.id, name: "Lobby TV" });
    const { accessToken, refreshToken } = result.credentials;
    expect(accessToken).toMatch(/^nt_/);
    expect(refreshToken).toMatch(/^nt_/);
    expect(await resolves(accessToken)).toBe(true);

    // Only hashes are stored, with the device and separate scopes.
    const tokens = await admin`
      select token_hash, scopes, device_id, workspace_id, expires_at
      from principal_tokens where device_id = ${device.id} order by scopes`;
    expect(tokens.map((row) => row.scopes)).toEqual([
      ["device:read"],
      ["device:refresh"],
    ]);
    expect(tokens.map((row) => row.token_hash).sort()).toEqual(
      [hashToken(accessToken), hashToken(refreshToken)].sort(),
    );
    expect(tokens.every((row) => row.workspace_id === workspaceId)).toBe(true);

    // The pairing is spent; the code cannot be approved again.
    expectError(await poll(pairing), 410, "pairing_claimed");
    expectError(
      await approve(owner, { code: pairing.code }),
      404,
      "pairing_not_found",
    );

    const events = await admin`
      select action, target from audit_events
      where workspace_id = ${workspaceId} and action like 'device.%'`;
    expect(events).toEqual([{ action: "device.approved", target: device.id }]);
  });

  it("hands out credentials to exactly one of two simultaneous polls", async () => {
    const pairing = await startPairing();
    expect((await approve(owner, { code: pairing.code })).statusCode).toBe(200);
    const results = await Promise.all([poll(pairing), poll(pairing)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });

  it("rejects a wrong poll secret and expired pairings", async () => {
    const pairing = await startPairing();
    expectError(await poll(pairing, "x".repeat(43)), 404, "pairing_not_found");
    await admin`
      update device_pairings set expires_at = now() - interval '1 second'
      where id = ${pairing.pairingId}`;
    expectError(await poll(pairing), 410, "pairing_expired");
    expectError(
      await approve(owner, { code: pairing.code }),
      404,
      "pairing_not_found",
    );
  });

  it("keeps the pairing usable when the dashboard is not in the workspace", async () => {
    const pairing = await startPairing();
    expectError(
      await approve(owner, {
        code: pairing.code,
        dashboardId: foreignDashboardId,
      }),
      404,
      "dashboard_not_found",
    );
    const approved = await approve(owner, {
      code: pairing.code,
      dashboardId: null,
    });
    expect(approved.statusCode).toBe(200);
    expect(deviceResponseSchema.parse(approved.json()).device.dashboardId).toBe(
      null,
    );
  });

  it("deletes pairings and failed attempts older than a day", async () => {
    const [user] = await admin`select id from users limit 1`;
    const userId = user!.id as string;
    const [old] = await admin`
      insert into device_pairings (code_hash, poll_secret_hash, client_key, expires_at)
      values ('old-code', 'old-secret', 'old-client', now() - interval '2 days')
      returning id`;
    await admin`
      insert into device_pairing_failures (user_id, created_at)
      values (${userId}, now() - interval '2 days')`;
    await startPairing();
    expect(
      await admin`select id from device_pairings where id = ${old!.id}`,
    ).toHaveLength(0);
    expect(
      await admin`
        select id from device_pairing_failures
        where created_at < now() - interval '1 day'`,
    ).toHaveLength(0);
  });

  it("limits new pairings per client address", async () => {
    const ip = freshIp();
    for (let index = 0; index < 10; index += 1) {
      expect(
        (await call("POST", "/v1/device/pairings", { ip })).statusCode,
      ).toBe(200);
    }
    expectError(
      await call("POST", "/v1/device/pairings", { ip }),
      429,
      "too_many_requests",
    );
    expect(
      (await call("POST", "/v1/device/pairings", { ip: freshIp() })).statusCode,
    ).toBe(200);
  });

  it("stops guessing codes after 10 failed approvals", async () => {
    const guesser = await signUp("tv-guesser@example.com");
    const workspace = await newWorkspace(guesser);
    const pairing = await startPairing();
    for (let index = 0; index < 10; index += 1) {
      expectError(
        await approve(
          guesser,
          { code: "AAAA-AAAA", dashboardId: null },
          workspace,
        ),
        404,
        "pairing_not_found",
      );
    }
    // Even the right code is refused now.
    expectError(
      await approve(
        guesser,
        { code: pairing.code, dashboardId: null },
        workspace,
      ),
      429,
      "too_many_attempts",
    );
    expect(
      pollPairingResponseSchema.parse((await poll(pairing)).json()),
    ).toMatchObject({
      status: "pending",
    });
  });
});

describe("devices", () => {
  async function pairDevice(name: string) {
    const pairing = await startPairing();
    const approved = await approve(owner, { code: pairing.code, name });
    const { device } = deviceResponseSchema.parse(approved.json());
    const result = pollPairingResponseSchema.parse(
      (await poll(pairing)).json(),
    );
    if (result.status !== "approved") throw new Error("not approved");
    return { device, credentials: result.credentials };
  }

  it("revokes a device and all its tokens", async () => {
    const { device, credentials } = await pairDevice("Kitchen TV");
    expect(await resolves(credentials.accessToken)).toBe(true);

    expectError(
      await call(
        "POST",
        `/v1/workspaces/${workspaceId}/devices/${device.id}/revoke`,
        { cookie: editor },
      ),
      403,
      "forbidden",
    );
    const revoked = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/devices/${device.id}/revoke`,
      { cookie: owner },
    );
    expect(revoked.statusCode).toBe(200);
    expect(
      deviceResponseSchema.parse(revoked.json()).device.revokedAt,
    ).not.toBeNull();
    expect(await resolves(credentials.accessToken)).toBe(false);
    expect(await resolves(credentials.refreshToken)).toBe(false);

    // Revoking again changes nothing and is audited once.
    await call(
      "POST",
      `/v1/workspaces/${workspaceId}/devices/${device.id}/revoke`,
      { cookie: owner },
    );
    const events = await admin`
      select action from audit_events
      where target = ${device.id} order by created_at`;
    expect(events.map((row) => row.action)).toEqual([
      "device.approved",
      "device.revoked",
    ]);
  });

  it("lists devices only inside their workspace", async () => {
    const { device } = await pairDevice("Hall TV");
    const list = await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
      cookie: editor,
    });
    expect(
      deviceListResponseSchema.parse(list.json()).devices.map((d) => d.id),
    ).toContain(device.id);

    const foreign = await newWorkspace(stranger);
    const theirs = await call("GET", `/v1/workspaces/${foreign}/devices`, {
      cookie: stranger,
    });
    expect(deviceListResponseSchema.parse(theirs.json()).devices).toEqual([]);
    expectError(
      await call(
        "POST",
        `/v1/workspaces/${foreign}/devices/${device.id}/revoke`,
        { cookie: stranger },
      ),
      404,
      "device_not_found",
    );
    expectError(
      await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
        cookie: stranger,
      }),
      404,
      "workspace_not_found",
    );
  });

  it("keeps device tokens away from user routes", async () => {
    const { credentials } = await pairDevice("Office TV");
    for (const token of [credentials.accessToken, credentials.refreshToken]) {
      const response = await call("GET", "/v1/me", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      const list = await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(401);
    }
  });

  it("clears the dashboard when it is deleted", async () => {
    const lobby = await newDashboard(owner, workspaceId);
    const pairing = await startPairing();
    const approved = await approve(owner, {
      code: pairing.code,
      dashboardId: lobby,
    });
    const { device } = deviceResponseSchema.parse(approved.json());
    const deleted = await call(
      "DELETE",
      `/v1/workspaces/${workspaceId}/dashboards/${lobby}`,
      { cookie: owner },
    );
    expect(deleted.statusCode).toBe(204);
    const [row] = await admin`
      select dashboard_id, workspace_id from devices where id = ${device.id}`;
    expect(row).toEqual({ dashboard_id: null, workspace_id: workspaceId });
  });
});

describe("device credentials", () => {
  function me(token: string | null, cookie?: string) {
    return call("GET", "/v1/device/me", {
      ...(cookie ? { cookie } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function refresh(refreshToken: string) {
    const response = await call("POST", "/v1/device/token", {
      payload: { refreshToken },
    });
    return {
      response,
      credentials:
        response.statusCode === 200
          ? refreshDeviceTokenResponseSchema.parse(response.json()).credentials
          : null,
    };
  }

  async function deviceRevoked(deviceId: string): Promise<boolean> {
    const [row] =
      await admin`select revoked_at from devices where id = ${deviceId}`;
    return row!.revoked_at !== null;
  }

  it("lets only the device's access token into the device API", async () => {
    const { device, accessToken, refreshToken } = await pair();
    const response = await me(accessToken);
    expect(response.statusCode).toBe(200);
    expect(deviceSelfResponseSchema.parse(response.json()).device).toEqual({
      id: device.id,
      name: "Credential TV",
      dashboardId,
      rotation: 0,
      displayMode: "screen",
    });
    const [row] =
      await admin`select last_seen_at from devices where id = ${device.id}`;
    expect(row!.last_seen_at).not.toBeNull();

    expectError(await me(refreshToken), 401, "unauthorized");
    expectError(await me(null, owner), 401, "unauthorized");
    expectError(await me(null), 401, "unauthorized");
    expectError(await me("nt_not-a-real-token-at-all"), 401, "unauthorized");
    // The access token is no refresh token.
    expect((await refresh(accessToken)).response.statusCode).toBe(401);
  });

  it("rotates the refresh token", async () => {
    const first = await pair();
    const { response, credentials } = await refresh(first.refreshToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(credentials!.refreshToken).not.toBe(first.refreshToken);
    expect((await me(credentials!.accessToken)).statusCode).toBe(200);
    // The earlier access token stays valid until it expires.
    expect((await me(first.accessToken)).statusCode).toBe(200);
    // The new refresh token works in turn.
    expect((await refresh(credentials!.refreshToken)).response.statusCode).toBe(
      200,
    );
  });

  it("treats a quick repeat of a rotated token as a retry", async () => {
    const first = await pair();
    const lost = (await refresh(first.refreshToken)).credentials!;
    const retried = await refresh(first.refreshToken);
    expect(retried.response.statusCode).toBe(200);
    // The lost pair is replaced; the device keeps working.
    expect(await resolves(lost.accessToken)).toBe(false);
    expect(await resolves(lost.refreshToken)).toBe(false);
    expect((await me(retried.credentials!.accessToken)).statusCode).toBe(200);
    expect(await deviceRevoked(first.device.id)).toBe(false);
  });

  it("revokes the device when a replaced refresh token comes back", async () => {
    const first = await pair("Stolen TV");
    const second = (await refresh(first.refreshToken)).credentials!;
    const third = (await refresh(second.refreshToken)).credentials!;
    // The first token again, after its successor was used: a copy exists.
    expectError(
      (await refresh(first.refreshToken)).response,
      401,
      "unauthorized",
    );
    expect(await deviceRevoked(first.device.id)).toBe(true);
    for (const token of [
      third.accessToken,
      third.refreshToken,
      second.accessToken,
    ]) {
      expect(await resolves(token)).toBe(false);
    }
    expectError(await me(third.accessToken), 401, "unauthorized");
    const events = await admin`
      select action, actor_user_id, metadata from audit_events
      where target = ${first.device.id} order by created_at`;
    expect(events.map((row) => row.action)).toEqual([
      "device.approved",
      "device.revoked",
    ]);
    expect(events[1]).toMatchObject({
      actor_user_id: null,
      metadata: { reason: "refresh_token_reuse" },
    });
  });

  it("treats a late repeat as reuse", async () => {
    const first = await pair();
    await refresh(first.refreshToken);
    await admin`
      update principal_tokens set rotated_at = now() - interval '6 minutes'
      where token_hash = ${hashToken(first.refreshToken)}`;
    expect((await refresh(first.refreshToken)).response.statusCode).toBe(401);
    expect(await deviceRevoked(first.device.id)).toBe(true);
  });

  it("gives simultaneous refreshes one working pair", async () => {
    const first = await pair();
    const results = await Promise.all([
      refresh(first.refreshToken),
      refresh(first.refreshToken),
    ]);
    expect(results.map((r) => r.response.statusCode)).toEqual([200, 200]);
    const live = await Promise.all(
      results.map((r) => resolves(r.credentials!.refreshToken)),
    );
    expect(live.filter(Boolean)).toHaveLength(1);
    expect(await deviceRevoked(first.device.id)).toBe(false);
  });

  it("answers 401 on the next request after revocation", async () => {
    const { device, accessToken, refreshToken } = await pair();
    expect((await me(accessToken)).statusCode).toBe(200);
    await call(
      "POST",
      `/v1/workspaces/${workspaceId}/devices/${device.id}/revoke`,
      { cookie: owner },
    );
    expectError(await me(accessToken), 401, "unauthorized");
    expect((await refresh(refreshToken)).response.statusCode).toBe(401);
  });

  it("renames and reassigns a device", async () => {
    const { device, accessToken } = await pair("Old name", null);
    const url = `/v1/workspaces/${workspaceId}/devices/${device.id}`;
    expectError(
      await call("PATCH", url, { cookie: editor, payload: { name: "X" } }),
      403,
      "forbidden",
    );
    expectError(
      await call("PATCH", url, {
        cookie: owner,
        payload: { dashboardId: foreignDashboardId },
      }),
      404,
      "dashboard_not_found",
    );
    expect(
      (await call("PATCH", url, { cookie: owner, payload: {} })).statusCode,
    ).toBe(400);
    const updated = await call("PATCH", url, {
      cookie: owner,
      payload: { name: "Reception", dashboardId },
    });
    expect(deviceResponseSchema.parse(updated.json()).device).toMatchObject({
      name: "Reception",
      dashboardId,
    });
    expect(
      deviceSelfResponseSchema.parse((await me(accessToken)).json()).device,
    ).toMatchObject({ name: "Reception", dashboardId });
    const [event] = await admin`
      select metadata from audit_events
      where target = ${device.id} and action = 'device.updated'`;
    expect(event!.metadata).toEqual({ name: "Reception", dashboardId });
  });

  it("changes rotation and display mode (#276)", async () => {
    const { device, accessToken } = await pair("Portrait TV", null);
    // Paired devices start unrotated, in screen view, with no screen yet.
    expect(device).toMatchObject({
      rotation: 0,
      displayMode: "screen",
      screen: null,
    });
    expect(
      deviceSelfResponseSchema.parse((await me(accessToken)).json()).device,
    ).toMatchObject({ rotation: 0, displayMode: "screen" });

    const url = `/v1/workspaces/${workspaceId}/devices/${device.id}`;
    expectError(
      await call("PATCH", url, { cookie: editor, payload: { rotation: 90 } }),
      403,
      "forbidden",
    );
    for (const payload of [
      { rotation: 45 },
      { rotation: -90 },
      { rotation: 360 },
      { rotation: "90" },
      { displayMode: "glance" },
      { displayMode: "" },
      { displayMode: null },
    ]) {
      expect(
        (await call("PATCH", url, { cookie: owner, payload })).statusCode,
      ).toBe(400);
    }

    const updated = await call("PATCH", url, {
      cookie: owner,
      payload: { rotation: 90, displayMode: "scroll" },
    });
    expect(updated.statusCode).toBe(200);
    expect(deviceResponseSchema.parse(updated.json()).device).toMatchObject({
      name: "Portrait TV",
      dashboardId: null,
      rotation: 90,
      displayMode: "scroll",
    });
    expect(
      deviceSelfResponseSchema.parse((await me(accessToken)).json()).device,
    ).toMatchObject({ rotation: 90, displayMode: "scroll" });
    // Only what was sent changes.
    const turned = await call("PATCH", url, {
      cookie: owner,
      payload: { rotation: 270 },
    });
    expect(deviceResponseSchema.parse(turned.json()).device).toMatchObject({
      rotation: 270,
      displayMode: "scroll",
    });
    const events = await admin`
      select metadata from audit_events
      where target = ${device.id} and action = 'device.updated'
      order by created_at`;
    expect(events.map((row) => row.metadata)).toEqual([
      { rotation: 90, displayMode: "scroll" },
      { rotation: 270 },
    ]);
  });

  it("keeps screen settings inside the device's workspace (#276)", async () => {
    const { device } = await pair("Guarded TV", null);
    const foreign = await newWorkspace(stranger);
    expectError(
      await call("PATCH", `/v1/workspaces/${foreign}/devices/${device.id}`, {
        cookie: stranger,
        payload: { rotation: 180 },
      }),
      404,
      "device_not_found",
    );
    expectError(
      await call(
        "PATCH",
        `/v1/workspaces/${workspaceId}/devices/${device.id}`,
        { cookie: stranger, payload: { displayMode: "scroll" } },
      ),
      404,
      "workspace_not_found",
    );
    const [row] = await admin`
      select rotation, display_mode from devices where id = ${device.id}`;
    expect(row).toEqual({ rotation: 0, display_mode: "screen" });
    const events = await admin`
      select 1 from audit_events
      where target = ${device.id} and action = 'device.updated'`;
    expect(events).toHaveLength(0);
  });
});

describe("device dashboard", () => {
  let connectionId: string;
  let brokenConnectionId: string;
  let salesId: string;
  let brokenId: string;

  async function newConnection(authState = "ok"): Promise<string> {
    const [row] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'demo', 'Demo') returning id`;
    const id = row!.id as string;
    await admin`
      insert into connection_state (connection_id, workspace_id,
        last_success_at, auth_state)
      values (${id}, ${workspaceId}, now(), ${authState})`;
    return id;
  }

  async function observe(connection: string, date: string, value: number) {
    await admin`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${workspaceId}, ${connection}, m.id,
             ${admin.json({ resource: "site-1" })},
             ${`${date}T00:00:00Z`}::timestamptz, ${value}
      from metric_definitions m
      where m.connector_id = 'demo' and m.key = 'demo.signups'`;
  }

  async function tileDashboard(name: string, tiles: unknown[]) {
    const response = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/dashboards`,
      { cookie: owner, payload: { name, tiles } },
    );
    expect(response.statusCode).toBe(200);
    return dashboardResponseSchema.parse(response.json()).dashboard.id;
  }

  function getDashboard(
    token: string | null,
    options: { cookie?: string; etag?: string; query?: string } = {},
  ) {
    return call("GET", `/v1/device/dashboard${options.query ?? ""}`, {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.etag ? { "if-none-match": options.etag } : {}),
      },
    });
  }

  function heartbeat(token: string | null, payload: unknown, cookie?: string) {
    return call("POST", "/v1/device/heartbeat", {
      payload,
      ...(cookie ? { cookie } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  function reassign(deviceId: string, dashboard: string | null) {
    return call("PATCH", `/v1/workspaces/${workspaceId}/devices/${deviceId}`, {
      cookie: owner,
      payload: { dashboardId: dashboard },
    });
  }

  async function read(token: string) {
    const response = await getDashboard(token);
    expect(response.statusCode).toBe(200);
    return {
      response,
      body: deviceDashboardResponseSchema.parse(response.json()),
    };
  }

  beforeAll(async () => {
    connectionId = await newConnection();
    brokenConnectionId = await newConnection("auth_failed");
    // Daily signups 1..14 for the last 14 days (UTC), today = 14.
    const today = civilDate(new Date(), "UTC");
    for (let i = 0; i < 14; i++) {
      await observe(connectionId, addDays(today, -i), 14 - i);
    }
    await observe(brokenConnectionId, today, 5);
    // A resource the connector named that has no data yet (#194).
    await admin`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connectionId}, ${workspaceId}, 'site-2', 'Quiet site', 'site')`;
    const signups = { metricKey: "demo.signups", period: "last_7_days" };
    salesId = await tileDashboard("Sales wall", [
      { ...signups, connectionId, title: "Sign-ups" },
      { ...signups, connectionId, dimensions: { resource: "site-2" } },
    ]);
    brokenId = await tileDashboard("Broken", [
      { ...signups, connectionId: brokenConnectionId },
    ]);
  });

  it("serves the assigned dashboard as tiles", async () => {
    const { device, accessToken } = await pair("Sales TV", salesId);
    const { response, body } = await read(accessToken);
    expect(response.headers.etag).toBe(`"${body.version}"`);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(body).toMatchObject({
      refreshAfterSec: 60,
      timeZone: "UTC",
      dashboard: { id: salesId, name: "Sales wall" },
    });
    expect(body.tiles).toHaveLength(2);
    // Last 7 days: 8..14 → 77. The 7 days before: 1..7 → 28.
    expect(body.tiles[0]).toMatchObject({
      label: "Sign-ups",
      period: "last_7_days",
      aggregation: "sum",
      value: 77,
      unit: "signups",
      change: { previousValue: 28, delta: 49, ratio: 1.75 },
      spark: [8, 9, 10, 11, 12, 13, 14],
      status: "ok",
    });
    expect(body.tiles[0]!.updatedAt).not.toBeNull();
    // No title: the metric name with the resource's (#194). A resource
    // without data: no data.
    expect(body.tiles[1]).toMatchObject({
      label: "Signups · Quiet site",
      value: null,
      unit: "signups",
      change: { previousValue: null, delta: null, ratio: null },
      status: "no_data",
    });
    expect(body.tiles[1]!.spark).toEqual(Array(7).fill(null));
    const [row] =
      await admin`select last_seen_at from devices where id = ${device.id}`;
    expect(row!.last_seen_at).not.toBeNull();
  });

  it("answers an empty dashboard when none is assigned", async () => {
    const { accessToken } = await pair("Blank TV", null);
    const { response, body } = await read(accessToken);
    expect(body).toMatchObject({ dashboard: null, tiles: [] });
    expect(response.headers.etag).toBe(`"${body.version}"`);
  });

  it("answers 304 while the ETag is current", async () => {
    const { accessToken } = await pair("Cached TV", salesId);
    const first = await read(accessToken);
    const etag = first.response.headers.etag as string;
    // Same content, same version.
    expect((await read(accessToken)).body.version).toBe(first.body.version);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const cached = await getDashboard(accessToken, { etag: header });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(etag);
    }
    expect(
      (await getDashboard(accessToken, { etag: '"other"' })).statusCode,
    ).toBe(200);

    // New data changes the version.
    const today = `${civilDate(new Date(), "UTC")}T00:00:00Z`;
    const setToday = (value: number) => admin`
      update observations set value = ${value}
      where connection_id = ${connectionId}
        and source_timestamp = ${today}::timestamptz`;
    await setToday(114);
    try {
      const changed = await getDashboard(accessToken, { etag });
      expect(changed.statusCode).toBe(200);
      const body = deviceDashboardResponseSchema.parse(changed.json());
      expect(changed.headers.etag).not.toBe(etag);
      expect(body.tiles[0]!.value).toBe(177);
    } finally {
      await setToday(14);
    }
  });

  it("follows a reassignment made in the web app", async () => {
    const { device, accessToken } = await pair("Moving TV", salesId);
    const before = await read(accessToken);
    const etag = before.response.headers.etag as string;

    expect((await reassign(device.id, brokenId)).statusCode).toBe(200);
    const moved = await getDashboard(accessToken, { etag });
    expect(moved.statusCode).toBe(200);
    const body = deviceDashboardResponseSchema.parse(moved.json());
    expect(body.dashboard).toEqual({ id: brokenId, name: "Broken" });
    expect(moved.headers.etag).not.toBe(etag);

    expect((await reassign(device.id, null)).statusCode).toBe(200);
    expect((await read(accessToken)).body).toMatchObject({
      dashboard: null,
      tiles: [],
    });
  });

  it("reports the connection's health per tile", async () => {
    const { accessToken } = await pair("Health TV", brokenId);
    // The data is there, but the connection needs new credentials.
    expect((await read(accessToken)).body.tiles[0]).toMatchObject({
      value: 5,
      status: "auth_failed",
    });

    await admin`
      update connection_state set auth_state = 'outage'
      where connection_id = ${brokenConnectionId}`;
    expect((await read(accessToken)).body.tiles[0]!.status).toBe("outage");

    // Healthy again, but the last sync was long ago.
    await admin`
      update connection_state
      set auth_state = 'ok', last_success_at = now() - interval '2 hours'
      where connection_id = ${brokenConnectionId}`;
    try {
      expect((await read(accessToken)).body.tiles[0]!.status).toBe("stale");
    } finally {
      await admin`
        update connection_state
        set auth_state = 'auth_failed', last_success_at = now()
        where connection_id = ${brokenConnectionId}`;
    }
  });

  it("keeps serving the other tiles when one fails", async () => {
    const id = await tileDashboard("Partly broken", [
      { connectionId, metricKey: "demo.signups", period: "today" },
      { connectionId, metricKey: "demo.signups", period: "last_7_days" },
    ]);
    // An aggregation the metric does not support makes the query fail.
    await admin`
      update dashboard_widgets set aggregation = 'avg'
      where dashboard_id = ${id} and period = 'today'`;
    const { accessToken } = await pair("Partial TV", id);
    const { body } = await read(accessToken);
    // Still says it adds up all sites of the connection (#208).
    expect(body.tiles[0]).toMatchObject({
      label: "demo.signups · All sites",
      aggregation: "avg",
      value: null,
      unit: null,
      spark: [],
      status: "no_data",
    });
    expect(body.tiles[1]).toMatchObject({
      label: "Signups · All sites",
      value: 77,
      status: "ok",
    });
  });

  it("answers schema 2 with ?schema=2 and schema 1 otherwise", async () => {
    const { accessToken } = await pair("Studio TV", salesId);
    const v1 = await read(accessToken);
    expect(v1.body).not.toHaveProperty("schema");
    // ?schema=1 is the same payload as no parameter, byte for byte.
    const explicit = await getDashboard(accessToken, { query: "?schema=1" });
    expect(explicit.body).toBe(v1.response.body);
    expect(explicit.headers.etag).toBe(v1.response.headers.etag);

    const response = await getDashboard(accessToken, { query: "?schema=2" });
    expect(response.statusCode).toBe(200);
    const v2 = deviceDashboardV2ResponseSchema.parse(response.json());
    expect(response.headers.etag).toBe(`"${v2.version}"`);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(v2.version).not.toBe(v1.body.version);
    expect(v2).toMatchObject({
      schema: 2,
      refreshAfterSec: 60,
      timeZone: "UTC",
      dashboard: { id: salesId, name: "Sales wall", showHeader: true },
      rotation: { autoAdvance: true, transition: "fade" },
      grid: { columns: 12, rows: 8 },
      theme: { name: "netrics Dark" },
      images: [],
    });
    // A migrated tile dashboard: its tiles as metric widgets, same data.
    const widgets = v2.slides.flatMap((slide) => slide.widgets);
    expect(widgets).toHaveLength(v1.body.tiles.length);
    for (const [index, tile] of v1.body.tiles.entries()) {
      const { id, label, ...data } = tile;
      expect(widgets[index]).toMatchObject({ type: "metric", id, label, data });
    }

    // Each schema answers 304 on its own ETag only.
    const v1Etag = v1.response.headers.etag as string;
    const v2Etag = response.headers.etag as string;
    const conditional = (query: string, etag: string) =>
      getDashboard(accessToken, { query, etag });
    expect((await conditional("?schema=2", v2Etag)).statusCode).toBe(304);
    expect((await conditional("", v1Etag)).statusCode).toBe(304);
    expect((await conditional("?schema=2", v1Etag)).statusCode).toBe(200);
    expect((await conditional("", v2Etag)).statusCode).toBe(200);
  });

  it("answers schema 3 with ?schema=3, with ETags per schema and device settings (#277)", async () => {
    const { device, accessToken } = await pair("Formats TV", salesId);
    const v2Response = await getDashboard(accessToken, { query: "?schema=2" });
    const v2 = deviceDashboardV2ResponseSchema.parse(v2Response.json());
    const response = await getDashboard(accessToken, { query: "?schema=3" });
    expect(response.statusCode).toBe(200);
    const v3 = deviceDashboardV3ResponseSchema.parse(response.json());
    expect(response.headers.etag).toBe(`"${v3.version}"`);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(v3).toMatchObject({
      schema: 3,
      primaryFormat: "16x9",
      formats: { "16x9": { columns: 12, rows: 8, reference: [1920, 1080] } },
      device: { rotation: 0, displayMode: "screen" },
      dashboard: v2.dashboard,
    });
    expect(v3.slides).toEqual(
      v2.slides.map((slide) => ({ ...slide, layouts: [] })),
    );

    // Each schema answers 304 on its own ETag only.
    const v1Etag = (await read(accessToken)).response.headers.etag as string;
    const v2Etag = v2Response.headers.etag as string;
    const v3Etag = response.headers.etag as string;
    const conditional = (query: string, etag: string) =>
      getDashboard(accessToken, { query, etag });
    expect((await conditional("?schema=3", v3Etag)).statusCode).toBe(304);
    expect((await conditional("?schema=3", v2Etag)).statusCode).toBe(200);
    expect((await conditional("?schema=3", v1Etag)).statusCode).toBe(200);
    expect((await conditional("?schema=2", v3Etag)).statusCode).toBe(200);
    expect((await conditional("", v3Etag)).statusCode).toBe(200);

    // Turning the TV in the web app reaches it on the next poll.
    const url = `/v1/workspaces/${workspaceId}/devices/${device.id}`;
    expect(
      (await call("PATCH", url, { cookie: owner, payload: { rotation: 90 } }))
        .statusCode,
    ).toBe(200);
    const turned = await conditional("?schema=3", v3Etag);
    expect(turned.statusCode).toBe(200);
    expect(deviceDashboardV3ResponseSchema.parse(turned.json()).device).toEqual(
      { rotation: 90, displayMode: "screen" },
    );
    // Released apps know no rotation: their payload is unchanged.
    expect((await conditional("?schema=2", v2Etag)).statusCode).toBe(304);
  });

  it("refuses an unknown schema", async () => {
    const { accessToken } = await pair("Future TV", salesId);
    for (const query of ["?schema=4", "?schema=two", "?schema="]) {
      const response = await getDashboard(accessToken, { query });
      expect(response.statusCode).toBe(400);
    }
  });

  it("references the dashboard's images, which the device can fetch", async () => {
    const png = readFileSync(
      path.join(import.meta.dirname, "images", "fixtures", "plain.png"),
    );
    const upload = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/images`,
        headers: { cookie: owner, "content-type": "image/png" },
        payload: png,
      });
      expect(response.statusCode).toBe(200);
      return imageResponseSchema.parse(response.json()).image;
    };
    const logo = await upload();
    const unused = await upload();
    const created = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/dashboards`,
      {
        cookie: owner,
        payload: {
          name: "Brand",
          settings: { logoImageId: logo.id, accentColor: "#C2410C" },
          slides: [
            {
              name: "Welcome",
              widgets: [
                { type: "text", x: 0, y: 0, w: 4, h: 2, text: "# Hello" },
                { type: "clock", x: 4, y: 0, w: 2, h: 1 },
              ],
            },
          ],
        },
      },
    );
    expect(created.statusCode).toBe(200);
    const brandId = dashboardResponseSchema.parse(created.json()).dashboard.id;
    const { accessToken } = await pair("Brand TV", brandId);
    const response = await getDashboard(accessToken, { query: "?schema=2" });
    const body = deviceDashboardV2ResponseSchema.parse(response.json());
    expect(body.dashboard?.logo).toEqual({ imageId: logo.id });
    expect(body.theme.tokens.accent).toBe("#c2410c");
    expect(body.images).toEqual([
      {
        id: logo.id,
        sha256: logo.sha256,
        contentType: "image/png",
        width: logo.width,
        height: logo.height,
        bytes: logo.bytes,
        url: `/v1/device/images/${logo.id}?v=${logo.sha256}`,
      },
    ]);
    expect(body.slides[0]!.widgets.map((widget) => widget.type)).toEqual([
      "text",
      "clock",
    ]);
    const auth = { authorization: `Bearer ${accessToken}` };
    const image = await call("GET", body.images[0]!.url, { headers: auth });
    expect(image.statusCode).toBe(200);
    expect(image.rawPayload.equals(png)).toBe(true);
    // An image of the workspace the dashboard does not show: 404.
    const other = await call(
      "GET",
      `/v1/device/images/${unused.id}?v=${unused.sha256}`,
      { headers: auth },
    );
    expect(other.statusCode).toBe(404);
  });

  it("keeps another workspace's device on its own dashboard", async () => {
    const { accessToken } = await pair("Sales TV 2", salesId);
    const strangerWorkspace = await newWorkspace(stranger);
    const strangerDashboard = await newDashboard(stranger, strangerWorkspace);
    const pairing = await startPairing();
    const approved = await approve(
      stranger,
      {
        code: pairing.code,
        name: "Stranger TV",
        dashboardId: strangerDashboard,
      },
      strangerWorkspace,
    );
    expect(approved.statusCode).toBe(200);
    const result = pollPairingResponseSchema.parse(
      (await poll(pairing)).json(),
    );
    if (result.status !== "approved") throw new Error("not approved");
    const theirs = deviceDashboardV2ResponseSchema.parse(
      (
        await getDashboard(result.credentials.accessToken, {
          query: "?schema=2",
        })
      ).json(),
    );
    expect(theirs.dashboard).toMatchObject({ id: strangerDashboard });
    expect(theirs.slides.flatMap((slide) => slide.widgets)).toEqual([]);
    const ours = deviceDashboardV2ResponseSchema.parse(
      (await getDashboard(accessToken, { query: "?schema=2" })).json(),
    );
    expect(ours.dashboard).toMatchObject({ id: salesId });
    expect(ours.version).not.toBe(theirs.version);
    const theirsV3 = deviceDashboardV3ResponseSchema.parse(
      (
        await getDashboard(result.credentials.accessToken, {
          query: "?schema=3",
        })
      ).json(),
    );
    expect(theirsV3.dashboard).toMatchObject({ id: strangerDashboard });
    expect(
      deviceDashboardV3ResponseSchema.parse(
        (await getDashboard(accessToken, { query: "?schema=3" })).json(),
      ).dashboard,
    ).toMatchObject({ id: salesId });
    // Reassigning to the other workspace's dashboard is refused.
    const device = deviceResponseSchema.parse(approved.json()).device;
    expect((await reassign(device.id, salesId)).statusCode).toBe(404);
  });

  it("accepts only the device's access token", async () => {
    const { refreshToken } = await pair("Locked TV", salesId);
    const beat = { appVersion: "1.0.0", uptimeSeconds: 1 };
    for (const response of [
      await getDashboard(refreshToken),
      await getDashboard(null, { cookie: owner }),
      await getDashboard(null),
      await heartbeat(refreshToken, beat),
      await heartbeat(null, beat, owner),
      await heartbeat(null, beat),
    ]) {
      expectError(response, 401, "unauthorized");
    }
  });

  it("stores heartbeats and shows them in the device list", async () => {
    const { device, accessToken } = await pair("Beating TV", salesId);
    const listed = async () =>
      deviceListResponseSchema
        .parse(
          (
            await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
              cookie: owner,
            })
          ).json(),
        )
        .devices.find((entry) => entry.id === device.id)!;
    expect((await listed()).heartbeat).toBeNull();

    const response = await heartbeat(accessToken, {
      appVersion: "1.2.3 (45)",
      uptimeSeconds: 3600,
      lastError: "  network timeout  ",
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const [row] = await admin`
      select app_version, uptime_seconds, last_error, last_heartbeat_at,
             last_seen_at
      from devices where id = ${device.id}`;
    expect(row).toMatchObject({
      app_version: "1.2.3 (45)",
      uptime_seconds: 3600,
      last_error: "network timeout",
    });
    expect(row!.last_heartbeat_at).not.toBeNull();
    expect(row!.last_seen_at).not.toBeNull();
    expect((await listed()).heartbeat).toMatchObject({
      appVersion: "1.2.3 (45)",
      uptimeSeconds: 3600,
      lastError: "network timeout",
    });

    // A later heartbeat without an error clears it. Browser kiosks report
    // "web <version>" (#125).
    await heartbeat(accessToken, { appVersion: "web 1.2.4", uptimeSeconds: 5 });
    expect((await listed()).heartbeat).toMatchObject({
      appVersion: "web 1.2.4",
      uptimeSeconds: 5,
      lastError: null,
    });
  });

  it("stores the reported screen and shows it in the device list (#276)", async () => {
    const { device, accessToken } = await pair("Measured TV", salesId);
    const listed = async () =>
      deviceListResponseSchema
        .parse(
          (
            await call("GET", `/v1/workspaces/${workspaceId}/devices`, {
              cookie: owner,
            })
          ).json(),
        )
        .devices.find((entry) => entry.id === device.id)!;
    expect((await listed()).screen).toBeNull();

    const beat = { appVersion: "tvos 1.0", uptimeSeconds: 10 };
    const screen = {
      width: 3840,
      height: 2160,
      scale: 1,
      format: "16x9",
      mode: "screen",
    };
    expect(
      (
        await heartbeat(accessToken, {
          ...beat,
          screen: { ...screen, extra: "x".repeat(10_000) },
        })
      ).statusCode,
    ).toBe(204);
    expect((await listed()).screen).toEqual(screen);
    // Only the validated keys are stored.
    const [row] =
      await admin`select screen from devices where id = ${device.id}`;
    expect(row!.screen).toEqual(screen);

    // An older app's heartbeat (no screen) keeps the last report.
    await heartbeat(accessToken, beat);
    expect((await listed()).screen).toEqual(screen);

    // A browser kiosk that does not know the formats yet omits `format`.
    const kiosk = { width: 1080, height: 1920, scale: 2.5, mode: "scroll" };
    await heartbeat(accessToken, { ...beat, screen: kiosk });
    expect((await listed()).screen).toEqual(kiosk);
  });

  it("refuses screens out of range (#276)", async () => {
    const { device, accessToken } = await pair("Odd TV", null);
    const beat = { appVersion: "web 1.0", uptimeSeconds: 1 };
    const screen = { width: 1920, height: 1080, scale: 1, mode: "screen" };
    for (const bad of [
      { ...screen, width: 0 },
      { ...screen, height: -1080 },
      { ...screen, width: 16_385 },
      { ...screen, height: 1e9 },
      { ...screen, width: 1920.5 },
      { ...screen, width: "1920" },
      { ...screen, scale: 0.4 },
      { ...screen, scale: 8.5 },
      { ...screen, scale: Number.MAX_VALUE },
      { ...screen, format: "5x4" },
      { ...screen, format: "" },
      { ...screen, mode: "glance" },
      { width: 1920, height: 1080, scale: 1 },
      [1920, 1080],
      "1920x1080",
      null,
    ]) {
      expect(
        (await heartbeat(accessToken, { ...beat, screen: bad })).statusCode,
      ).toBe(400);
    }
    const [row] = await admin`
      select screen, last_heartbeat_at from devices where id = ${device.id}`;
    expect(row).toEqual({ screen: null, last_heartbeat_at: null });
    // The bounds themselves are accepted.
    for (const edge of [
      { width: 1, height: 1, scale: 0.5, mode: "screen" },
      { width: 16_384, height: 16_384, scale: 8, mode: "scroll" },
    ]) {
      expect(
        (await heartbeat(accessToken, { ...beat, screen: edge })).statusCode,
      ).toBe(204);
    }
  });

  it("rejects malformed heartbeats", async () => {
    const { accessToken } = await pair("Sloppy TV", null);
    for (const payload of [
      {},
      { uptimeSeconds: 1 },
      { appVersion: "", uptimeSeconds: 1 },
      { appVersion: "x".repeat(51), uptimeSeconds: 1 },
      { appVersion: "1.0", uptimeSeconds: -1 },
      { appVersion: "1.0", uptimeSeconds: 1.5 },
      { appVersion: "1.0", uptimeSeconds: "1" },
      { appVersion: "1.0", uptimeSeconds: 1, lastError: "x".repeat(501) },
    ]) {
      expect((await heartbeat(accessToken, payload)).statusCode).toBe(400);
    }
  });

  it("shuts out a revoked device", async () => {
    const { device, accessToken } = await pair("Retired TV", salesId);
    await call(
      "POST",
      `/v1/workspaces/${workspaceId}/devices/${device.id}/revoke`,
      { cookie: owner },
    );
    expectError(
      await heartbeat(accessToken, { appVersion: "1.0", uptimeSeconds: 1 }),
      401,
      "unauthorized",
    );
    expectError(await getDashboard(accessToken), 401, "unauthorized");
  });
});
