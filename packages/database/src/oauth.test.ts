import { randomBytes, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspace, withWorkspace } from "./context.js";
import * as authSchema from "./auth-schema.js";
import { findConnection, listConnections } from "./connections.js";
import {
  consumeOAuthAuthorization,
  findConnectionOAuth,
  insertOAuthAuthorization,
  upsertConnectionOAuth,
  type NewOAuthAuthorization,
} from "./oauth.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// ADR 0012 records: oauth_authorizations and connection_oauth under RLS,
// the state-consuming SECURITY DEFINER function, and needs_reauthorization.

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

let testDb: TestDatabase;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;

let userA: string;
let userB: string;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

function stateHash(): string {
  return randomBytes(32).toString("hex");
}

function authorization(
  workspaceId: string,
  userId: string,
  overrides: Partial<NewOAuthAuthorization> = {},
): NewOAuthAuthorization {
  return {
    id: randomUUID(),
    workspaceId,
    userId,
    provider: "google",
    connectorId: "demo",
    connectionId: null,
    purpose: "connect",
    allowAccountChange: false,
    returnPath: "/workspaces/x/connections/new",
    stateHash: stateHash(),
    nonce: randomBytes(16).toString("base64url"),
    codeVerifierEncrypted: Buffer.from("sealed-verifier"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

function grant(workspaceId: string, connectionId: string, sub: string) {
  return {
    workspaceId,
    connectionId,
    provider: "google",
    accountSub: sub,
    accountEmail: `${sub}@example.com`,
    grantedScopes: ["openid", "email"],
    accessTokenEncrypted: Buffer.from("sealed-access-token"),
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appClient = postgres(testDb.appUrl);
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });

  const [a, b] = await db
    .insert(schema.users)
    .values([
      { email: "oauth-a@example.com", displayName: "Owner A" },
      { email: "oauth-b@example.com", displayName: "Owner B" },
    ])
    .returning({ id: schema.users.id });
  userA = a!.id;
  userB = b!.id;
  workspaceA = await createWorkspace(db, { name: "A", ownerUserId: userA });
  workspaceB = await createWorkspace(db, { name: "B", ownerUserId: userB });

  const owner = postgres(testDb.adminUrl, { max: 1 });
  await owner`insert into connectors (id, version, manifest)
    values ('demo', '1.0.0', '{"id":"demo"}')`;
  await owner.end({ timeout: 5 });

  const newConnection = (workspaceId: string) =>
    withWorkspace(db, { workspaceId }, async (tx) => {
      const [row] = await tx
        .insert(schema.connections)
        .values({ workspaceId, connectorId: "demo", name: "Search Console" })
        .returning({ id: schema.connections.id });
      await tx
        .insert(schema.connectionState)
        .values({ connectionId: row!.id, workspaceId });
      return row!.id;
    });
  connectionA = await newConnection(workspaceA);
  connectionB = await newConnection(workspaceB);

  await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
    await insertOAuthAuthorization(tx, authorization(workspaceA, userA));
    await upsertConnectionOAuth(tx, grant(workspaceA, connectionA, "sub-a"));
  });
  await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
    await insertOAuthAuthorization(tx, authorization(workspaceB, userB));
    await upsertConnectionOAuth(tx, grant(workspaceB, connectionB, "sub-b"));
  });
}, 30_000);

