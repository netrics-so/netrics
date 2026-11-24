import {
  ConnectorError,
  RateLimitedError,
  configuredHostsOf,
  configuredUrlsFollowSameHostOnly,
  credentialHostsMatch,
  validateDatasetPage,
  withoutCredentialHosts,
} from "@netrics/connector-sdk";
import {
  CURRENCY_DIMENSION,
  CURRENCY_MINOR_UNIT,
  RESOURCE_ICON_MAX_BYTES,
  checkResultSchema,
  freshnessProblem,
  resourceIconsRequestSchema,
  resourceIconsResultSchema,
  resourceSchema,
  syncRequestSchema,
  syncResultSchema,
  type CheckResult,
  type ConnectionContext,
  type Connector,
  type ConnectorManifest,
  type ConnectorRuntime,
  type ConnectorDatasetStaging,
  type Resource,
  type ResourceIconsRequest,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  EgressDeniedError,
  createEgressFetch,
  type EgressOptions,
} from "./egress.js";
import { createConnectorLogger, type ConnectorLogSink } from "./log.js";
import {
  credentialFreeCode,
  redactConnectorError,
  redactCredentialValues,
} from "./redact.js";

/** Time budget per connector call (one check, discover, or sync page). */
/** Brand of the host's custom API call options; never exported. */
const CUSTOM_API_CALL_OPTIONS: unique symbol = Symbol("customApiCallOptions");

