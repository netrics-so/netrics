/**
 * An OAuth provider definition (ADR 0012): trusted host code that knows a
 * provider's endpoints and conventions. Connectors only name a provider and
 * the scopes they need; endpoints and client secrets never live in
 * connector code. The client id and secret are instance configuration
 * (NETRICS_OAUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET).
 */
export interface OAuthProviderDefinition {
  /** Stable id, used in manifests, env names and the redirect URI. */
  readonly id: string;
  /** Display name ("Reconnect Google"). */
  readonly name: string;
  /** Where the browser is sent to authorize. */
  readonly authorizationEndpoint: string;
  /** Code exchange and refresh (called by the server). */
  readonly tokenEndpoint: string;
  /** Token revocation (called by the server); null when unsupported. */
  readonly revocationEndpoint: string | null;
  /** PKCE method; S256 only. */
  readonly pkce: "S256";
  /**
   * OpenID Connect: the ID token from the token endpoint names the linked
   * account. `issuers` are the accepted `iss` values.
   */
  readonly openIdConnect: {
    readonly issuers: readonly string[];
  };
  /** Scopes asked for besides the connector's, to identify the account. */
  readonly identityScopes: readonly string[];
  /** Extra authorization request parameters. */
  readonly authorizationParams: Readonly<Record<string, string>>;
  /**
   * Hosts the server may reach for this provider (token and revocation
   * endpoints): the egress allowlist of host-side token calls. The browser,
   * not the server, visits the authorization endpoint.
   */
  readonly serverDomains: readonly string[];
  /** Where users review the access they granted (when revocation fails). */
  readonly accountPermissionsUrl: string;
}
