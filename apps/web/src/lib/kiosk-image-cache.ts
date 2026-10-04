import type { KioskImageCache } from "./kiosk-client";

/** One cache for the kiosk's images; bump the suffix to drop old entries. */
export const KIOSK_IMAGE_CACHE = "netrics-kiosk-images-v1";

/**
 * Cache Storage keys must be http(s) URLs. These name a hash on this
 * origin and are never requested: entries are only read back by the kiosk.
 */
const KEY_PATH = "/kiosk/image-cache/";

/** The minimal Cache Storage API the kiosk uses (tests pass a fake). */
export interface CacheStorageLike {
  open(name: string): Promise<{
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
    keys(): Promise<ReadonlyArray<{ url: string }>>;
    delete(key: string): Promise<boolean>;
  }>;
}

/**
 * The kiosk's image cache in Cache Storage (ADR 0015, section 7): image
 * bytes by sha256, so a reload or an offline start shows the images it had.
 * Null where Cache Storage is unavailable (plain http outside localhost is
 * not a secure context); the kiosk then keeps images in memory only.
 */
export function cacheStorageImageCache(
  storage: CacheStorageLike | undefined,
  origin: string,
): KioskImageCache | null {
  if (!storage) {
    return null;
  }
  const keyOf = (sha256: string) => `${origin}${KEY_PATH}${sha256}`;
  const open = () => storage.open(KIOSK_IMAGE_CACHE);
  return {
    async get(sha256) {
      const response = await (await open()).match(keyOf(sha256));
      return response ? await response.blob() : null;
    },
    async put(sha256, blob) {
      await (
        await open()
      ).put(
        keyOf(sha256),
        new Response(blob, {
          headers: { "content-type": blob.type || "application/octet-stream" },
        }),
      );
    },
    async prune(keep) {
      const cache = await open();
      for (const request of await cache.keys()) {
        const sha256 = request.url.slice(request.url.lastIndexOf("/") + 1);
        if (!keep.has(sha256)) {
          await cache.delete(request.url);
        }
      }
    },
  };
}

/** The browser's Cache Storage, when this page may use it. */
export function browserImageCache(): KioskImageCache | null {
  try {
    return cacheStorageImageCache(
      typeof caches === "undefined" ? undefined : caches,
      window.location.origin,
    );
  } catch {
    return null;
  }
}