export interface ExecuteOptions {
  /** Host-owned, already connection-scoped durable dataset staging. */
  datasetStaging?: (signal: AbortSignal) => ConnectorDatasetStaging;
  timeoutMs?: number;
  /**
   * Observes the status of every response connector code receives through
   * runtime.fetch (after redirects). The host uses it to notice a provider
   * 401 on an OAuth connection and refresh the access token (ADR 0012); it
   * sees no bodies or headers.
   */
  onResponse?: (status: number) => void;
  /**
   * Receives the sanitized lines connector code writes to runtime.log
   * (SDK 0.2.14, #638). The host attributes them to the connection and run.
   * Without a sink, connector log lines are dropped.
   */
  log?: ConnectorLogSink;
  /**
   * Values redacted like the connection's credentials, besides them:
   * values derived from them that connector code sends (a basic-auth
   * base64, "Bearer <token>", rendered auth headers). Applied to errors,
   * check messages and connector logs.
   */
  redactValues?: readonly string[];
  /**
   * Host-set egress policy (see EgressOptions). The server sets the custom
   * API values only for the custom-api connector, never for bundled
   * connectors; lookup, allowPrivateAddresses, allowInsecureHttp and tlsCa
   * are for tests only.
   */
  /** Set only by customApiCallOptions: where the options came from. */
  readonly [CUSTOM_API_CALL_OPTIONS]?: true;
  egress?: Pick<
    EgressOptions,
    | "lookup"
    | "allowPrivateAddresses"
    | "allowInsecureHttp"
    | "tlsCa"
    | "allowPrivateHosts"
    | "redirects"
    | "requestTimeoutMs"
    | "maxResponseBytes"
    | "maxDecompressedBytes"
    | "pinDns"
    | "bodyContentTypes"
  >;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Everything a call's errors, messages and logs are redacted against. */
function redactionSet(
  context: ConnectionContext,
  options: ExecuteOptions,
): Record<string, unknown> {
  return options.redactValues?.length
    ? { credentials: context.credentials, derived: [...options.redactValues] }
    : context.credentials;
}

/** The connector call exceeded its time budget (a retryable failure). */
export class ConnectorTimeoutError extends Error {
  constructor(connectorId: string, timeoutMs: number) {
    super(`connector "${connectorId}" did not answer within ${timeoutMs} ms`);
    this.name = "ConnectorTimeoutError";
  }
}

/**
 * An egress violation means the connector reached for a host it did not
 * declare (or a private address): a broken connector, never retried. An
 * EgressTimeoutError is not a denial: it stays a retryable provider failure.
 * A RateLimitedError keeps its class and retryAt. Everything else is a redacted, retryable provider failure.
 */
function classifyConnectorError(
  connector: Connector,
  error: unknown,
  secrets: Record<string, unknown>,
): Error {
  // Host capability validation errors remain permanent across the credential
  // boundary. Only the trusted class qualifies; names/messages are not tags.
  if (error instanceof ContractViolationError)
    return new ContractViolationError(
      redactCredentialValues(error.message, secrets),
    );
  if (error instanceof EgressDeniedError) {
    return new ContractViolationError(
      `connector "${connector.manifest.id}": ${error.message}`,
    );
  }
  // A provider limit with a known reset (SDK 0.2.16, #781): the host defers
  // the connection's jobs to retryAt. The retryAt is a timestamp the class
  // validated; only the message can carry credential material.
  if (error instanceof RateLimitedError) {
    return new RateLimitedError(
      redactCredentialValues(error.message, secrets),
      error.retryAt,
    );
  }
  return redactConnectorError(error, secrets);
}

/**
 * Runs one connector call with its runtime capabilities (egress-controlled
 * fetch, abort signal) and a time budget. The budget is enforced even when
 * connector code ignores the signal.
 */
/** The connector whose manifest is built per connection (ADR 0027). */
export const CUSTOM_API_CONNECTOR_ID = "custom-api";

/**
 * Marks options as the host's custom API call options. The host builds them
 * in one place (the server's callOptionsFor) and passes them through this;
 * the mark survives spreading (`{ ...options, onResponse }`), a hand-built
 * options object never has it.
 */
export function customApiCallOptions(options: ExecuteOptions): ExecuteOptions {
  return { ...options, [CUSTOM_API_CALL_OPTIONS]: true };
}

/**
 * The custom-api connector runs a user's definition: only with the host's
 * custom API call options (marked by customApiCallOptions, with same-host
 * redirects and derived secrets to redact). A call site that forgot them,
 * or built look-alike options by hand, fails loudly instead of running it
 * with a bundled connector's egress.
 */
function assertCallOptions(connector: Connector, options: ExecuteOptions) {
  if (
    connector.manifest.id === CUSTOM_API_CONNECTOR_ID &&
    (options[CUSTOM_API_CALL_OPTIONS] !== true ||
      options.egress?.redirects !== "same-host" ||
      options.redactValues === undefined)
  )
    throw new ContractViolationError(
      `connector "${CUSTOM_API_CONNECTOR_ID}" runs only with its custom API call options`,
    );
}

async function withRuntime<T>(
  connector: Connector,
  context: ConnectionContext,
  options: ExecuteOptions,
  call: (runtime: ConnectorRuntime) => Promise<T>,
): Promise<T> {
  assertCallOptions(connector, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const egressFetch = createEgressFetch({
    ...options.egress,
    // URLs a user entered (SDK 0.2.21, `<key>[].<item>` configuredHosts,
    // #874) follow redirects on their own host only, whatever the call
    // site passed (ADR 0027 §3).
    ...(configuredUrlsFollowSameHostOnly(connector.manifest)
      ? { redirects: "same-host" as const }
      : {}),
    // The manifest's hosts, and the hosts this connection's configuration
    // names under the manifest's configuredHosts (SDK 0.2.20, #873): a
    // self-hosted provider, reachable by this connection only.
    allowedDomains: [
      ...connector.manifest.outboundDomains,
      ...configuredHostsOf(connector.manifest, context.config),
    ],
    signal: controller.signal,
  });
  const onResponse = options.onResponse;
  const runtime: ConnectorRuntime = {
    fetch: onResponse
      ? async (url, init) => {
          const response = await egressFetch(url, init);
          onResponse(response.status);
          return response;
        }
      : egressFetch,
    signal: controller.signal,
    log: createConnectorLogger({
      connectorId: connector.manifest.id,
      credentials: redactionSet(context, options),
      sink: options.log,
      active: () => !controller.signal.aborted,
    }),
    ...(options.datasetStaging
      ? { datasetStaging: options.datasetStaging(controller.signal) }
      : {}),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectorTimeoutError(connector.manifest.id, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(runtime), timeout]);
  } finally {
    clearTimeout(timer);
    // Revoke durable storage access even if connector code retains the runtime.
    controller.abort();
  }
}

/**
 * The connector broke the SDK contract (invalid transport objects, undeclared
 * metric keys, undeclared dimensions). Callers classify this as a permanent,
 * non-retryable failure — retrying cannot fix connector code.
 */
export class ContractViolationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContractViolationError";
  }
}