afterAll(async () => {
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("tenant isolation of the OAuth tables", () => {
  it("shows each workspace only its own rows", async () => {
    for (const [workspaceId, connectionId] of [
      [workspaceA, connectionA],
      [workspaceB, connectionB],
    ] as const) {
      await withWorkspace(db, { workspaceId }, async (tx) => {
        const authorizations = await tx
          .select()
          .from(schema.oauthAuthorizations);
        expect(authorizations).toHaveLength(1);
        expect(authorizations[0]!.workspaceId).toBe(workspaceId);
        const grants = await tx.select().from(schema.connectionOAuth);
        expect(grants.map((row) => row.connectionId)).toEqual([connectionId]);
      });
    }
  });

  it("returns no rows without a tenant context", async () => {
    expect(await db.select().from(schema.oauthAuthorizations)).toHaveLength(0);
    expect(await db.select().from(schema.connectionOAuth)).toHaveLength(0);
  });

  it("does not find another workspace's grant even when asked by id", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      // Explicit predicate and RLS agree: B's connection is not A's.
      expect(await findConnectionOAuth(tx, workspaceA, connectionB)).toBeNull();
      expect(await findConnectionOAuth(tx, workspaceB, connectionB)).toBeNull();
      expect(
        (await findConnectionOAuth(tx, workspaceA, connectionA))?.accountSub,
      ).toBe("sub-a");
    });
  });

  it("rejects rows carrying another workspace's id", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        insertOAuthAuthorization(tx, authorization(workspaceB, userA)),
      ),
      /row-level security/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        upsertConnectionOAuth(tx, grant(workspaceB, connectionB, "forged")),
      ),
      /row-level security/,
    );
  });

  it("pins grants and reauthorizations to their connection's workspace", async () => {
    // A connection of B under A's workspace id: the composite foreign key
    // refuses it whatever the tenant context.
    const ungrantedB = await withWorkspace(
      db,
      { workspaceId: workspaceB },
      async (tx) => {
        const [row] = await tx
          .insert(schema.connections)
          .values({ workspaceId: workspaceB, connectorId: "demo", name: "b2" })
          .returning({ id: schema.connections.id });
        return row!.id;
      },
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        upsertConnectionOAuth(tx, grant(workspaceA, ungrantedB, "forged")),
      ),
      /connection_oauth_connection_fk/,
    );
    // Overwriting B's existing grant from A writes nothing.
    await expect(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        upsertConnectionOAuth(tx, grant(workspaceA, connectionB, "forged")),
      ),
    ).rejects.toThrow();
    await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
      expect(
        (await findConnectionOAuth(tx, workspaceB, connectionB))?.accountSub,
      ).toBe("sub-b");
    });
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        insertOAuthAuthorization(
          tx,
          authorization(workspaceA, userA, {
            purpose: "reauthorize",
            connectionId: connectionB,
          }),
        ),
      ),
      /oauth_authorizations_connection_fk/,
    );
  });

  it("cannot update or delete another workspace's rows", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const updated = await tx
        .update(schema.connectionOAuth)
        .set({ accountEmail: "hijacked@example.com" })
        .where(eq(schema.connectionOAuth.connectionId, connectionB))
        .returning();
      expect(updated).toHaveLength(0);
      const deleted = await tx
        .delete(schema.oauthAuthorizations)
        .where(eq(schema.oauthAuthorizations.workspaceId, workspaceB))
        .returning();
      expect(deleted).toHaveLength(0);
    });
    await withWorkspace(db, { workspaceId: workspaceB }, async (tx) => {
      const [row] = await tx.select().from(schema.connectionOAuth);
      expect(row!.accountEmail).toBe("sub-b@example.com");
      expect(await tx.select().from(schema.oauthAuthorizations)).toHaveLength(
        1,
      );
    });
  });
});

describe("authorization rows", () => {
  it("requires a connection exactly for reauthorizations", async () => {
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        insertOAuthAuthorization(
          tx,
          authorization(workspaceA, userA, { purpose: "reauthorize" }),
        ),
      ),
      /oauth_authorizations_purpose_connection/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        insertOAuthAuthorization(
          tx,
          authorization(workspaceA, userA, { connectionId: connectionA }),
        ),
      ),
      /oauth_authorizations_purpose_connection/,
    );
    await expectDbError(
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        insertOAuthAuthorization(
          tx,
          authorization(workspaceA, userA, { allowAccountChange: true }),
        ),
      ),
      /oauth_authorizations_account_change/,
    );
  });

  it("accepts only relative return paths", async () => {
    for (const returnPath of ["https://evil.example", "//evil.example/x"]) {
      await expectDbError(
        withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
          insertOAuthAuthorization(
            tx,
            authorization(workspaceA, userA, { returnPath }),
          ),
        ),
        /oauth_authorizations_return_path/,
      );
    }
  });

  it("goes with the connection it reauthorizes", async () => {
    const connectionId = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      async (tx) => {
        const [row] = await tx
          .insert(schema.connections)
          .values({ workspaceId: workspaceA, connectorId: "demo", name: "x" })
          .returning({ id: schema.connections.id });
        await insertOAuthAuthorization(
          tx,
          authorization(workspaceA, userA, {
            purpose: "reauthorize",
            connectionId: row!.id,
            allowAccountChange: true,
          }),
        );
        await upsertConnectionOAuth(tx, grant(workspaceA, row!.id, "sub-x"));
        return row!.id;
      },
    );
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      await tx
        .delete(schema.connections)
        .where(eq(schema.connections.id, connectionId));
      expect(
        await tx
          .select()
          .from(schema.oauthAuthorizations)
          .where(eq(schema.oauthAuthorizations.connectionId, connectionId)),
      ).toHaveLength(0);
      expect(
        await findConnectionOAuth(tx, workspaceA, connectionId),
      ).toBeNull();
    });
  });
});

