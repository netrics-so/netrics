import {
  deleteSignedKeyToken,
  findSignedKeyToken,
  lockSignedKeyToken,
  storeSignedKeyToken,
  withWorkspace,
  type ConnectionSignedKeyTokenRow,
  type Database,
} from "@netrics/database";
import type { Logger } from "pino";

import {
  decryptSignedKeyAccessToken,
  encryptSignedKeyAccessToken,
  type CredentialBinding,
  type CredentialKeyring,
} from "../credentials.js";
import { REFRESH_MARGIN_MS } from "../oauth/tokens.js";
import {
  SignedKeyExchangeError,
  type SignedKey,
  type SignedKeyTokenCache,
} from "./registry.js";

// The cached access tokens of signed-key connections with a token exchange
// (ADR 0020 §2, #369), following the OAuth token lifecycle of ADR 0012:
//
// - A cached token valid for at least REFRESH_MARGIN_MS (5 minutes) more is
//   used as is.
// - Otherwise the connection's token row is locked (SELECT ... FOR UPDATE),
//   read again, and exchanged only if it is still stale; the new token is
//   stored and committed. Concurrent callers wait on the lock and then find
//   the fresh token, so the provider sees one exchange. The exchange has a
//   short timeout, so the lock is never held for long.
// - The token lives in connection_signed_key_tokens, in its own envelope
//   (purpose signed-key-access-token, bound to the connection), so an
//   exchange never rewrites the key envelope. The envelope also names the
//   key's fingerprint: a token is only used with the key it came from.
// - New credentials (updateConnection) and connection deletion (cascade)
//   drop the row.
//
// Nothing here logs or throws token material.

/** What the envelope holds. */
interface SealedToken {
  accessToken: string;
  /** SignedKey.fingerprint of the key the token was exchanged for. */
  key: string;
}

export interface SignedKeyTokenStoreDeps {
  db: Database;
  credentialKeyring: CredentialKeyring;
  logger?: Logger;
  now?: () => Date;
}

export function createSignedKeyTokenStore(deps: SignedKeyTokenStoreDeps) {
  const { db, credentialKeyring: keyring } = deps;
  const now = deps.now ?? (() => new Date());

  /** The stored token, whatever its expiry; null when unreadable or absent. */
  function open(
    row: ConnectionSignedKeyTokenRow | null,
    binding: CredentialBinding,
  ): SealedToken | null {
    if (!row?.accessTokenEncrypted) {
      return null;
    }
    try {
      const sealed = JSON.parse(
        decryptSignedKeyAccessToken(
          row.accessTokenEncrypted.toString("utf8"),
          keyring,
          binding,
        ),
      ) as Partial<SealedToken>;
      return typeof sealed.accessToken === "string" &&
        typeof sealed.key === "string"
        ? { accessToken: sealed.accessToken, key: sealed.key }
        : null;
    } catch {
      // A cache entry that cannot be opened (e.g. its keyring key is gone)
      // is a miss; the next exchange overwrites it.
      return null;
    }
  }

  /** The cached token for this key when valid for long enough, else null. */
  function usable(
    row: ConnectionSignedKeyTokenRow | null,
    binding: CredentialBinding,
    key: SignedKey,
  ): string | null {
    if (
      !row?.accessTokenExpiresAt ||
      row.accessTokenExpiresAt.getTime() - now().getTime() < REFRESH_MARGIN_MS
    ) {
      return null;
    }
    const sealed = open(row, binding);
    return sealed && sealed.key === key.fingerprint ? sealed.accessToken : null;
  }

  function forConnection(binding: CredentialBinding): SignedKeyTokenCache {
    const { workspaceId, connectionId } = binding;
    return {
      async get(key) {
        const fast = await withWorkspace(db, { workspaceId }, async (tx) =>
          usable(
            await findSignedKeyToken(tx, workspaceId, connectionId),
            binding,
            key,
          ),
        );
        if (fast) {
          return { accessToken: fast, cached: true };
        }
        return withWorkspace(db, { workspaceId }, async (tx) => {
          const locked = await lockSignedKeyToken(
            tx,
            workspaceId,
            connectionId,
          );
          if (!locked) {
            throw new SignedKeyExchangeError(
              "configuration",
              "signed-key connection not found",
            );
          }
          // Another caller may have exchanged while this one waited.
          const token = usable(locked, binding, key);
          if (token) {
            return { accessToken: token, cached: true };
          }
          const exchanged = await key.exchangeAccessToken();
          const sealed: SealedToken = {
            accessToken: exchanged.accessToken,
            key: key.fingerprint,
          };
          await storeSignedKeyToken(tx, workspaceId, connectionId, {
            accessTokenEncrypted: Buffer.from(
              encryptSignedKeyAccessToken(
                JSON.stringify(sealed),
                keyring,
                binding,
              ),
              "utf8",
            ),
            accessTokenExpiresAt: new Date(
              now().getTime() + exchanged.expiresInSeconds * 1000,
            ),
          });
          deps.logger?.info(
            { connectionId, provider: key.provider.id },
            "signed-key access token exchanged",
          );
          return { accessToken: exchanged.accessToken, cached: false };
        });
      },

      async invalidate(rejectedAccessToken) {
        await withWorkspace(db, { workspaceId }, async (tx) => {
          const locked = await lockSignedKeyToken(
            tx,
            workspaceId,
            connectionId,
          );
          if (!locked?.accessTokenEncrypted) {
            return;
          }
          const stored = open(locked, binding);
          // A token another caller exchanged meanwhile stays.
          if (!stored || stored.accessToken === rejectedAccessToken) {
            await storeSignedKeyToken(tx, workspaceId, connectionId, null);
          }
        });
      },
    };
  }

  return {
    /** The token cache of one connection, for callWithSignedKey. */
    forConnection,

    /** Drops a connection's cached token (e.g. after its key changed). */
    async clear(binding: CredentialBinding): Promise<void> {
      await withWorkspace(db, { workspaceId: binding.workspaceId }, (tx) =>
        deleteSignedKeyToken(tx, binding.workspaceId, binding.connectionId),
      );
    },
  };
}

export type SignedKeyTokenStore = ReturnType<typeof createSignedKeyTokenStore>;