/** The reason code of CredentialHostMismatchError (#795 catalog). */
export const CREDENTIAL_HOST_MISMATCH_CODE =
  "connection.credentials_host_changed";
export const CREDENTIAL_HOST_MISMATCH_MESSAGE =
  "The stored credentials were entered for another host. Enter them again for this host, in a new connection.";

/**
 * A call whose configuration names other hosts than the ones its
 * credentials are bound to (SDK 0.2.20 `configuredHosts`, #884 review):
 * refused before the connector runs, so no credential reaches a host it
 * was not entered for. A terminal condition, not a provider failure.
 */
export class CredentialHostMismatchError extends ConnectorError {
  constructor() {
    super(CREDENTIAL_HOST_MISMATCH_MESSAGE, CREDENTIAL_HOST_MISMATCH_CODE);
    this.name = "CredentialHostMismatchError";
  }
}

/**
 * The context a connector gets: credentials without their bound hosts,
 * after checking that the configuration names exactly those hosts
 * (`credentialHostsMatch`). Every entry point runs it before the egress
 * allowlist takes the configured hosts.
 */
function boundContext(
  connector: Connector,
  context: ConnectionContext,
): ConnectionContext {
  if (
    !credentialHostsMatch(
      connector.manifest,
      context.config,
      context.credentials,
    )
  ) {
    throw new CredentialHostMismatchError();
  }
  const credentials = withoutCredentialHosts(context.credentials);
  return credentials === context.credentials
    ? context
    : { ...context, credentials };
}

function formatIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Structural guard for the execution boundary (milestone invariant: connector
 * code cannot access database or queue handles). The context handed to
 * connector code must be plain JSON-compatible data — any function-typed
 * value means the host leaked a capability handle, which is a host wiring bug
 * and classified as a contract violation.
 */
