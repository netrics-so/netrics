import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createWorkspace,
  deleteConnection,
  schema,
  updateConnection,
  withWorkspace,
  type Database,
} from "@netrics/database";

import {
  createCredentialKeyring,
  decryptCredentials,
  decryptOAuthAccessToken,
  decryptSignedKeyAccessToken,
  encryptCredentials,
} from "../credentials.js";
import { REFRESH_MARGIN_MS } from "../oauth/tokens.js";
import { capturingLogger } from "../oauth/test-provider.js";
import { reencryptCredentials } from "../reencrypt.js";
import { createTestDatabase } from "../test-db.js";
import { callWithSignedKey, SignedKeyRejectedError } from "./connector-auth.js";
import {
  SignedKeyExchangeError,
  SignedKeyProviders,
  type SignedKey,
} from "./registry.js";
import { p256KeyPair, pemBody } from "./test-keys.js";
import {
  createFakeTokenExchange,
  FIXTURE_PROVIDER_ID,
  FIXTURE_UNAUTHORIZED,
  fixtureClient,
  fixtureCredentials,
  fixtureExchangeProvider,
  type FakeTokenExchange,
  type FixtureClient,
} from "./test-token-exchange.js";
import {
  createSignedKeyTokenStore,
  type SignedKeyTokenStore,
} from "./token-store.js";

// #369 (ADR 0020 §2): the cached exchanged token of a signed-key
// connection. One exchange for concurrent callers, a stale token replaced
// once, a 401 with a cached token re-exchanged once, the cache bound to the
// connection, its workspace and its key, and cleared when the key changes
// or the connection goes.

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));

let db: Database;
let adminDb: Database;
let workspaceA: string;
let workspaceB: string;
let store: SignedKeyTokenStore;
const logs: string[] = [];

beforeAll(async () => {
  const testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl, { max: 20 });
  adminDb = createDatabase(testDb.adminUrl, { max: 2 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "signed-tokens@example.com", displayName: "Tokens" })
    .returning({ id: schema.users.id });
  workspaceA = await createWorkspace(db, { name: "A", ownerUserId: user!.id });
  workspaceB = await createWorkspace(db, { name: "B", ownerUserId: user!.id });
  store = createSignedKeyTokenStore({
    db,
    credentialKeyring: KEYRING,
    logger: capturingLogger(logs),
  });
}, 60_000);

afterAll(async () => {
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await adminDb?.$client.end({ timeout: 5 }).catch(() => undefined);
});

/** A fake provider with one client, its parsed key and a stored connection. */
async function setup(workspaceId = workspaceA) {
  const client = fixtureClient(p256KeyPair());
  const fake = createFakeTokenExchange([client]);
  const key = parseKey(fake, client);
  const connectionId = await withWorkspace(db, { workspaceId }, async (tx) => {
    const [row] = await tx
      .insert(schema.connections)
      .values({
        workspaceId,
        connectorId: "demo",
        name: `exchange ${client.clientId}`,
        config: {},
      })
      .returning({ id: schema.connections.id });
    const binding = { workspaceId, connectionId: row!.id };
    await tx
      .update(schema.connections)
      .set({
        credentialsEncrypted: Buffer.from(
          encryptCredentials(
            JSON.stringify(fixtureCredentials(client)),
            KEYRING,
            binding,
          ),
          "utf8",
        ),
      })
      .where(eq(schema.connections.id, row!.id));
    return row!.id;
  });
  const binding = { workspaceId, connectionId };
  return {
    client,
    fake,
    key,
    binding,
    cache: store.forConnection(binding),
  };
}

function parseKey(fake: FakeTokenExchange, client: FixtureClient): SignedKey {
  const registry = new SignedKeyProviders({
    definitions: new Map([[FIXTURE_PROVIDER_ID, fixtureExchangeProvider]]),
    http: () => (url, init) => fake.fetch(url, init),
  });
  const parsed = registry.parse(
    fixtureExchangeProvider,
    fixtureCredentials(client),
  );
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.value;
}

async function tokenRows(workspaceId: string) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    tx.select().from(schema.connectionSignedKeyTokens),
  );
}

