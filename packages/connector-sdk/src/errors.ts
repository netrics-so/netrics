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
