import { afterEach, describe, expect, it, vi } from "vitest";

import { webReachable } from "./use-server-refresh";

/**
 * The probe before each periodic refresh (#681): a refresh that fails falls
 * back to a browser navigation, so it only runs when the web app answers.
 */
describe("webReachable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks /healthz, uncached, and trusts only an answer", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const ok = (async (url: unknown, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(await webReachable(ok)).toBe(true);
    expect(calls[0]![0]).toBe("/healthz");
    expect(calls[0]![1]?.cache).toBe("no-store");
    expect(calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    const down = (async () =>
      new Response("", { status: 502 })) as unknown as typeof fetch;
    expect(await webReachable(down)).toBe(false);
    // The network is gone though the browser still reports one.
    const failing = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    expect(await webReachable(failing)).toBe(false);
  });

  it("does not even ask while the browser reports no network", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await webReachable(fetcher as unknown as typeof fetch)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
