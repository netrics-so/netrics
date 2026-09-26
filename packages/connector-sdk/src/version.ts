import { connectorManifestSchema, type ConnectorManifest } from "./manifest.js";
import { satisfiesRange } from "./semver.js";

export const SDK_VERSION = "0.1.0";

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
