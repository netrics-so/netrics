import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createWorkspace,
  schema,
  withWorkspace,
  type Database,
} from "@netrics/database";

import {
  createCredentialKeyring,
  decryptCredentials,
  decryptOAuthAccessToken,
  encryptCredentials,
  encryptOAuthAccessToken,
} from "./credentials.js";
import { reencryptCredentials } from "./reencrypt.js";
import { createTestDatabase } from "./test-db.js";

const oldKey = randomBytes(32).toString("base64");
const newKey = randomBytes(32).toString("base64");

let appDb: Database;
let ownerDb: Database;
let workspaceId: string;
const connectionIds: string[] = [];

beforeAll(async () => {
  const testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "rotate@example.com", displayName: "Rotate" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Rotation",
    ownerUserId: user!.id,
  });
  const oldRing = createCredentialKeyring(oldKey);
  for (let index = 0; index < 2; index += 1) {
    const connectionId = randomUUID();
    connectionIds.push(connectionId);
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx.insert(schema.connections).values({
        id: connectionId,
        workspaceId,
        connectorId: "demo",
        name: `c${index}`,
        credentialsEncrypted: Buffer.from(
          encryptCredentials(`{"token":"t${index}"}`, oldRing, {
            workspaceId,
            connectionId,
          }),
          "utf8",
        ),
      }),
    );
  }
}, 60_000);

afterAll(async () => {
  await appDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await ownerDb.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("reencryptCredentials", () => {
  it("fails envelopes whose key is missing from the keyring", async () => {
    const result = await reencryptCredentials(
      ownerDb,
      createCredentialKeyring(newKey),
    );
    expect(result).toEqual({
      total: 2,
      alreadyCurrent: 0,
      reencrypted: 0,
      failed: 2,
    });
  });

  it("moves every envelope to the current key, then is a no-op", async () => {
    const rotating = createCredentialKeyring(newKey, [oldKey]);
    expect(await reencryptCredentials(ownerDb, rotating)).toEqual({
      total: 2,
      alreadyCurrent: 0,
      reencrypted: 2,
      failed: 0,
    });
    expect(await reencryptCredentials(ownerDb, rotating)).toEqual({
      total: 2,
      alreadyCurrent: 2,
      reencrypted: 0,
      failed: 0,
    });

    // The old key can now be retired: the new key alone decrypts everything.
    const newOnly = createCredentialKeyring(newKey);
    for (const [index, connectionId] of connectionIds.entries()) {
      const [row] = await ownerDb
        .select({ credentials: schema.connections.credentialsEncrypted })
        .from(schema.connections)
        .where(eq(schema.connections.id, connectionId));
      expect(
        decryptCredentials(row!.credentials!.toString("utf8"), newOnly, {
          workspaceId,
          connectionId,
        }),
      ).toBe(`{"token":"t${index}"}`);
    }
  });
});

describe("reencryptCredentials with OAuth access tokens (ADR 0012)", () => {
  it("rotates the access-token envelope as an access token", async () => {
    const thirdKey = randomBytes(32).toString("base64");
    const connectionId = connectionIds[0]!;
    const current = createCredentialKeyring(newKey);
    await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx.insert(schema.connectionOAuth).values({
        connectionId,
        workspaceId,
        provider: "google",
        accountSub: "sub",
        grantedScopes: ["openid"],
        accessTokenEncrypted: Buffer.from(
          encryptOAuthAccessToken("ya29.token", current, {
            workspaceId,
            connectionId,
          }),
          "utf8",
        ),
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
      }),
    );

    const rotating = createCredentialKeyring(thirdKey, [newKey]);
    expect(await reencryptCredentials(ownerDb, rotating)).toEqual({
      total: 3,
      alreadyCurrent: 0,
      reencrypted: 3,
      failed: 0,
    });
    const [row] = await ownerDb
      .select({ token: schema.connectionOAuth.accessTokenEncrypted })
      .from(schema.connectionOAuth)
      .where(eq(schema.connectionOAuth.connectionId, connectionId));
    expect(
      decryptOAuthAccessToken(
        row!.token!.toString("utf8"),
        createCredentialKeyring(thirdKey),
        { workspaceId, connectionId },
      ),
    ).toBe("ya29.token");
  });
});
