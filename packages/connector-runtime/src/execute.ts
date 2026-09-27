import {
  checkResultSchema,
  syncRequestSchema,
  syncResultSchema,
  type CheckResult,
  type ConnectionContext,
  type Connector,
  type ConnectorManifest,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import { redactConnectorError, redactCredentialValues } from "./redact.js";

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
    raw = await connector.sync(context, parsedRequest.data);
  } catch (error) {
    throw redactConnectorError(error, context.credentials);
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
): Promise<CheckResult> {
  assertContextIsPlain(context);
  let raw: unknown;
  try {
    raw = await connector.check(context);
  } catch (error) {
    throw redactConnectorError(error, context.credentials);
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