async function tokenRow(binding: {
  workspaceId: string;
  connectionId: string;
}) {
  const rows = await tokenRows(binding.workspaceId);
  return rows.find((row) => row.connectionId === binding.connectionId);
}

/** A connector call against the fake API with the handed token. */
function apiCall(fake: FakeTokenExchange, seen: string[] = []) {
  return async (credentials: { accessToken: string }) => {
    seen.push(credentials.accessToken);
    const response = await fake.fetch("https://api.exchange.test/v1/report", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    if (response.status === 401) {
      throw Object.assign(new Error("Test Ads answered 401"), {
        name: "AccessTokenRejectedError",
      });
    }
    return response.json();
  };
}

describe("signed-key token store", () => {
  it("makes one exchange for concurrent calls and reuses the cached token", async () => {
    const { fake, key, cache } = await setup();
    fake.delayMs = 150;
    const seen: string[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        callWithSignedKey({ key, cache, call: apiCall(fake, seen) }),
      ),
    );
    expect(fake.exchanges).toBe(1);
    expect(new Set(seen)).toEqual(new Set(fake.issued));
    fake.delayMs = 0;
    await callWithSignedKey({ key, cache, call: apiCall(fake, seen) });
    expect(fake.exchanges).toBe(1);
    expect(seen).toHaveLength(6);
  });

  it("replaces a token with less than five minutes left once, under the lock", async () => {
    const { fake, key, cache, binding } = await setup();
    fake.expiresIn = REFRESH_MARGIN_MS / 1000 - 30;
    const first = await cache.get(key);
    expect(first.cached).toBe(false);
    const stale = await tokenRow(binding);
    expect(stale!.accessTokenExpiresAt!.getTime() - Date.now()).toBeLessThan(
      REFRESH_MARGIN_MS,
    );
    fake.expiresIn = 3600;
    fake.delayMs = 150;
    const results = await Promise.all([
      cache.get(key),
      cache.get(key),
      cache.get(key),
    ]);
    expect(fake.exchanges).toBe(2);
    expect(new Set(results.map((result) => result.accessToken))).toEqual(
      new Set([fake.issued[1]]),
    );
    expect(results.filter((result) => !result.cached)).toHaveLength(1);
    const fresh = await tokenRow(binding);
    expect(fresh!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 3500 * 1000,
    );
  });

  it("re-exchanges once after a 401 with a cached token, then gives auth_failed", async () => {
    const { fake, key, cache, binding } = await setup();
    await callWithSignedKey({ key, cache, call: apiCall(fake) });
    expect(fake.exchanges).toBe(1);

    // The provider dropped the cached token early: one re-exchange heals it.
    fake.revoke(fake.issued[0]!);
    const seen: string[] = [];
    await callWithSignedKey({ key, cache, call: apiCall(fake, seen) });
    expect(fake.exchanges).toBe(2);
    expect(seen).toEqual([fake.issued[0], fake.issued[1]]);

    // Every token refused: one re-exchange, then the key's auth failure.
    fake.refuseAll = true;
    const refused: string[] = [];
    const error = await callWithSignedKey({
      key,
      cache,
      call: apiCall(fake, refused),
    }).catch((caught: unknown) => caught);
    expect(refused).toEqual([fake.issued[1], fake.issued[2]]);
    expect(fake.exchanges).toBe(3);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
    expect((error as SignedKeyRejectedError).status).toBe(401);
    expect((error as Error).message).toBe(FIXTURE_UNAUTHORIZED);
    // The last token stays cached: it was freshly exchanged, not refused
    // from the cache.
    expect((await tokenRow(binding))!.accessTokenEncrypted).not.toBeNull();
  });

  it("does not retry a 401 on a token it has just exchanged", async () => {
    const { fake, key, cache } = await setup();
    fake.refuseAll = true;
    const seen: string[] = [];
    const error = await callWithSignedKey({
      key,
      cache,
      call: apiCall(fake, seen),
    }).catch((caught: unknown) => caught);
    expect(seen).toHaveLength(1);
    expect(fake.exchanges).toBe(1);
    expect(error).toBeInstanceOf(SignedKeyRejectedError);
  });

  it("keeps a token another caller exchanged after the rejected one", async () => {
    const { fake, key, cache, binding } = await setup();
    const first = await cache.get(key);
    await cache.invalidate(first.accessToken);
    expect((await tokenRow(binding))!.accessTokenEncrypted).toBeNull();
    const second = await cache.get(key);
    await cache.invalidate(first.accessToken);
    const kept = await cache.get(key);
    expect(kept).toEqual({ accessToken: second.accessToken, cached: true });
    expect(fake.exchanges).toBe(2);
  });

  it("stores no failed exchange, and keeps transient failures retryable", async () => {
    const { fake, key, cache, binding } = await setup();
    fake.nextErrors.push({ status: 503, body: { error: "server_error" } });
    const error = await cache.get(key).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignedKeyExchangeError);
    expect((error as SignedKeyExchangeError).kind).toBe("transient");
    expect((await tokenRow(binding))?.accessTokenEncrypted ?? null).toBeNull();
    expect((await cache.get(key)).cached).toBe(false);
    expect(fake.exchanges).toBe(1);
  });

  it("uses a cached token only with the key it was exchanged for", async () => {
    const { fake, key, cache, client } = await setup();
    await cache.get(key);
    // Another key for the same client ID (not written through
    // updateConnection, which would also clear the row).
    const replaced = { ...client, key: p256KeyPair() };
    fake.clients.push(replaced);
    fake.clients.splice(0, 1);
    const next = await cache.get(parseKey(fake, replaced));
    expect(next.cached).toBe(false);
    expect(fake.exchanges).toBe(2);
  });

  it("seals the token in its own envelope bound to the connection", async () => {
    const { key, cache, binding } = await setup();
    const { accessToken } = await cache.get(key);
    const row = await tokenRow(binding);
    const stored = row!.accessTokenEncrypted!.toString("utf8");
    expect(stored).not.toContain(accessToken);
    expect(Buffer.from(stored, "base64").toString("utf8")).not.toContain(
      accessToken,
    );
    expect(
      JSON.parse(decryptSignedKeyAccessToken(stored, KEYRING, binding)),
    ).toMatchObject({ accessToken });
    // Not openable as another purpose or for another connection.
    expect(() => decryptCredentials(stored, KEYRING, binding)).toThrow();
    expect(() => decryptOAuthAccessToken(stored, KEYRING, binding)).toThrow();
    expect(() =>
      decryptSignedKeyAccessToken(stored, KEYRING, {
        ...binding,
        workspaceId: workspaceB,
      }),
    ).toThrow();
    // The key envelope is untouched by the exchange.
    const [connection] = await withWorkspace(
      db,
      { workspaceId: binding.workspaceId },
      (tx) =>
        tx
          .select({ credentials: schema.connections.credentialsEncrypted })
          .from(schema.connections)
          .where(eq(schema.connections.id, binding.connectionId)),
    );
    expect(
      JSON.parse(
        decryptCredentials(
          connection!.credentials!.toString("utf8"),
          KEYRING,
          binding,
        ),
      ),
    ).not.toHaveProperty("accessToken");
  });

  it("clears the cached token when the key is replaced, not on other changes", async () => {
    const { key, cache, binding, client } = await setup();
    await cache.get(key);
    await withWorkspace(db, { workspaceId: binding.workspaceId }, (tx) =>
      updateConnection(tx, binding.workspaceId, binding.connectionId, {
        name: "renamed",
        config: {},
      }),
    );
    expect((await tokenRow(binding))!.accessTokenEncrypted).not.toBeNull();
    await withWorkspace(db, { workspaceId: binding.workspaceId }, (tx) =>
      updateConnection(tx, binding.workspaceId, binding.connectionId, {
        credentialsEncrypted: Buffer.from(
          encryptCredentials(
            JSON.stringify(
              fixtureCredentials({ ...client, key: p256KeyPair() }),
            ),
            KEYRING,
            binding,
          ),
          "utf8",
        ),
      }),
    );
    expect(await tokenRow(binding)).toBeUndefined();
  });

  it("deletes the cached token with the connection", async () => {
    const { key, cache, binding } = await setup();
    await cache.get(key);
    await withWorkspace(db, { workspaceId: binding.workspaceId }, (tx) =>
      deleteConnection(tx, binding.workspaceId, binding.connectionId),
    );
    const [row] = await adminDb
      .select()
      .from(schema.connectionSignedKeyTokens)
      .where(
        eq(schema.connectionSignedKeyTokens.connectionId, binding.connectionId),
      );
    expect(row).toBeUndefined();
  });

  it("re-encrypts cached tokens on keyring rotation", async () => {
    const { key, cache, binding } = await setup();
    const { accessToken } = await cache.get(key);
    const rotated = createCredentialKeyring(
      randomBytes(32).toString("base64"),
      [KEYRING.key(KEYRING.currentKeyId)!.toString("base64")],
    );
    const result = await reencryptCredentials(adminDb, rotated);
    expect(result.failed).toBe(0);
    const row = await tokenRow(binding);
    expect(
      JSON.parse(
        decryptSignedKeyAccessToken(
          row!.accessTokenEncrypted!.toString("utf8"),
          rotated,
          binding,
        ),
      ),
    ).toMatchObject({ accessToken });
  });

  it("logs no client secret, key material or token", async () => {
    const { fake, key, cache, client } = await setup();
    await callWithSignedKey({ key, cache, call: apiCall(fake) });
    fake.refuseAll = true;
    await callWithSignedKey({ key, cache, call: apiCall(fake) }).catch(
      () => undefined,
    );
    const text = logs.join("\n");
    expect(text).toContain("signed-key access token exchanged");
    for (const secret of [
      ...fake.issued,
      ...fake.clientSecrets,
      pemBody(client.key.privateKeyPem).slice(20, 60),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("signed-key token store across workspaces", () => {
  it("never reads, locks, writes or clears another workspace's cached token", async () => {
    const a = await setup(workspaceA);
    const { accessToken } = await a.cache.get(a.key);

    // Workspace B names A's connection: nothing to lock, nothing created.
    const intruder = store.forConnection({
      workspaceId: workspaceB,
      connectionId: a.binding.connectionId,
    });
    const error = await intruder.get(a.key).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignedKeyExchangeError);
    expect((error as SignedKeyExchangeError).kind).toBe("configuration");
    expect((error as Error).message).not.toContain(accessToken);
    await intruder.invalidate(accessToken);
    await store.clear({
      workspaceId: workspaceB,
      connectionId: a.binding.connectionId,
    });
    expect(a.fake.exchanges).toBe(1);
    expect((await tokenRow(a.binding))!.accessTokenEncrypted).not.toBeNull();
    expect(await a.cache.get(a.key)).toEqual({ accessToken, cached: true });

    // RLS: B's context sees no row of A, and cannot write one for A.
    expect(
      (await tokenRows(workspaceB)).some(
        (row) => row.connectionId === a.binding.connectionId,
      ),
    ).toBe(false);
    await expect(
      withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
        tx.insert(schema.connectionSignedKeyTokens).values({
          workspaceId: workspaceA,
          connectionId: a.binding.connectionId,
        }),
      ),
    ).rejects.toThrow();
    const updated = await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
      tx
        .update(schema.connectionSignedKeyTokens)
        .set({ accessTokenEncrypted: null, accessTokenExpiresAt: null })
        .where(
          eq(
            schema.connectionSignedKeyTokens.connectionId,
            a.binding.connectionId,
          ),
        )
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
      tx
        .delete(schema.connectionSignedKeyTokens)
        .where(
          eq(
            schema.connectionSignedKeyTokens.connectionId,
            a.binding.connectionId,
          ),
        )
        .returning(),
    );
    expect(deleted).toHaveLength(0);

    // A's envelope copied into a B connection's row does not open there.
    const b = await setup(workspaceB);
    const rowA = await tokenRow(a.binding);
    await withWorkspace(db, { workspaceId: workspaceB }, (tx) =>
      tx.insert(schema.connectionSignedKeyTokens).values({
        workspaceId: workspaceB,
        connectionId: b.binding.connectionId,
        accessTokenEncrypted: rowA!.accessTokenEncrypted,
        accessTokenExpiresAt: rowA!.accessTokenExpiresAt,
      }),
    );
    const own = await b.cache.get(b.key);
    expect(own.cached).toBe(false);
    expect(own.accessToken).not.toBe(accessToken);
  });
});
