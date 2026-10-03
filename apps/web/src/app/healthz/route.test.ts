import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/healthz", () => {
  it("reports ok with the build's version and commit, uncached", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "0.4.0");
    vi.stubEnv(
      "NEXT_PUBLIC_GIT_SHA",
      "4c7a90210b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
    );
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      version: "0.4.0",
      commit: "4c7a90210b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
    });
  });

  it.each([undefined, ""])(
    "falls back to stable placeholders when the build has none (%j)",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_APP_VERSION", value);
      vi.stubEnv("NEXT_PUBLIC_GIT_SHA", value);
      expect(await GET().json()).toEqual({
        status: "ok",
        version: "0.0.0-dev",
        commit: "dev",
      });
    },
  );
});