export function assertContextIsPlain(context: ConnectionContext): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "function") {
      throw new ContractViolationError(
        `connection context carries a function at ${path} (capability leak)`,
      );
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, `${path}.${key}`);
      }
    }
  };
  walk(context.config, "config");
  walk(context.credentials, "credentials");
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validateSyncResult(
  manifest: ConnectorManifest,
  request: SyncRequest,
  raw: unknown,
): SyncResult {
  const parsed = syncResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${manifest.id}" returned an invalid sync result: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const result = parsed.data;
  if (result.done && result.datasetPages?.some((page) => !page.complete))
    throw new ContractViolationError(
      "Final sync page contains an incomplete dataset refresh",
    );
  // A dataset counts as checked only once the whole run is (#666).
  if (!result.done && result.receivedDatasets?.length)
    throw new ContractViolationError(
      "Received datasets on a sync page that is not final",
    );
  for (const key of result.receivedDatasets ?? [])
    if (!manifest.datasets?.some((dataset) => dataset.key === key))
      throw new ContractViolationError("Undeclared source dataset");
  // Freshness counts only on the done result (ADR 0025 section 2); on
  // other pages it is ignored once it is well-formed.
  if (result.done) {
    const problem = freshnessProblem(
      manifest.freshnessStreams,
      result.freshness,
    );
    if (problem)
      throw new ContractViolationError(
        `connector "${manifest.id}": ${problem}`,
      );
    // The next window may start before this one (a lookback), never after
    // its end: that would skip data (#758). Nor further back than the
    // connector's own backfill window (at least a day, for a day-aligned
    // lookback): a connector never needs to re-read more, and a start like
    // year 1 would make every later window huge, or (year 0) unstorable.
    if (result.nextFrom !== undefined) {
      const nextFromMs = Date.parse(result.nextFrom);
      if (nextFromMs > Date.parse(request.to))
        throw new ContractViolationError(
          `connector "${manifest.id}" returned a nextFrom after the window's end`,
        );
      const reachDays = Math.max(manifest.backfillDays ?? 0, 1);
      if (nextFromMs < Date.parse(request.from) - reachDays * DAY_MS)
        throw new ContractViolationError(
          `connector "${manifest.id}" returned a nextFrom more than ${reachDays === 1 ? "1 day" : `${reachDays} days`} before the window's start`,
        );
    }
  } else {
    delete result.freshness;
    delete result.nextFrom;
  }
  const metrics = new Map(
    manifest.metrics.map((metric) => [metric.key, metric]),
  );
  for (const page of result.datasetPages ?? []) {
    const definition = manifest.datasets?.find(
      (dataset) => dataset.key === page.datasetKey,
    );
    if (!definition)
      throw new ContractViolationError("Undeclared source dataset");
    try {
      validateDatasetPage(definition, page);
    } catch (error) {
      throw new ContractViolationError((error as Error).message);
    }
  }
  for (const observation of result.observations) {
    const metric = metrics.get(observation.metricKey);
    if (!metric) {
      throw new ContractViolationError(
        `connector "${manifest.id}" returned undeclared metric key "${observation.metricKey}"`,
      );
    }
    for (const dimension of Object.keys(observation.dimensions)) {
      if (!metric.dimensions.includes(dimension)) {
        throw new ContractViolationError(
          `connector "${manifest.id}" returned undeclared dimension "${dimension}" for metric "${observation.metricKey}"`,
        );
      }
    }
    if (metric.unit === CURRENCY_MINOR_UNIT) {
      // Amounts are added up per currency only, so each one names its
      // currency (ISO 4217) and is a whole number of minor units.
      const currency = observation.dimensions[CURRENCY_DIMENSION];
      if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
        throw new ContractViolationError(
          `connector "${manifest.id}" returned a "${observation.metricKey}" amount without an ISO 4217 "${CURRENCY_DIMENSION}" dimension`,
        );
      }
      if (!Number.isInteger(observation.value)) {
        throw new ContractViolationError(
          `connector "${manifest.id}" returned a "${observation.metricKey}" amount that is not in integer minor units`,
        );
      }
    }
  }
  return result;
}

/**
 * Runs one connector sync inside the execution boundary: the request is
 * validated, the context is checked for leaked capability handles, the
 * connector's output is validated against the transport schema AND its own
 * manifest, and any thrown error is re-thrown with credential values stripped
 * from its message.
 *
 * Thrown connector errors propagate as retryable provider failures (SDK
 * convention); ContractViolationError marks a broken connector.
 */
