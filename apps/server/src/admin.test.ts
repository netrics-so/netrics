import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminWorkspaceListResponseSchema } from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  createServiceToken,
  issueSetupToken,
  revokePrincipalToken,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { INVITATION_TOKEN_HEADER, createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { SETUP_TOKEN_HEADER, hashSetupToken } from "./setup.js";
import { createTestDatabase } from "./test-db.js";
import { generatePrincipalToken, hashToken } from "./tokens.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let ownerDb: Database;
let admin: Sql;
let instanceAdminCookie: string;
let memberCookie: string;

async function signUp(
  email: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers,
    payload: { name: email.split("@")[0], email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

function listWorkspaces(
  headers: Record<string, string>,
): Promise<InjectResponse> {
  return app.inject({ url: "/v1/admin/workspaces", headers });
}

async function serviceToken(
  scopes: string[],
  expiresAt: Date | null = null,
): Promise<{ id: string; token: string }> {
  const token = generatePrincipalToken();
  const { id } = await createServiceToken(ownerDb, {
    name: "test",
    tokenHash: hashToken(token),
    scopes,
    expiresAt,
  });
  return { id, token };
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    NETRICS_SIGNUP: "closed",
  });
  db = createDatabase(testDb.appUrl);
  ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  app = await buildApp(config, {
    db,
    checkDb: async () => true,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
  });

  // The account created through first-run setup becomes instance admin (the
  // database grants it; the application role cannot).
  await issueSetupToken(db, hashSetupToken("admin-setup-token-0123456789"));
  instanceAdminCookie = await signUp("root@example.com", {
    [SETUP_TOKEN_HEADER]: "admin-setup-token-0123456789",
  });
  await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: instanceAdminCookie },
    payload: { name: "Root WS" },
  });
  // A second person joins through an invitation (sign-up is closed).
  const rootWorkspaces = await app.inject({
    url: "/v1/workspaces",
    headers: { cookie: instanceAdminCookie },
  });
  const rootWorkspaceId = rootWorkspaces.json<{
    workspaces: { id: string }[];
  }>().workspaces[0]!.id;
  const invited = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${rootWorkspaceId}/invitations`,
    headers: { cookie: instanceAdminCookie },
    payload: { email: "member@example.com", role: "viewer" },
  });
  const inviteToken = new URL(
    invited.json<{ inviteUrl: string }>().inviteUrl,
  ).pathname
    .split("/")
    .pop()!;
  memberCookie = await signUp("member@example.com", {
    [INVITATION_TOKEN_HEADER]: inviteToken,
  });
  await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: memberCookie },
    payload: { name: "Member WS" },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await ownerDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("installation admin API", () => {
  it("serves the setup account (instance admin) across all workspaces", async () => {
    const response = await listWorkspaces({ cookie: instanceAdminCookie });
    expect(response.statusCode).toBe(200);
    const { workspaces } = adminWorkspaceListResponseSchema.parse(
      response.json(),
    );
    expect(workspaces.map((w) => [w.name, w.memberCount])).toEqual([
      ["Root WS", 1],
      ["Member WS", 1],
    ]);
  });

  it("refuses ordinary users and anonymous callers", async () => {
    expect((await listWorkspaces({ cookie: memberCookie })).statusCode).toBe(
      403,
    );
    expect((await listWorkspaces({})).statusCode).toBe(401);
  });

  it("serves a service token with the scope, and nothing else", async () => {
    const scoped = await serviceToken(["installation:workspaces:read"]);
    const ok = await listWorkspaces({
      authorization: `Bearer ${scoped.token}`,
    });
    expect(ok.statusCode).toBe(200);

    const unscoped = await serviceToken([]);
    expect(
      (await listWorkspaces({ authorization: `Bearer ${unscoped.token}` }))
        .statusCode,
    ).toBe(403);

    // A service token is not a user: tenant routes stay closed to it.
    const tenant = await app.inject({
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${scoped.token}` },
    });
    expect(tenant.statusCode).toBe(401);
  });

  it("rejects malformed, unknown, revoked and expired tokens without cookie fallback", async () => {
    const revoked = await serviceToken(["installation:workspaces:read"]);
    await revokePrincipalToken(ownerDb, revoked.id);
    const expired = await serviceToken(
      ["installation:workspaces:read"],
      new Date(Date.now() - 1000),
    );
    for (const authorization of [
      "Bearer not-a-token",
      "Basic dXNlcjpwYXNz",
      `Bearer ${generatePrincipalToken()}`,
      `Bearer ${revoked.token}`,
      `Bearer ${expired.token}`,
    ]) {
      // Even with a valid instance-admin cookie alongside.
      const response = await listWorkspaces({
        authorization,
        cookie: instanceAdminCookie,
      });
      expect(response.statusCode, authorization).toBe(401);
    }
  });

  it("records token usage", async () => {
    const { id, token } = await serviceToken(["installation:workspaces:read"]);
    await listWorkspaces({ authorization: `Bearer ${token}` });
    const [row] = await admin<{ used: boolean }[]>`
      select last_used_at is not null as used from principal_tokens where id = ${id}
    `;
    expect(row!.used).toBe(true);
  });
});

describe("principal storage is out of the application's reach", () => {
  it("cannot read tokens or grant instance administration", async () => {
    const appSql = db.$client; // connected as netrics_app
    await expect(appSql`select * from principal_tokens`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appSql`update users set is_instance_admin = true`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      appSql`insert into users (email, display_name, is_instance_admin) values ('x@y.z', 'x', true)`,
    ).rejects.toThrow(/permission denied/);
  });
});
