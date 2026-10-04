import {
  CURRENCY_DIMENSION,
  CURRENCY_MINOR_UNIT,
  RESOURCE_ICON_MAX_BYTES,
  checkResultSchema,
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
import { redactConnectorError, redactCredentialValues } from "./redact.js";

/** Time budget per connector call (one check, discover, or sync page). */
export interface ExecuteOptions {
  timeoutMs?: number;
  /**
   * Observes the status of every response connector code receives through
   * runtime.fetch (after redirects). The host uses it to notice a provider
   * 401 on an OAuth connection and refresh the access token (ADR 0012); it
   * sees no bodies or headers.
   */
  onResponse?: (status: number) => void;
  /** Tests only: reach a local fixture provider (see EgressOptions). */
  egress?: Pick<
    EgressOptions,
    "lookup" | "allowPrivateAddresses" | "allowInsecureHttp"
  >;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The connector call exceeded its time budget (a retryable failure). */
export class ConnectorTimeoutError extends Error {
  constructor(connectorId: string, timeoutMs: number) {
    super(`connector "${connectorId}" did not answer within ${timeoutMs} ms`);
    this.name = "ConnectorTimeoutError";
  }
}

/**
 * An egress violation means the connector reached for a host it did not
 * declare (or a private address): a broken connector, never retried.
 * Everything else is a redacted, retryable provider failure.
 */
function classifyConnectorError(
  connector: Connector,
  error: unknown,
  context: ConnectionContext,
): Error {
  if (error instanceof EgressDeniedError) {
    return new ContractViolationError(
      `connector "${connector.manifest.id}": ${error.message}`,
    );
  }
  return redactConnectorError(error, context.credentials);
}

/**
 * Runs one connector call with its runtime capabilities (egress-controlled
 * fetch, abort signal) and a time budget. The budget is enforced even when
 * connector code ignores the signal.
 */
async function withRuntime<T>(
  connector: Connector,
  options: ExecuteOptions,
  call: (runtime: ConnectorRuntime) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const egressFetch = createEgressFetch({
    ...options.egress,
    allowedDomains: connector.manifest.outboundDomains,
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

function validateSyncResult(
  manifest: ConnectorManifest,
  raw: unknown,
): SyncResult {
  const parsed = syncResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${manifest.id}" returned an invalid sync result: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const result = parsed.data;
  const metrics = new Map(
    manifest.metrics.map((metric) => [metric.key, metric]),
  );
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
  let raw: unknown;
  try {
    raw = await withRuntime(connector, options, (runtime) =>
      connector.sync(context, parsedRequest.data, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(connector, error, context);
  }
  return validateSyncResult(connector.manifest, raw);
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
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      { timeoutMs: 15_000, ...options },
      (runtime) => connector.check(context, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(connector, error, context);
  }
  const parsed = checkResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${connector.manifest.id}" returned an invalid check result: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const result = parsed.data;
  if (result.message) {
    return {
      ...result,
      message: redactCredentialValues(result.message, context.credentials),
    };
  }
  return result;
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
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      { timeoutMs: 15_000, ...options },
      (runtime) => connector.discover(context, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(connector, error, context);
  }
  const parsed = z.array(resourceSchema).safeParse(raw);
  if (!parsed.success) {
    throw new ContractViolationError(
      `connector "${connector.manifest.id}" returned invalid resources: ${formatIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
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
  let raw: unknown;
  try {
    raw = await withRuntime(
      connector,
      { timeoutMs: 30_000, ...options },
      (runtime) => resourceIcons(context, parsedRequest.data, runtime),
    );
  } catch (error) {
    throw classifyConnectorError(connector, error, context);
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
