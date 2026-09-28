import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  dashboardResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  errorResponseSchema,
  pollPairingResponseSchema,
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

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { CODE_ALPHABET } from "./devices/service.js";
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
  method: "GET" | "POST" | "DELETE",
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
  app = await buildApp(config, { db, authService, checkDb: async () => true });
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
