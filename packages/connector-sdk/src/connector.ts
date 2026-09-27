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
  check(
    context: ConnectionContext,
    runtime: ConnectorRuntime,
  ): Promise<CheckResult>;
  discover(
    context: ConnectionContext,
    runtime: ConnectorRuntime,
  ): Promise<Resource[]>;
  sync(
    context: ConnectionContext,
    request: SyncRequest,
    runtime: ConnectorRuntime,
  ): Promise<SyncResult>;
}

/**
 * Capabilities the host hands to connector code for one call. Kept separate
 * from ConnectionContext, which must stay plain JSON data.
 */
export interface ConnectorRuntime {
  /**
   * The sanctioned HTTP client. It only reaches https hosts listed in the
   * manifest's outboundDomains ("api.example.com" or "*.example.com"),
   * refuses private, loopback, link-local and metadata addresses (checked
   * at connect time), follows at most a few redirects (each re-checked), and
   * bounds response size and duration. Violations throw EgressDeniedError.
   */
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  /** Aborted when the host's time budget for this call runs out. */
  signal: AbortSignal;
}

export interface ConnectorFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/** A fully buffered response (the body is read within the size limit). */
export interface ConnectorResponse {
  status: number;
  headers: Record<string, string>;
  text(): string;
  json(): unknown;
}
