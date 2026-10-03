import { parseArgs } from "node:util";

import {
  createDatabase,
  createServiceToken,
  listPrincipalTokens,
  revokePrincipalToken,
} from "@netrics/database";
import { INSTALLATION_SCOPES, isInstallationScope } from "@netrics/domain";

import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { ConfigError, loadKeyringConfig, loadMigrationConfig } from "./env.js";
import { requestOperatorBackfill } from "./operator-backfill.js";
import { reencryptCredentials } from "./reencrypt.js";
import { generatePrincipalToken, hashToken } from "./tokens.js";

/**
 * Operator CLI for installation-level principals (ADR 0009). Runs with the
 * owner connection (DATABASE_MIGRATION_URL), like `migrate`:
 *
 *   node dist/admin-cli.js create-service-token --name ops-console \
 *     --scope installation:workspaces:read [--expires-days 90]
 *   node dist/admin-cli.js list-tokens
 *   node dist/admin-cli.js revoke-token --id <uuid>
 *   node dist/admin-cli.js reencrypt-credentials   # after a key rotation
 *   node dist/admin-cli.js backfill-connection --workspace <uuid> --connection <uuid>
 *
 * A created token is printed once and cannot be shown again.
 */
const USAGE = `usage:
  admin-cli create-service-token --name <name> --scope <scope> [--scope …] [--expires-days <n>]
  admin-cli list-tokens
  admin-cli revoke-token --id <token id>
  admin-cli reencrypt-credentials   (needs APP_ENCRYPTION_KEY[, _KEYS_PREVIOUS])
  admin-cli backfill-connection --workspace <id> --connection <id>
    (reads the connection's whole history again, e.g. after a connector fix)

scopes: ${INSTALLATION_SCOPES.join(", ")}`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let config;
try {
  config = loadMigrationConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" },
    scope: { type: "string", multiple: true },
    "expires-days": { type: "string" },
    id: { type: "string" },
    workspace: { type: "string" },
    connection: { type: "string" },
  },
  strict: true,
});

const db = createDatabase(config.databaseMigrationUrl, { max: 1 });
try {
  if (command === "create-service-token") {
    const name = values.name?.trim();
    if (!name) {
      fail("--name is required");
    }
    const scopes = values.scope ?? [];
    if (scopes.length === 0) {
      fail("at least one --scope is required");
    }
    const unknown = scopes.filter((scope) => !isInstallationScope(scope));
    if (unknown.length > 0) {
      fail(`unknown scope(s): ${unknown.join(", ")}`);
    }
    const days = values["expires-days"];
    let expiresAt: Date | null = null;
    if (days !== undefined) {
      const count = Number(days);
      if (!Number.isInteger(count) || count < 1) {
        fail("--expires-days must be a positive integer");
      }
      expiresAt = new Date(Date.now() + count * 24 * 60 * 60 * 1000);
    }
    const token = generatePrincipalToken();
    const { id } = await createServiceToken(db, {
      name,
      tokenHash: hashToken(token),
      scopes,
      expiresAt,
    });
    console.log(`created service token ${id} (${name})`);
    console.log(`scopes: ${scopes.join(", ")}`);
    console.log(`expires: ${expiresAt ? expiresAt.toISOString() : "never"}`);
    console.log("");
    console.log("Token (shown once; store it in your secret manager):");
    console.log(token);
  } else if (command === "list-tokens") {
    const tokens = await listPrincipalTokens(db);
    for (const token of tokens) {
      const state = token.revokedAt
        ? "revoked"
        : token.expiresAt && token.expiresAt < new Date()
          ? "expired"
          : "active";
      console.log(
        [
          token.id,
          token.kind,
          state,
          token.name,
          token.scopes.join(","),
          `last used ${token.lastUsedAt?.toISOString() ?? "never"}`,
        ].join("  "),
      );
    }
    if (tokens.length === 0) {
      console.log("no tokens");
    }
  } else if (command === "revoke-token") {
    if (!values.id) {
      fail("--id is required");
    }
    const revoked = await revokePrincipalToken(db, values.id);
    console.log(
      revoked ? `revoked ${values.id}` : `no active token ${values.id}`,
    );
    if (!revoked) {
      process.exitCode = 1;
    }
  } else if (command === "reencrypt-credentials") {
    const keys = loadKeyringConfig();
    const keyring = createCredentialKeyring(
      keys.appEncryptionKey,
      keys.appEncryptionKeysPrevious,
    );
    const result = await reencryptCredentials(db, keyring);
    console.log(
      `credentials: ${result.total} total, ${result.alreadyCurrent} already on key ${keyring.currentKeyId}, ` +
        `${result.reencrypted} re-encrypted, ${result.failed} failed`,
    );
    if (result.failed > 0) {
      console.error(
        "Some envelopes could not be decrypted: keep their key in APP_ENCRYPTION_KEYS_PREVIOUS.",
      );
      process.exitCode = 1;
    } else if (keys.appEncryptionKeysPrevious.length > 0) {
      console.log(
        "All credentials use the current key; APP_ENCRYPTION_KEYS_PREVIOUS can be removed.",
      );
    }
  } else if (command === "backfill-connection") {
    if (!values.workspace || !values.connection) {
      fail("--workspace and --connection are required");
    }
    const result = await requestOperatorBackfill(db, createDefaultRegistry(), {
      workspaceId: values.workspace,
      connectionId: values.connection,
    });
    if (result.ok) {
      console.log(
        `queued backfill ${result.jobId} for ${result.connectorId} connection ${values.connection}`,
      );
    } else {
      console.error(`not queued: ${result.reason}`);
      process.exitCode = 1;
    }
  } else {
    fail(command ? `unknown command: ${command}` : "missing command");
  }
} finally {
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
}
