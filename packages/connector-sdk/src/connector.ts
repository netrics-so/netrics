import type { DatasetPage } from "./datasets.js";
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
  /** Aborted when the call ends or the host's time budget runs out. */
  signal: AbortSignal;
  /**
   * Optional SDK 0.2.10 durable, connection-scoped parsed dataset staging;
   * incremental writes (`begin`) since 0.2.11.
   */
  datasetStaging?: ConnectorDatasetStaging;
}

/** Host-assigned identity; metadata must contain no credentials or raw records. */
export interface StagedDataset {
  id: string;
  key: string;
  metadata: unknown;
}

/**
 * Immutable, schema-validated pages persisted before returning a checkpoint.
 * The host scopes every operation to this connection/connector, limits bytes,
 * enforces source/tier retention and expires disposable staging within one day.
 * A stage's lifetime never extends when read or written again. A missing stage
 * can be rebuilt from the provider; restart an incomplete refresh in that case.
 */
export interface ConnectorDatasetStaging {
  get(key: string): Promise<StagedDataset | null>;
  getPage(id: string, pageKey: string): Promise<DatasetPage>;
  /**
   * Stages a complete page set at once. Since SDK 0.2.11 hosts write it
   * through begin/append/commit; the stage is still only readable once all
   * pages are stored. An identical stage under a live key is returned as is;
   * different content under a live key is an error.
   */
  put(input: {
    key: string;
    metadata: unknown;
    pages: DatasetPage[];
  }): Promise<StagedDataset>;
  /**
   * Optional (SDK 0.2.11, ADR 0024): writes a stage page by page, so a
   * connector need not hold a whole report in memory. Pages are validated,
   * stored and counted against the host's byte budget on every append; a
   * refused append ends the draft. Nothing is readable before `commit`. A
   * draft lives within the current connector call: when the call ends or is
   * aborted the host discards it, and an uncommitted draft expires on its own.
   */
  begin?(input: {
    key: string;
    datasetKey: string;
    schemaVersion: number;
  }): Promise<DatasetStageWriter>;
}

/** One draft stage (SDK 0.2.11). Every page belongs to the dataset given to `begin`. */
export interface DatasetStageWriter {
  /** Stores pages now. Page keys are unique within the stage. */
  append(pages: DatasetPage[]): Promise<void>;
  /**
   * Makes the stage readable with its final metadata (the page index, for
   * example). Returns an identical live stage under the same key instead,
   * and fails on different content. The writer is closed afterwards.
   */
  commit(input: { metadata: unknown }): Promise<StagedDataset>;
  /** Discards the draft and its pages. Safe to call more than once. */
  abort(): Promise<void>;
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