describe("consume_oauth_authorization", () => {
  async function started(
    overrides: Partial<NewOAuthAuthorization> = {},
  ): Promise<NewOAuthAuthorization> {
    const input = authorization(workspaceA, userA, overrides);
    await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      insertOAuthAuthorization(tx, input),
    );
    return input;
  }

  it("returns the authorization once, without a tenant context", async () => {
    const input = await started({
      purpose: "reauthorize",
      connectionId: connectionA,
      allowAccountChange: true,
      returnPath: "/workspaces/a/connections/c",
    });
    const consumed = await consumeOAuthAuthorization(db, input.stateHash);
    expect(consumed).toEqual({
      id: input.id,
      workspaceId: workspaceA,
      userId: userA,
      provider: "google",
      connectorId: "demo",
      connectionId: connectionA,
      purpose: "reauthorize",
      allowAccountChange: true,
      returnPath: "/workspaces/a/connections/c",
      nonce: input.nonce,
      codeVerifierEncrypted: input.codeVerifierEncrypted,
    });
    // A replay gets nothing.
    expect(await consumeOAuthAuthorization(db, input.stateHash)).toBeNull();
    const [row] = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx
        .select()
        .from(schema.oauthAuthorizations)
        .where(eq(schema.oauthAuthorizations.id, input.id)),
    );
    expect(row!.consumedAt).toBeInstanceOf(Date);
  });

  it("returns nothing for unknown and expired states", async () => {
    expect(await consumeOAuthAuthorization(db, stateHash())).toBeNull();
    const expired = await started({ expiresAt: new Date(Date.now() - 1000) });
    expect(await consumeOAuthAuthorization(db, expired.stateHash)).toBeNull();
    // An expired state stays unconsumed: nothing was handed out.
    const [row] = await withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
      tx
        .select()
        .from(schema.oauthAuthorizations)
        .where(eq(schema.oauthAuthorizations.id, expired.id)),
    );
    expect(row!.consumedAt).toBeNull();
  });

  it("hands a state to exactly one of concurrent callers", async () => {
    const input = await started();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        consumeOAuthAuthorization(db, input.stateHash),
      ),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("is the app role's only path to rows outside its context", async () => {
    // The function returns its declared columns only, nothing else of the
    // row (no created_at, no state hash).
    const input = await started();
    const rows = await db.execute(
      sql`select * from consume_oauth_authorization(${input.stateHash})`,
    );
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "id",
        "workspace_id",
        "user_id",
        "provider",
        "connector_id",
        "connection_id",
        "purpose",
        "allow_account_change",
        "return_path",
        "nonce",
        "code_verifier_encrypted",
      ].sort(),
    );
  });
});

describe("connection reads", () => {
  it("include the linked account but never token material", async () => {
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      const found = await findConnection(tx, workspaceA, connectionA);
      expect(found!.oauth).toEqual({
        provider: "google",
        accountEmail: "sub-a@example.com",
        grantedScopes: ["openid", "email"],
      });
      const listed = await listConnections(tx, workspaceA);
      const row = listed.find((entry) => entry.row.id === connectionA);
      expect(row!.oauth).toEqual(found!.oauth);
    });
  });

  it("report no account for connections without a grant", async () => {
    const connectionId = await withWorkspace(
      db,
      { workspaceId: workspaceA },
      async (tx) => {
        const [row] = await tx
          .insert(schema.connections)
          .values({ workspaceId: workspaceA, connectorId: "demo", name: "t" })
          .returning({ id: schema.connections.id });
        return row!.id;
      },
    );
    await withWorkspace(db, { workspaceId: workspaceA }, async (tx) => {
      expect((await findConnection(tx, workspaceA, connectionId))!.oauth).toBe(
        null,
      );
      const listed = await listConnections(tx, workspaceA);
      expect(
        listed.find((entry) => entry.row.id === connectionId)!.oauth,
      ).toBeNull();
    });
  });
});

describe("needs_reauthorization", () => {
  it("carries a reason, and only in that state", async () => {
    const set = (authState: string, authReason: string | null) =>
      withWorkspace(db, { workspaceId: workspaceA }, (tx) =>
        tx
          .update(schema.connectionState)
          .set({ authState, authReason })
          .where(eq(schema.connectionState.connectionId, connectionA)),
      );
    await set("needs_reauthorization", "invalid_grant");
    await set("needs_reauthorization", "scope_missing");
    await expectDbError(
      set("auth_failed", "invalid_grant"),
      /connection_state_auth_reason_state/,
    );
    await expectDbError(
      set("needs_reauthorization", "bogus"),
      /connection_state_auth_reason_valid/,
    );
    await set("ok", null);
  });
});
