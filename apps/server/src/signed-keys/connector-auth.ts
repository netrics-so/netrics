import type { ExecuteOptions } from "@netrics/connector-runtime";
import type { AccessTokenCredentials } from "@netrics/connector-sdk";

import { ACCESS_TOKEN_REJECTED_ERROR } from "../oauth/connector-auth.js";
import type { SignedKey } from "./registry.js";

// How the host hands a signed token to a signed-key connector (ADR 0014).
// Every connector call (check, discover, each sync page) gets a freshly
// signed token, never cached and never in a job payload. A token is minted
// from the key, so there is nothing to refresh: when the provider refuses a
// fresh token (401) or the key's access (403) during a call that then
// fails, the key itself is the problem and the user must upload a new one.

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
 * Runs one connector call with a freshly signed token. Throws
 * SignedKeyRejectedError when the call failed after the provider answered
 * 401 or 403 (or the connector threw AccessTokenRejectedError); no retry,
 * since another token from the same key fares no better.
 */
export async function callWithSignedKey<T>(
  input: SignedKeyConnectorCallInput<T>,
): Promise<T> {
  const { key } = input;
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
  const rejection = (status: 401 | 403) =>
    new SignedKeyRejectedError(
      status,
      status === 401
        ? key.provider.authFailure.unauthorized
        : key.provider.authFailure.forbidden,
    );
  let value: T;
  try {
    value = await input.call({ accessToken: key.mintToken() }, options);
  } catch (error) {
    if (error instanceof Error && error.name === ACCESS_TOKEN_REJECTED_ERROR) {
      throw rejection(401);
    }
    if (refused !== null) {
      throw rejection(refused);
    }
    throw error;
  }
  if (refused !== null && input.rejected?.(value)) {
    throw rejection(refused);
  }
  return value;
}
