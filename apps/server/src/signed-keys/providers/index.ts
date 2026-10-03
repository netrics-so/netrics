import { appStoreConnectProvider } from "./app-store-connect.js";
import type { SignedKeyProviderDefinition } from "./types.js";

export type {
  SignedKeyField,
  SignedKeyFieldValues,
  SignedKeyProbe,
  SignedKeyProbeContext,
  SignedKeyProbeResult,
  SignedKeyProviderDefinition,
} from "./types.js";
export { appStoreConnectProvider } from "./app-store-connect.js";

/** Every signed-key provider this server knows, by id (ADR 0014). */
export const SIGNED_KEY_PROVIDER_DEFINITIONS: ReadonlyMap<
  string,
  SignedKeyProviderDefinition
> = new Map([[appStoreConnectProvider.id, appStoreConnectProvider]]);
