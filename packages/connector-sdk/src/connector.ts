import type { ConnectorManifest } from "./manifest.js";
import type {
  CheckResult,
  ConnectionContext,
  Resource,
  SyncRequest,
  SyncResult,
} from "./transport.js";

/**
 * Versioned connector contract. All inputs and outputs are JSON-compatible
 * transport objects so a future isolated runner can cross a process boundary.
 *
 * Failure convention: throwing signals a retryable provider failure (outage,
 * rate limit, network); returning `{ ok: false }` from `check` signals a
 * terminal condition such as invalid credentials that needs user action.
 */
export interface Connector {
  manifest: ConnectorManifest;
  check(context: ConnectionContext): Promise<CheckResult>;
  discover(context: ConnectionContext): Promise<Resource[]>;
  sync(context: ConnectionContext, request: SyncRequest): Promise<SyncResult>;
}
