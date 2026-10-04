import { connectorManifestSchema, type ConnectorManifest } from "./manifest.js";
import { satisfiesRange } from "./semver.js";

// 0.2.1: the additive "oauth2" auth strategy (ADR 0012).
// 0.2.2: the additive "signed-key" auth strategy and
// ConnectorResponse.bytes() for binary bodies (ADR 0014).
// 0.2.3: the "currency_minor" unit, whose metrics declare a "currency"
// dimension (ADR 0014).
// 0.2.4: the optional manifest field resourceNoun (#208).
// 0.2.5: the optional Connector.resourceIcons capability (#226).
// All are additive: ^0.2.0 connectors keep loading.
export const SDK_VERSION = "0.2.5";

/**
 * Validates a manifest against the contract schema and verifies that its
 * declared sdkVersion range accepts the SDK version of this runtime.
 */
export function assertManifestCompatible(manifest: unknown): ConnectorManifest {
  const parsed = connectorManifestSchema.parse(manifest);
  if (!satisfiesRange(SDK_VERSION, parsed.sdkVersion)) {
    throw new Error(
      `Connector "${parsed.id}@${parsed.version}" requires SDK version "${parsed.sdkVersion}", ` +
        `which does not accept the runtime SDK version ${SDK_VERSION}`,
    );
  }
  return parsed;
}
