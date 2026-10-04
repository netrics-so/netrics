import { describe, expect, it } from "vitest";

import {
  KIOSK_IMAGE_CACHE,
  cacheStorageImageCache,
  type CacheStorageLike,
} from "./kiosk-image-cache";

function fakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const storage: CacheStorageLike = {
    open(name) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return Promise.resolve({
        match: (key: string) => Promise.resolve(store.get(key)?.clone()),
        put: (key: string, response: Response) => {
          store.set(key, response);
          return Promise.resolve();
        },
        keys: () => Promise.resolve([...store.keys()].map((url) => ({ url }))),
        delete: (key: string) => Promise.resolve(store.delete(key)),
      });
    },
  };
  return { storage, stores };
}

describe("cacheStorageImageCache", () => {
  it("is null without Cache Storage (not a secure context)", () => {
    expect(cacheStorageImageCache(undefined, "http://tv.local")).toBeNull();
  });

  it("stores, reads back and prunes images by sha256", async () => {
    const { storage, stores } = fakeCacheStorage();
    const cache = cacheStorageImageCache(storage, "https://netrics.test")!;
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(await cache.get(a)).toBeNull();

    await cache.put(a, new Blob(["png-a"], { type: "image/png" }));
    await cache.put(b, new Blob(["png-b"], { type: "image/png" }));
    const blob = await cache.get(a);
    expect(await blob!.text()).toBe("png-a");
    expect(blob!.type).toBe("image/png");
    expect([...stores.get(KIOSK_IMAGE_CACHE)!.keys()]).toEqual([
      `https://netrics.test/kiosk/image-cache/${a}`,
      `https://netrics.test/kiosk/image-cache/${b}`,
    ]);

    await cache.prune(new Set([b]));
    expect(await cache.get(a)).toBeNull();
    expect(await (await cache.get(b))!.text()).toBe("png-b");
  });
});
