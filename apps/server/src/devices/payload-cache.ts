// An in-process memo of computed device payloads (ADR 0015 section 7):
// several screens on one dashboard compute it once per TTL. Callers key it
// by (workspace, dashboard, dashboard version, schema) and compute inside
// their own workspace transaction, so nothing is shared across workspaces
// and a saved dashboard (a new version) is a new key.

/** How long a computed payload is reused. Syncs run every few minutes. */
export const DEVICE_PAYLOAD_CACHE_MS = 30_000;

/** Keeps memory bounded however many dashboards are shown. */
const MAX_ENTRIES = 500;

export interface PayloadCache {
  /** The value under `key`, computed with `compute` when missing or old. */
  get<T>(key: string, compute: () => Promise<T>): Promise<T>;
}

export function createPayloadCache(options: {
  ttlMs: number;
  now?: () => number;
  maxEntries?: number;
}): PayloadCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map<
    string,
    { expiresAt: number; value: Promise<unknown> }
  >();

  function prune(at: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) {
        entries.delete(key);
      }
    }
    // Oldest first: a Map iterates in insertion order.
    for (const key of entries.keys()) {
      if (entries.size < maxEntries) {
        break;
      }
      entries.delete(key);
    }
  }

  return {
    get<T>(key: string, compute: () => Promise<T>): Promise<T> {
      if (options.ttlMs <= 0) {
        return compute();
      }
      const at = now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > at) {
        return hit.value as Promise<T>;
      }
      prune(at);
      // The promise itself is kept, so simultaneous requests share one
      // computation. A failure is not kept.
      const value = compute();
      entries.set(key, { expiresAt: at + options.ttlMs, value });
      value.catch(() => {
        if (entries.get(key)?.value === value) {
          entries.delete(key);
        }
      });
      return value;
    },
  };
}
