import { googleProvider } from "./google.js";
import type { OAuthProviderDefinition } from "./types.js";

export type { OAuthProviderDefinition } from "./types.js";
export { googleProvider } from "./google.js";

/** Every provider this server knows, by id. */
export const OAUTH_PROVIDER_DEFINITIONS: ReadonlyMap<
  string,
  OAuthProviderDefinition
> = new Map([[googleProvider.id, googleProvider]]);
