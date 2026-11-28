import { ConnectorError } from "@netrics/connector-sdk";

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

/** Shorter values are not redacted from logs and errors (see below). */
const LOG_MIN_SECRET_LENGTH = 4;

/**
 * Collects string credential values of at least `minLength` characters.
 * Logs and error messages use LOG_MIN_SECRET_LENGTH: short values would
 * over-redact (e.g. replacing every "a"), and real tokens are never this
 * short. A connector may use a value trimmed (a key pasted with spaces),
 * so its trimmed form counts too (#891 review).
 */
function collectSecretValues(
  credentials: Record<string, unknown>,
  minLength = LOG_MIN_SECRET_LENGTH,
): string[] {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const form of new Set([value, value.trim()])) {
        if (form.length >= minLength) {
          values.push(form);
        }
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
 * A reason code (SDK 0.2.18, #795) that may leave the credential boundary:
 * `code` itself, or undefined when it holds a credential value. A code is
 * well formed (lowercase words) and still not trusted: a connector could
 * build one from a credential ("acme." + a lowercase hex token), and codes
 * are stored and logged unredacted. Such a code is dropped whole, never
 * forwarded in part. Values are compared in lower case too, since a
 * connector has to lowercase a credential to fit it into a code.
 */
export function credentialFreeCode(
  code: string | undefined,
  credentials: Record<string, unknown>,
): string | undefined {
  if (code === undefined) {
    return undefined;
  }
  const lower = code.toLowerCase();
  for (const secret of collectSecretValues(credentials)) {
    if (code.includes(secret) || lower.includes(secret.toLowerCase())) {
      return undefined;
    }
  }
  return code;
}

/**
 * A test for text that a response would carry out of the credential
 * boundary (a config option's value, label or description, #891): true
 * when it holds a credential value, compared in lower case too, as
 * credentialFreeCode does. Such text is dropped whole rather than
 * rewritten. Unlike the log redactor, every nonempty value counts, short
 * ones included (#937): dropping a choice too many is safe, a short secret
 * shown or stored in the config is not. The values are collected and
 * normalized once, so one matcher serves a whole response.
 */
export function responseCredentialMatcher(
  credentials: Record<string, unknown>,
): (text: string) => boolean {
  const secrets = [...new Set(collectSecretValues(credentials, 1))].map(
    (secret) => ({ secret, lower: secret.toLowerCase() }),
  );
  if (secrets.length === 0) return () => false;
  return (text) => {
    const lower = text.toLowerCase();
    return secrets.some(
      ({ secret, lower: lowerSecret }) =>
        text.includes(secret) || lower.includes(lowerSecret),
    );
  };
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
  const text = redactCredentialValues(message, credentials);
  // A reason code (SDK 0.2.18, #795) crosses the boundary with the
  // redacted message, unless it holds a credential value: then the error
  // crosses as a plain one, without a code.
  const code =
    error instanceof ConnectorError
      ? credentialFreeCode(error.code, credentials)
      : undefined;
  const redacted =
    code !== undefined ? new ConnectorError(text, code) : new Error(text);
  redacted.name = error instanceof Error ? error.name : "Error";
  return redacted;
}
