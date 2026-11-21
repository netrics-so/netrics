/**
 * Thrown by connector code when the provider's request limit is used up and
 * the provider says when it resets (SDK 0.2.16, #781): a 429 with
 * `Retry-After`, a reset header, or a quota with a known reset time.
 *
 * The host does not count it as a failure or an outage. It stops the run
 * (what earlier pages committed stays, and the run resumes from its
 * checkpoint), and runs no job of the connection before `retryAt`. A rate
 * limit whose reset the provider does not say is an ordinary thrown error:
 * the host retries it with its usual backoff.
 *
 * `retryAt` is an ISO 8601 instant. The host bounds it (no sooner than a
 * few seconds, no later than a day ahead) and adds jitter of its own.
 */
export class RateLimitedError extends Error {
  readonly retryAt: string;

  constructor(message: string, retryAt: Date | string) {
    super(message);
    this.name = "RateLimitedError";
    const at = typeof retryAt === "string" ? new Date(retryAt) : retryAt;
    if (Number.isNaN(at.getTime())) {
      throw new TypeError("RateLimitedError needs a valid retryAt");
    }
    this.retryAt = at.toISOString();
  }
}

/**
 * The shape of a reason code (SDK 0.2.18, #795): lowercase words joined by
 * "_" and namespaced with ".", such as `acme.key_revoked`. At most 64
 * characters. A code names a fixed, known reason: it never carries a
 * secret, an identifier of the account or a part of the provider's answer.
 */
export const ERROR_CODE_PATTERN = /^[a-z0-9]+(?:[._][a-z0-9]+)*$/;
export const ERROR_CODE_MAX_LENGTH = 64;

/** Whether `value` is a well-formed reason code. */
export function isErrorCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ERROR_CODE_MAX_LENGTH &&
    ERROR_CODE_PATTERN.test(value)
  );
}

/**
 * Thrown by connector code for a failure with a known reason (SDK 0.2.18,
 * #795). The host stores `code` next to the message, and clients that know
 * the code show their own text for it in the viewer's language; the message
 * stays the English fallback for clients that do not. Start the code with
 * the connector's id (`acme.quota_used_up`) so it cannot collide.
 *
 * It is handled like any other thrown error (a retryable provider
 * failure): the code explains the failure and does not change how the
 * host reacts. Connectors that throw plain errors keep working.
 */
export class ConnectorError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ConnectorError";
    if (!isErrorCode(code)) {
      throw new TypeError(
        "ConnectorError needs a code of lowercase words joined by _ or .",
      );
    }
    this.code = code;
  }
}
