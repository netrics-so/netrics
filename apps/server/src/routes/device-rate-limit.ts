/**
 * A request limit per device on the device API (`/v1/device/*` behind a
 * device token, #829): a token bucket per device, in this process.
 *
 * Generous on purpose, so a working screen never meets it. A screen polls
 * its payload and sends a heartbeat about once a minute and loads each
 * image once per `?v=` (cached as immutable). Its largest burst is the
 * first load of a dashboard's images: at most the upload quota (100) plus
 * the custom API item image quota (500) by default. The bucket holds 1,200
 * requests and refills 5 per second (300 a minute), so twice that burst
 * passes at once and a screen that keeps refetching is slowed, not cut off.
 * What it bounds is a token holder replaying requests (each item image
 * request may rerun the dashboard's items queries).
 *
 * Per process: with several API replicas a device may get up to the limit
 * at each. Idle devices' buckets are dropped once full again.
 */
export interface DeviceRateLimit {
  /** Requests a device may send at once. */
  capacity: number;
  /** Requests a device gets back per second. */
  refillPerSecond: number;
}

export const DEVICE_RATE_LIMIT: DeviceRateLimit = {
  capacity: 1_200,
  refillPerSecond: 5,
};

export type DeviceRateLimiter = (
  deviceId: string,
) => { ok: true } | { ok: false; retryAfterSeconds: number };

export function createDeviceRateLimiter(
  limit: DeviceRateLimit = DEVICE_RATE_LIMIT,
  options: {
    /** Milliseconds; tests pin it. */
    clock?: () => number;
    /** At most this many devices are tracked (default 10,000). */
    maxEntries?: number;
  } = {},
): DeviceRateLimiter {
  const clock = options.clock ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refill = (bucket: { tokens: number; at: number }, at: number) =>
    Math.min(
      limit.capacity,
      bucket.tokens + ((at - bucket.at) / 1000) * limit.refillPerSecond,
    );
  return (deviceId) => {
    const at = clock();
    const found = buckets.get(deviceId);
    const tokens = found ? refill(found, at) : limit.capacity;
    if (tokens < 1) {
      const seconds = (1 - tokens) / limit.refillPerSecond;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
    }
    // Most recently used last: a Map keeps insertion order.
    buckets.delete(deviceId);
    buckets.set(deviceId, { tokens: tokens - 1, at });
    for (const [id, bucket] of buckets) {
      if (buckets.size > maxEntries || refill(bucket, at) >= limit.capacity)
        buckets.delete(id);
      else break;
    }
    return { ok: true };
  };
}
