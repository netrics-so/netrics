import type { ExecuteOptions } from "@netrics/connector-runtime";
import type {
  ConnectorManifest,
  OAuth2AuthStrategy,
} from "@netrics/connector-sdk";
import type { OAuthAuthReason } from "@netrics/database";

import type { CredentialBinding } from "../credentials.js";
import { OAuthTokenError, type OAuthTokenService } from "./tokens.js";

// How the host hands an access token to an oauth2 connector (ADR 0012).
// Connector code receives `credentials: { accessToken }` and nothing else.
// Every connector call (check, discover, each sync page) asks the token
// service for a token; when the provider API answered 401 during a call
// that then failed, the cached token is dropped and the call runs once more
// with a refreshed token. A connector can also signal a refused token by
// throwing an error named AccessTokenRejectedError.

/** The credentials an oauth2 connector receives. */
export interface OAuthConnectorCredentials {
  accessToken: string;
}

/** The connection's grant needs the user to authorize again. */
export class NeedsReauthorizationError extends Error {
  readonly reason: OAuthAuthReason;

  constructor(reason: OAuthAuthReason) {
    super(`oauth authorization needs to be renewed (${reason})`);
    this.name = "NeedsReauthorizationError";
    this.reason = reason;
  }
}

/**
 * Connectors signal a refused access token by throwing an error named
 * "AccessTokenRejectedError" (the name survives the runtime's error
 * redaction), e.g. when a provider API answers 401. The host also notices a
 * 401 on runtime.fetch by itself; either one triggers the refresh-and-retry.
 */
export const ACCESS_TOKEN_REJECTED_ERROR = "AccessTokenRejectedError";

function isAccessTokenRejected(error: unknown): boolean {
  return error instanceof Error && error.name === ACCESS_TOKEN_REJECTED_ERROR;
}

/** The manifest's oauth2 strategy for a provider, if it has one. */
export function oauthStrategyFor(
  manifest: ConnectorManifest,
  providerId: string,
): OAuth2AuthStrategy | undefined {
  return manifest.authStrategies.find(
    (strategy): strategy is OAuth2AuthStrategy =>
      strategy.strategy === "oauth2" && strategy.provider === providerId,
  );
}

export interface OAuthConnectorCallInput<T> {
  tokens: OAuthTokenService | undefined;
  binding: CredentialBinding;
  /** The connector's scopes for the connection's provider. */
  requiredScopes: readonly string[];
  /** Options for the execute* call (onResponse is chained). */
  options?: ExecuteOptions;
  call: (
    credentials: OAuthConnectorCredentials,
    options: ExecuteOptions,
  ) => Promise<T>;
  /**
   * Whether a returned value is a refusal worth one retry after a 401
   * (e.g. a check returning ok: false). Thrown errors always are.
   */
  rejected?: (value: T) => boolean;
}

/**
 * Runs one connector call with a valid access token. Throws
 * NeedsReauthorizationError when the grant needs user action (the token
 * service has already moved the connection to needs_reauthorization), and
 * OAuthTokenError for transient or configuration failures of the refresh.
 */
export async function callWithAccessToken<T>(
  input: OAuthConnectorCallInput<T>,
): Promise<T> {
  const { tokens, binding } = input;
  if (!tokens) {
    throw new OAuthTokenError(
      "configuration",
      "oauth token service is not available in this process",
    );
  }
  for (let attempt = 0; ; attempt += 1) {
    const token = await tokens.getAccessToken(binding, {
      requiredScopes: input.requiredScopes,
    });
    if (!token.ok) {
      throw new NeedsReauthorizationError(token.reason);
    }
    let unauthorized = false;
    const options: ExecuteOptions = {
      ...input.options,
      onResponse: (status) => {
        if (status === 401) {
          unauthorized = true;
        }
        input.options?.onResponse?.(status);
      },
    };
    const retry = attempt === 0;
    let value: T;
    try {
      value = await input.call({ accessToken: token.accessToken }, options);
    } catch (error) {
      if ((unauthorized || isAccessTokenRejected(error)) && retry) {
        await tokens.invalidateAccessToken(binding, token.accessToken);
        continue;
      }
      throw error;
    }
    if (unauthorized && retry && input.rejected?.(value)) {
      await tokens.invalidateAccessToken(binding, token.accessToken);
      continue;
    }
    return value;
  }
}
