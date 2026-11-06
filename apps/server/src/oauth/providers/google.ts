import type { OAuthProviderDefinition } from "./types.js";

/**
 * Google (ADR 0012). `access_type=offline` with `prompt=consent` makes every
 * grant return a refresh token; `include_granted_scopes=true` lets a
 * reauthorization ask for the union of scopes.
 */
export const googleProvider: OAuthProviderDefinition = {
  id: "google",
  name: "Google",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  pkce: "S256",
  openIdConnect: {
    // Google documents both forms of its issuer.
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
  identityScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
  authorizationParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
  serverDomains: ["oauth2.googleapis.com"],
  accountPermissionsUrl: "https://myaccount.google.com/permissions",
};
