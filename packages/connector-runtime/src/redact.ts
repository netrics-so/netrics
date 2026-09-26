const SECRET_KEY_PATTERN = /secret|token|password|credential|key/i;
const REDACTED = "[redacted]";

/**
 * Deep-clones `input`, replacing the value of any object key that looks like
 * it carries a secret (secret/token/password/credential/key) with
 * "[redacted]". For log and error paths: credentials must never appear in
 * either. Circular references are replaced with "[circular]".
 *
 * The single implementation lives here in the connector runtime (the
 * credential boundary); apps/server re-exports it.
 */
export function redactSecrets(input: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          SECRET_KEY_PATTERN.test(entryKey) ? REDACTED : walk(entryValue),
        ]),
      );
    }
    return value;
  };
  return walk(input);
}

/** Collects string credential values long enough to redact safely. */
function collectSecretValues(credentials: Record<string, unknown>): string[] {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      // Short values would over-redact (e.g. replacing every "a"); real
      // tokens are never this short.
      if (value.length >= 4) {
        values.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(credentials);
  return values;
}

/**
 * Replaces every occurrence of a credential VALUE in `message` with
 * "[redacted]". Complements redactSecrets (which redacts by object key) for
 * free-text error messages a connector may build from its own credentials.
 */
export function redactCredentialValues(
  message: string,
  credentials: Record<string, unknown>,
): string {
  let redacted = message;
  for (const secret of collectSecretValues(credentials)) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

/**
 * Re-throws a connector error with credential values stripped from the
 * message. The cause chain is dropped on purpose: it may embed credential
 * material, and logs/errors must never carry it (milestone invariant).
 */
export function redactConnectorError(
  error: unknown,
  credentials: Record<string, unknown>,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = new Error(redactCredentialValues(message, credentials));
  redacted.name = error instanceof Error ? error.name : "Error";
  return redacted;
}
