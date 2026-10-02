import type {
  ConnectorUnavailable,
  ConnectorUnavailableReason,
} from "@netrics/contracts";
import type { ConnectorManifest } from "@netrics/connector-sdk";

import type { Config } from "../env.js";
import type { Secret } from "../secret.js";
import {
  OAUTH_PROVIDER_DEFINITIONS,
  type OAuthProviderDefinition,
} from "./providers/index.js";

/** A provider this instance has an OAuth app for (ADR 0012). */
export interface ConfiguredOAuthProvider {
  definition: OAuthProviderDefinition;
  clientId: string;
  clientSecret: Secret;
  /** Derived from WEB_ORIGIN, never taken from a request. */
  redirectUri: string;
}

/**
 * The redirect URI registered at the provider: the web app's callback route
 * `<WEB_ORIGIN>/oauth/<provider>/callback`.
 */
export function oauthRedirectUri(
  webOrigin: string,
  providerId: string,
): string {
  return new URL(
    `/oauth/${encodeURIComponent(providerId)}/callback`,
    new URL(webOrigin).origin,
  ).toString();
}

export type ConnectorAvailability =
  | { available: true; unavailable: null }
  | { available: false; unavailable: ConnectorUnavailable };

/** The OAuth providers of this instance: definitions plus configuration. */
export class OAuthProviders {
  readonly #configured: ReadonlyMap<string, ConfiguredOAuthProvider>;
  readonly #definitions: ReadonlyMap<string, OAuthProviderDefinition>;

  constructor(
    configured: readonly ConfiguredOAuthProvider[],
    definitions: ReadonlyMap<
      string,
      OAuthProviderDefinition
    > = OAUTH_PROVIDER_DEFINITIONS,
  ) {
    this.#definitions = definitions;
    this.#configured = new Map(
      configured.map((provider) => [provider.definition.id, provider]),
    );
  }

  /** The configured provider, or undefined when it cannot be used. */
  get(providerId: string): ConfiguredOAuthProvider | undefined {
    return this.#configured.get(providerId);
  }

  list(): ConfiguredOAuthProvider[] {
    return [...this.#configured.values()];
  }

  /** Why a provider cannot be used here, or null when it can. */
  unavailableReason(providerId: string): ConnectorUnavailableReason | null {
    if (this.#configured.has(providerId)) {
      return null;
    }
    return this.#definitions.has(providerId)
      ? "oauth_provider_not_configured"
      : "oauth_provider_unsupported";
  }

  /**
   * A connector is available when at least one of its auth strategies can
   * be used: token and none always, oauth2 when its provider is configured.
   * Otherwise the first oauth2 strategy says why.
   */
  connectorAvailability(manifest: ConnectorManifest): ConnectorAvailability {
    let unavailable: ConnectorUnavailable | null = null;
    for (const strategy of manifest.authStrategies) {
      if (strategy.strategy !== "oauth2") {
        return { available: true, unavailable: null };
      }
      const reason = this.unavailableReason(strategy.provider);
      if (reason === null) {
        return { available: true, unavailable: null };
      }
      unavailable ??= { reason, provider: strategy.provider };
    }
    // The manifest schema requires at least one strategy.
    return { available: false, unavailable: unavailable! };
  }
}

/** Builds the instance's providers from the environment configuration. */
export function createOAuthProviders(
  config: Pick<Config, "webOrigin" | "oauthClients">,
  definitions: ReadonlyMap<
    string,
    OAuthProviderDefinition
  > = OAUTH_PROVIDER_DEFINITIONS,
): OAuthProviders {
  const configured: ConfiguredOAuthProvider[] = [];
  for (const [providerId, client] of Object.entries(config.oauthClients)) {
    const definition = definitions.get(providerId);
    if (!client || !definition) {
      continue;
    }
    configured.push({
      definition,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: oauthRedirectUri(config.webOrigin, providerId),
    });
  }
  return new OAuthProviders(configured, definitions);
}

/**
 * What the API logs at startup: which providers are configured and the
 * redirect URI to register for each. Never the client secret.
 */
export function describeOAuthProviders(providers: OAuthProviders): {
  oauthProviders: Array<{ provider: string; redirectUri: string }>;
} {
  return {
    oauthProviders: providers.list().map((provider) => ({
      provider: provider.definition.id,
      redirectUri: provider.redirectUri,
    })),
  };
}
