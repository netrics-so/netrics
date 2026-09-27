/**
 * Scopes a service-account token can hold (ADR 0009). Installation scopes
 * reach across workspaces through the admin API only; workspace data stays
 * behind memberships and roles.
 */
export const INSTALLATION_SCOPES = ["installation:workspaces:read"] as const;
export type InstallationScope = (typeof INSTALLATION_SCOPES)[number];

export function isInstallationScope(value: string): value is InstallationScope {
  return (INSTALLATION_SCOPES as readonly string[]).includes(value);
}