export async function executeSync(
  connector: Connector,
  context: ConnectionContext,
  request: SyncRequest,
  options: ExecuteOptions = {},
): Promise<SyncResult> {
  const parsedRequest = syncRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new ContractViolationError(
      `invalid sync request: ${formatIssues(parsedRequest.error.issues)}`,
    );
  }
  assertContextIsPlain(context);
  context = boundContext(connector, context);
  let raw: unknown;
  try {
    raw = await withRuntime(connector, context, options, (runtime) =>
      connector.sync(context, parsedRequest.data, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(
      connector,
      error,
      redactionSet(context, options),
    );
  }
  return validateSyncResult(connector.manifest, parsedRequest.data, raw);
}

/**
 * Runs the connector's credential/health check inside the same boundary.
 * `ok: false` signals a terminal condition (bad credentials); a thrown error
 * signals a retryable provider failure. Returned messages are redacted
 * against the credential values — connectors may quote the rejected token.
 */
export async function executeCheck(
  connector: Connector,
  context: ConnectionContext,
  options: ExecuteOptions = {},
): Promise<CheckResult> {
  assertContextIsPlain(context);
  context = boundContext(connector, context);
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      context,
      { timeoutMs: 15_000, ...options },
      (runtime) => connector.check(context, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(
      connector,
      error,
      redactionSet(context, options),
    );
  }
  const parsed = checkResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${connector.manifest.id}" returned an invalid check result: ${formatIssues(parsed.error.issues)}`,
    );
  }
  // The message is redacted; a reason code that holds a credential value
  // or a derived secret is dropped whole (#795).
  const secrets = redactionSet(context, options);
  const { code: reported, message, ...rest } = parsed.data;
  const code = credentialFreeCode(reported, secrets);
  return {
    ...rest,
    ...(message ? { message: redactCredentialValues(message, secrets) } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

/**
 * Runs the connector's resource discovery inside the same boundary (used by
 * the connection wizard's preview step). Thrown errors are redacted provider
 * failures; a malformed resource list is a contract violation.
 */
export async function executeDiscover(
  connector: Connector,
  context: ConnectionContext,
  options: ExecuteOptions = {},
): Promise<Resource[]> {
  assertContextIsPlain(context);
  context = boundContext(connector, context);
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      context,
      { timeoutMs: 15_000, ...options },
      (runtime) => connector.discover(context, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(
      connector,
      error,
      redactionSet(context, options),
    );
  }
  const parsed = z.array(resourceSchema).safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${connector.manifest.id}" returned invalid resources: ${formatIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

/**
 * Runs host-trusted code of a bundled connector (the custom-api connector's
 * item image downloads, #809) inside the same boundary as sync: the egress
 * guard from `options.egress` and the manifest's outboundDomains, the time
 * budget, and errors redacted against the connection's credentials and
 * `options.redactValues`. `call` gets the runtime, never a database or queue
 * handle.
 */
export async function executeTrustedCall<T>(
  connector: Connector,
  context: ConnectionContext,
  options: ExecuteOptions,
  call: (runtime: ConnectorRuntime) => Promise<T>,
): Promise<T> {
  assertContextIsPlain(context);
  context = boundContext(connector, context);
  try {
    return await withRuntime(connector, context, options, call);
  } catch (error) {
    throw classifyConnectorError(
      connector,
      error,
      redactionSet(context, options),
    );
  }
}

/** An icon a connector returned, decoded; the host still validates it. */
export interface FetchedResourceIcon {
  resourceId: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
}

/** Whether the connector implements the optional icon capability. */
export function supportsResourceIcons(connector: Connector): boolean {
  return typeof connector.resourceIcons === "function";
}

/**
 * Runs the optional resourceIcons capability (SDK 0.2.5, #226) inside the
 * same boundary as sync: egress-controlled fetch, time budget, redacted
 * errors. An icon for a resource that was not asked for, a malformed
 * result or an icon above RESOURCE_ICON_MAX_BYTES is a contract
 * violation. A connector without the capability returns no icons.
 */
export async function executeResourceIcons(
  connector: Connector,
  context: ConnectionContext,
  request: ResourceIconsRequest,
  options: ExecuteOptions = {},
): Promise<FetchedResourceIcon[]> {
  const resourceIcons = connector.resourceIcons?.bind(connector);
  if (!resourceIcons) {
    return [];
  }
  const parsedRequest = resourceIconsRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new ContractViolationError(
      `invalid resource icons request: ${formatIssues(parsedRequest.error.issues)}`,
    );
  }
  assertContextIsPlain(context);
  context = boundContext(connector, context);
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      context,
      { timeoutMs: 30_000, ...options },
      (runtime) => resourceIcons(context, parsedRequest.data, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(
      connector,
      error,
      redactionSet(context, options),
    );
  }
  const parsed = resourceIconsResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${connector.manifest.id}" returned invalid resource icons: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const asked = new Set(parsedRequest.data.resources.map((entry) => entry.id));
  const icons = new Map<string, FetchedResourceIcon>();
  for (const icon of parsed.data.icons) {
    if (!asked.has(icon.resourceId)) {
      throw new ContractViolationError(
        `connector "${connector.manifest.id}" returned an icon for a resource it was not asked for`,
      );
    }
    const bytes = Buffer.from(icon.data, "base64");
    if (bytes.length === 0 || bytes.length > RESOURCE_ICON_MAX_BYTES) {
      throw new ContractViolationError(
        `connector "${connector.manifest.id}" returned an icon of ${bytes.length} bytes (at most ${RESOURCE_ICON_MAX_BYTES})`,
      );
    }
    icons.set(icon.resourceId, {
      resourceId: icon.resourceId,
      contentType: icon.contentType,
      bytes,
    });
  }
  return [...icons.values()];
}
