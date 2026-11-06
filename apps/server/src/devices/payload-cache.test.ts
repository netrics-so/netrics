import { describe, expect, it } from "vitest";

import { createPayloadCache } from "./payload-cache.js";

describe("payload cache", () => {
  it("reuses a value until it expires", async () => {
    let now = 0;
    let computed = 0;
    const cache = createPayloadCache({ ttlMs: 30_000, now: () => now });
    const compute = async () => ++computed;
    expect(await cache.get("a", compute)).toBe(1);
    now = 29_999;
    expect(await cache.get("a", compute)).toBe(1);
    expect(await cache.get("b", compute)).toBe(2);
    now = 30_000;
    expect(await cache.get("a", compute)).toBe(3);
  });

  it("shares one computation between simultaneous callers", async () => {
    let computed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = createPayloadCache({ ttlMs: 30_000 });
    const compute = async () => {
      computed += 1;
      await gate;
      return computed;
    };
    const both = Promise.all([
      cache.get("k", compute),
      cache.get("k", compute),
    ]);
    release();
    expect(await both).toEqual([1, 1]);
    expect(computed).toBe(1);
  });

  it("does not keep failures", async () => {
    const cache = createPayloadCache({ ttlMs: 30_000 });
    await expect(
      cache.get("k", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await cache.get("k", async () => "ok")).toBe("ok");
  });

  it("computes every time with a TTL of 0", async () => {
    let computed = 0;
    const cache = createPayloadCache({ ttlMs: 0 });
    await cache.get("k", async () => ++computed);
    await cache.get("k", async () => ++computed);
    expect(computed).toBe(2);
  });

  it("drops the oldest entries beyond its size", async () => {
    let computed = 0;
    const cache = createPayloadCache({ ttlMs: 30_000, maxEntries: 2 });
    const compute = async () => ++computed;
    await cache.get("a", compute);
    await cache.get("b", compute);
    await cache.get("c", compute);
    expect(await cache.get("c", compute)).toBe(3);
    expect(await cache.get("a", compute)).toBe(4);
  });
});
