import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { createWorkspace, withWorkspace } from "./context.js";
import { deleteConnection } from "./connections.js";
import { releaseOAuthGrant, upsertConnectionOAuth } from "./oauth.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// ADR 0012 disconnect, #133: oauth_release_grant is the app role's only view
// of other workspaces' connection_oauth rows. It answers one boolean, only
// for a connection that holds the grant in the caller's workspace, and
// serializes disconnects of one account with a transaction advisory lock.

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

let testDb: TestDatabase;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let counter = 0;

async function oauthConnection(
  workspaceId: string,
  sub: string,
  provider = "google",
): Promise<string> {
  counter += 1;
  return withWorkspace(db, { workspaceId }, async (tx) => {
    const [row] = await tx
      .insert(schema.connections)
      .values({ workspaceId, connectorId: "demo", name: `c${counter}` })
      .returning({ id: schema.connections.id });
    await upsertConnectionOAuth(tx, {
      workspaceId,
      connectionId: row!.id,
      provider,
      accountSub: sub,
      accountEmail: null,
      grantedScopes: ["openid"],
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
    });
    return row!.id;
  });
}

/** release + delete in one transaction, like the API's disconnect. */
function disconnect(
  workspaceId: string,
  connectionId: string,
  sub: string,
  hold?: Promise<void>,
): Promise<boolean> {
  return withWorkspace(db, { workspaceId }, async (tx) => {
    const shared = await releaseOAuthGrant(tx, {
      provider: "google",
      accountSub: sub,
      connectionId,
    });
    await deleteConnection(tx, workspaceId, connectionId);
    await hold;
    return shared;
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl, { max: 8 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  const [a, b] = await db
    .insert(schema.users)
    .values([
      { email: "release-a@example.com", displayName: "A" },
      { email: "release-b@example.com", displayName: "B" },
    ])
    .returning({ id: schema.users.id });
  workspaceA = await createWorkspace(db, { name: "A", ownerUserId: a!.id });
  workspaceB = await createWorkspace(db, { name: "B", ownerUserId: b!.id });
  const owner = postgres(testDb.adminUrl, { max: 1 });
  await owner`insert into connectors (id, version, manifest)
    values ('demo', '1.0.0', '{"id":"demo"}')`;
  await owner.end({ timeout: 5 });
});

afterAll(async () => {
  await appClient?.end({ timeout: 5 });
});

describe("oauth_release_grant", () => {
  it("returns a single boolean and nothing else", async () => {
    const owner = postgres(testDb.adminUrl, { max: 1 });
    try {
      const [fn] = await owner<
        { result: string; returnsSet: boolean; definer: boolean }[]
      >`
        select pg_get_function_result(p.oid) as result,
               p.proretset as "returnsSet", p.prosecdef as definer
        from pg_proc p where p.proname = 'oauth_release_grant'
      `;
      expect(fn).toEqual({
        result: "boolean",
        returnsSet: false,
        definer: true,
      });
    } finally {
      await owner.end({ timeout: 5 });
    }
    const connection = await oauthConnection(workspaceA, "sub-single");
    const rows = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx.execute(
        sql`select * from oauth_release_grant('google', 'sub-single', ${connection}::uuid)`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0]!)).toEqual([false]);
  });

  it("reports another connection holding the grant in any workspace", async () => {
    const mine = await oauthConnection(workspaceA, "sub-shared");
    const other = await oauthConnection(workspaceB, "sub-shared");
    // The app role cannot see the other workspace's row directly.
    const visible = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx
        .select()
        .from(schema.connectionOAuth)
        .where(eq(schema.connectionOAuth.accountSub, "sub-shared")),
    );
    expect(visible.map((row) => row.connectionId)).toEqual([mine]);
    // Only the definer function tells that it exists.
    expect(await disconnect(workspaceA, mine, "sub-shared")).toBe(true);
    expect(await disconnect(workspaceB, other, "sub-shared")).toBe(false);
  });

  it("ignores grants of other providers and other accounts", async () => {
    const mine = await oauthConnection(workspaceA, "sub-x");
    await oauthConnection(workspaceA, "sub-y");
    await oauthConnection(workspaceB, "sub-x", "other-provider");
    expect(await disconnect(workspaceA, mine, "sub-x")).toBe(false);
  });

  it("refuses connections that do not hold the grant (no probing)", async () => {
    const mine = await oauthConnection(workspaceA, "sub-probe-a");
    const theirs = await oauthConnection(workspaceB, "sub-probe-b");
    const probe = (connectionId: string, sub: string) =>
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        releaseOAuthGrant(tx, {
          provider: "google",
          accountSub: sub,
          connectionId,
        }),
      );
    // Another account's sub with my connection.
    await expect(probe(mine, "sub-probe-b").catch(errorChain)).resolves.toMatch(
      /does not hold this grant/,
    );
    // Another workspace's connection.
    await expect(
      probe(theirs, "sub-probe-b").catch(errorChain),
    ).resolves.toMatch(/does not hold this grant/);
    // No tenant context at all.
    await expect(
      db
        .execute(
          sql`select oauth_release_grant('google', 'sub-probe-b', ${theirs}::uuid)`,
        )
        .catch(errorChain),
    ).resolves.toMatch(/does not hold this grant/);
  });

  it("serializes concurrent disconnects of the last two connections: exactly one sees no other", async () => {
    for (let round = 0; round < 5; round += 1) {
      const sub = `sub-race-${round}`;
      const first = await oauthConnection(workspaceA, sub);
      const second = await oauthConnection(workspaceB, sub);
      // The first transaction holds its lock until released; the second
      // must wait for its commit and then see the deletion.
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const one = disconnect(workspaceA, first, sub, hold);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const two = disconnect(workspaceB, second, sub);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const results = await Promise.all([one, two]);
      expect(results.filter((shared) => !shared)).toHaveLength(1);
      expect(results).toEqual([true, false]);
    }
  });
});
