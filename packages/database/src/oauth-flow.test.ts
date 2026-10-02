import { randomBytes, randomUUID } from "node:crypto";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { createWorkspace, withWorkspace } from "./context.js";
import {
  insertOAuthAuthorization,
  oauthAccountHasGrant,
  pruneOAuthAuthorizations,
  upsertConnectionOAuth,
} from "./oauth.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Migration 0024 (#132): pruning finished OAuth authorizations from the
// scheduler, and the cross-workspace "does this account hold a grant" check
// the callback uses before revoking a refused grant.

type Db = PostgresJsDatabase<typeof schema & typeof authSchema>;

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let schedulerClient: postgres.Sql;
let db: Db;
let schedulerDb: Db;
let userId: string;
let workspaceA: string;
let workspaceB: string;

async function authorization(
  expiresInMs: number,
  consumed: boolean,
): Promise<string> {
  const id = randomUUID();
  await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
    await insertOAuthAuthorization(tx, {
      id,
      workspaceId: workspaceA,
      userId,
      provider: "google",
      connectorId: "demo",
      connectionId: null,
      purpose: "connect",
      allowAccountChange: false,
      returnPath: "/workspaces/x/connections/new",
      stateHash: randomBytes(32).toString("hex"),
      nonce: "nonce",
      codeVerifierEncrypted: Buffer.from("sealed"),
      expiresAt: new Date(Date.now() + expiresInMs),
    });
  });
  if (consumed) {
    await admin`update oauth_authorizations set consumed_at = now() where id = ${id}`;
  }
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl);
  schedulerClient = postgres(roleUrl(testDb.appUrl, "netrics_scheduler"));
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "flow@example.com", displayName: "Flow" })
    .returning({ id: schema.users.id });
  userId = user!.id;
  workspaceA = await createWorkspace(db, { name: "A", ownerUserId: userId });
  workspaceB = await createWorkspace(db, { name: "B", ownerUserId: userId });
  await admin`insert into connectors (id, version, manifest)
    values ('demo', '1.0.0', '{"id":"demo"}')`;
});

afterAll(async () => {
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await appClient?.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient?.end({ timeout: 5 }).catch(() => undefined);
});

describe("pruneOAuthAuthorizations", () => {
  beforeEach(async () => {
    await admin`delete from oauth_authorizations`;
  });

  it("deletes consumed and expired rows and keeps open ones", async () => {
    const open = await authorization(10 * 60 * 1000, false);
    await authorization(10 * 60 * 1000, true);
    await authorization(-1000, false);
    await authorization(-1000, true);

    expect(await pruneOAuthAuthorizations(schedulerDb, 100)).toBe(3);
    const left = await admin`select id from oauth_authorizations`;
    expect(left.map((row) => row.id)).toEqual([open]);
  });

  it("deletes at most one batch per call", async () => {
    for (let i = 0; i < 3; i++) {
      await authorization(-1000, false);
    }
    expect(await pruneOAuthAuthorizations(schedulerDb, 2)).toBe(2);
    expect(await pruneOAuthAuthorizations(schedulerDb, 2)).toBe(1);
    expect(await pruneOAuthAuthorizations(schedulerDb, 2)).toBe(0);
  });

  it("is callable by the scheduler role only", async () => {
    await expect(
      appClient`select prune_oauth_authorizations(1)`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe("oauthAccountHasGrant", () => {
  it("sees grants in any workspace and answers only a boolean", async () => {
    const connectionB = await withWorkspace(
      db,
      { workspaceId: workspaceB },
      async (tx) => {
        const [row] = await tx
          .insert(schema.connections)
          .values({ workspaceId: workspaceB, connectorId: "demo", name: "B" })
          .returning({ id: schema.connections.id });
        await upsertConnectionOAuth(tx, {
          workspaceId: workspaceB,
          connectionId: row!.id,
          provider: "google",
          accountSub: "sub-shared",
          accountEmail: null,
          grantedScopes: ["openid"],
          accessTokenEncrypted: null,
          accessTokenExpiresAt: null,
        });
        return row!.id;
      },
    );
    expect(connectionB).toBeTruthy();
    // Asked from workspace A's context, it still sees workspace B's grant.
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      expect(await oauthAccountHasGrant(tx, "google", "sub-shared")).toBe(true);
      expect(await oauthAccountHasGrant(tx, "google", "sub-other")).toBe(false);
      expect(await oauthAccountHasGrant(tx, "acme", "sub-shared")).toBe(false);
    });
  });

  it("is not executable by the scheduler role", async () => {
    await expect(
      schedulerClient`select oauth_account_has_grant('google', 'x')`,
    ).rejects.toThrow(/permission denied/);
  });
});
