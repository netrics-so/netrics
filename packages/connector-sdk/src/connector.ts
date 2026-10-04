import type { ConnectorManifest } from "./manifest.js";
import type {
  CheckResult,
  ConnectionContext,
  Resource,
  ResourceIconsRequest,
  ResourceIconsResult,
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
  /**
   * Optional (SDK 0.2.5, #226): icons of the given resources, for example
   * an app's App Store icon, fetched through runtime.fetch like everything
   * else. Resources without an icon are left out of the result; a thrown
   * error is a retryable provider failure. The host validates and stores
   * the bytes (raster only, metadata stripped) and refreshes them at most
   * daily, so implementations need no cache of their own.
   */
  resourceIcons?(
    context: ConnectionContext,
    request: ResourceIconsRequest,
    runtime: ConnectorRuntime,
  ): Promise<ResourceIconsResult>;
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

/**
 * A fully buffered response. The whole body is read within the host's size
 * limit (10 MiB by default) before the connector sees it; a larger body
 * fails the fetch.
 */
export interface ConnectorResponse {
  status: number;
  headers: Record<string, string>;
  /** The body decoded as UTF-8. */
  text(): string;
  /** The body parsed as JSON (throws on invalid JSON). */
  json(): unknown;
  /**
   * The exact body bytes, for binary payloads such as gzip report files.
   * Each call returns a fresh copy. The size limit applies to these bytes,
   * not to anything the connector inflates from them: decompress with a
   * bound of your own, e.g. `gunzipSync(bytes, { maxOutputLength })` from
   * `node:zlib`, so an oversized or hostile archive fails the call instead
   * of exhausting memory. Since SDK 0.2.2.
   */
  bytes(): Uint8Array;
}
