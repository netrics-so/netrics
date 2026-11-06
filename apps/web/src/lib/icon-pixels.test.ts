import { afterEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_SIDE, readIconPixels, type PixelReader } from "./icon-pixels";

const URL_ = "/v1/workspaces/w/images/i/content?v=abc";
const PIXELS = Uint8ClampedArray.from([79, 53, 197, 255]);

function reader(overrides: Partial<PixelReader> = {}): PixelReader {
  return {
    fetch: vi.fn(async () => new Response(new Blob([new Uint8Array(4)]))),
    decode: vi.fn(async () => PIXELS),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readIconPixels (#248)", () => {
  it("fetches the image and decodes it off the DOM to a 64 × 64 sample", async () => {
    const stub = reader();
    await expect(readIconPixels(URL_, stub)).resolves.toBe(PIXELS);
    expect(stub.fetch).toHaveBeenCalledWith(URL_, {
      signal: expect.any(AbortSignal),
    });
    expect(stub.decode).toHaveBeenCalledWith(expect.any(Blob), SAMPLE_SIDE);
  });

  it("settles with null when decoding never does (a tab that is not painted)", async () => {
    vi.useFakeTimers();
    const stub = reader({ decode: () => new Promise(() => {}) });
    const result = readIconPixels(URL_, stub, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBeNull();
  });

  it("aborts a fetch that hangs and settles with null", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const stub = reader({
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
    });
    const result = readIconPixels(URL_, stub, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it("is null for an error response or an undecodable image", async () => {
    await expect(
      readIconPixels(
        URL_,
        reader({ fetch: async () => new Response("no", { status: 404 }) }),
      ),
    ).resolves.toBeNull();
    await expect(
      readIconPixels(
        URL_,
        reader({
          decode: async () => {
            throw new DOMException("bad", "InvalidStateError");
          },
        }),
      ),
    ).resolves.toBeNull();
  });
});
