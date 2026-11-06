import type { ExecuteOptions } from "@netrics/connector-runtime";
import type { AccessTokenCredentials } from "@netrics/connector-sdk";

import { ACCESS_TOKEN_REJECTED_ERROR } from "../oauth/connector-auth.js";
import {
  SignedKeyExchangeError,
  type SignedKey,
  type SignedKeyTokenCache,
} from "./registry.js";

// How the host hands a signed token to a signed-key connector (ADR 0014).
// Every connector call (check, discover, each sync page) gets a freshly
// signed token, never cached and never in a job payload. A token is minted
// from the key, so there is nothing to refresh: when the provider refuses a
// fresh token (401) or the key's access (403) during a call that then
// fails, the key itself is the problem and the user must upload a new one.
//
// Providers with a token exchange (ADR 0020 §2) hand the connector an
// access token exchanged for a signed client secret, cached per connection.
// A 401 with a cached token drops it and runs the call once more with a
// fresh exchange; a second 401 is the key's problem as above. An exchange
// answered with invalid_client is a refused key too.

/**
 * The provider refused a freshly signed token (401: revoked or invalid
 * key) or the key's access (403: role lowered, access removed). The
 * message is the provider's actionable text; it carries no key material.
 */
export class SignedKeyRejectedError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "SignedKeyRejectedError";
    this.status = status;
  }
}

export interface SignedKeyConnectorCallInput<T> {
  key: SignedKey;
  /**
   * The connection's token cache, for providers with a token exchange.
   * Without it (candidate keys: probes, preview) every call exchanges and
   * nothing is stored. Providers without an exchange ignore it.
   */
  cache?: SignedKeyTokenCache;
  /** Options for the execute* call (onResponse is chained). */
  options?: ExecuteOptions;
  call: (
    credentials: AccessTokenCredentials,
    options: ExecuteOptions,
  ) => Promise<T>;
  /**
   * Whether a returned value is a refusal (e.g. a check returning ok:
   * false); with a 401 or 403 during the call it becomes the provider's
   * auth failure. Thrown errors always are.
   */
  rejected?: (value: T) => boolean;
}

/**
 * The token of one call: a freshly signed one, or for a token exchange the
 * cached or exchanged one. An exchange refused with invalid_client is a
 * SignedKeyRejectedError (auth_failed); other exchange failures stay
 * SignedKeyExchangeError (transient: retryable).
 */
async function acquire(key: SignedKey, cache: SignedKeyTokenCache | undefined) {
  try {
    return await key.acquireTokens(cache);
  } catch (error) {
    if (error instanceof SignedKeyExchangeError && error.kind === "rejected") {
      throw new SignedKeyRejectedError(401, error.message);
    }
    throw error;
  }
}

/**
 * Runs one connector call with a freshly signed (or, for a token exchange,
 * a cached or freshly exchanged) token. Throws SignedKeyRejectedError when
 * the call failed after the provider answered 401 or 403 (or the connector
 * threw AccessTokenRejectedError). The only retry is after a 401 with a
 * cached exchanged token, once, with a fresh exchange; another token freshly
 * signed or exchanged from the same key fares no better.
 */
export async function callWithSignedKey<T>(
  input: SignedKeyConnectorCallInput<T>,
): Promise<T> {
  const { key, cache } = input;
  const rejection = (status: 401 | 403) =>
    new SignedKeyRejectedError(
      status,
      status === 401
        ? key.provider.authFailure.unauthorized
        : key.provider.authFailure.forbidden,
    );
  for (let attempt = 0; ; attempt += 1) {
    let refused: 401 | 403 | null = null;
    const options: ExecuteOptions = {
      ...input.options,
      onResponse: (status) => {
        if (status === 401 || (status === 403 && refused === null)) {
          refused = status;
        }
        input.options?.onResponse?.(status);
      },
    };
    // The main key's token, and one per additional key (#190) in its own
    // credential field. A refusal of an additional key's token is the
    // connector's to handle (it pauses what that key reads); only a
    // failed call is mapped to the main key's auth failure.
    const acquired = await acquire(key, cache);
    const retry = attempt === 0 && acquired.cached && cache !== undefined;
    const unauthorized = async (): Promise<boolean> => {
      if (!retry) {
        return false;
      }
      await cache.invalidate(acquired.credentials.accessToken);
      return true;
    };
    let value: T;
    try {
      value = await input.call(acquired.credentials, options);
    } catch (error) {
      const tokenRejected =
        error instanceof Error && error.name === ACCESS_TOKEN_REJECTED_ERROR;
      if ((tokenRejected || refused === 401) && (await unauthorized())) {
        continue;
      }
      if (tokenRejected) {
        throw rejection(401);
      }
      if (refused !== null) {
        throw rejection(refused);
      }
      throw error;
    }
    if (refused !== null && input.rejected?.(value)) {
      if (refused === 401 && (await unauthorized())) {
        continue;
      }
      throw rejection(refused);
    }
    return value;
  }
}
