import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ERROR_DISPLAY_LENGTH,
  describeAppVersion,
  isAppleTv,
  rotationKey,
  shortenError,
  summarizeHeartbeat,
  summarizeScreen,
} from "./device-heartbeat";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("describeAppVersion", () => {
  it("shows browser kiosks as reported", () => {
    expect(describeAppVersion("web 0.1.0")).toBe("web 0.1.0");
    expect(describeAppVersion("web")).toBe("web");
  });

  it("shows the Apple TV app's tvos prefix as tvOS", () => {
    expect(describeAppVersion("tvos 0.1.0")).toBe("tvOS 0.1.0");
    expect(describeAppVersion("TVOS 0.1.0")).toBe("tvOS 0.1.0");
    expect(describeAppVersion("tvos")).toBe("tvOS");
  });

  it("shows anything else unchanged", () => {
    expect(describeAppVersion("0.1.0")).toBe("0.1.0");
    expect(describeAppVersion("tvosx 1")).toBe("tvosx 1");
    expect(describeAppVersion("  custom-build ")).toBe("custom-build");
  });
});

describe("shortenError", () => {
  it("keeps short errors and puts them on one line", () => {
    expect(shortenError("HttpError: HTTP 500")).toBe("HttpError: HTTP 500");
    expect(shortenError("  line one\n\tline two\u0007 ")).toBe(
      "line one line two",
    );
  });

  it("cuts long errors with an ellipsis", () => {
    const shortened = shortenError("x".repeat(500));
    expect(Array.from(shortened)).toHaveLength(MAX_ERROR_DISPLAY_LENGTH);
    expect(shortened.endsWith("…")).toBe(true);
  });

  it("does not split a character made of two code units", () => {
    const shortened = shortenError("😀".repeat(20), 10);
    expect(shortened).toBe(`${"😀".repeat(9)}…`);
  });
});

describe("summarizeHeartbeat", () => {
  it("is null until the device sends a heartbeat", () => {
    expect(summarizeHeartbeat(null, "en")).toBeNull();
  });

  it("gives the version and how long ago the heartbeat came", () => {
    expect(
      summarizeHeartbeat(
        {
          at: new Date(NOW - 2 * 60 * 1000).toISOString(),
          appVersion: "web 0.1.0",
          uptimeSeconds: 600,
          lastError: null,
        },
        "en",
      ),
    ).toEqual({
      version: "web 0.1.0",
      at: "2 minutes ago",
      lastError: null,
      lastErrorFull: null,
    });
  });

  it("includes the last error, shortened, with the full text kept", () => {
    const error = `TypeError: fetch failed <script>alert(1)</script> ${"y".repeat(300)}`;
    const summary = summarizeHeartbeat(
      {
        at: new Date(NOW - 3 * 3600 * 1000).toISOString(),
        appVersion: "tvos 0.1.0",
        uptimeSeconds: 10,
        lastError: error,
      },
      "en",
    );
    expect(summary).toMatchObject({ version: "tvOS 0.1.0", at: "3 hours ago" });
    expect(
      summary!.lastError!.startsWith("TypeError: fetch failed <script>"),
    ).toBe(true);
    expect(Array.from(summary!.lastError!)).toHaveLength(
      MAX_ERROR_DISPLAY_LENGTH,
    );
    expect(summary!.lastErrorFull).toBe(error);
  });

  it("treats a blank error as none", () => {
    expect(
      summarizeHeartbeat(
        {
          at: new Date(NOW).toISOString(),
          appVersion: "web 0.1.0",
          uptimeSeconds: 0,
          lastError: "   ",
        },
        "en",
      ),
    ).toMatchObject({ at: "just now", lastError: null, lastErrorFull: null });
  });

  it("words the time in German", () => {
    expect(
      summarizeHeartbeat(
        {
          at: new Date(NOW - 2 * 60 * 1000).toISOString(),
          appVersion: "web 0.1.0",
          uptimeSeconds: 600,
          lastError: null,
        },
        "de",
      )?.at,
    ).toBe("vor 2 Minuten");
  });
});

describe("isAppleTv", () => {
  const beat = (appVersion: string) => ({
    at: "2026-10-02T11:58:00.000Z",
    appVersion,
    uptimeSeconds: 1,
    lastError: null,
  });

  it("recognises the Apple TV app by its tvos prefix", () => {
    expect(isAppleTv(beat("tvos 1.4 (12)"))).toBe(true);
    expect(isAppleTv(beat("TVOS"))).toBe(true);
  });

  it("treats kiosks, other apps and silent devices as not Apple TV", () => {
    expect(isAppleTv(beat("web 0.1.0"))).toBe(false);
    expect(isAppleTv(beat("tvosx 1.0"))).toBe(false);
    expect(isAppleTv(null)).toBe(false);
  });
});

describe("rotationKey", () => {
  it("names each rotation's message", () => {
    expect([0, 90, 180, 270].map((r) => rotationKey(r as 0))).toEqual([
      "r0",
      "r90",
      "r180",
      "r270",
    ]);
  });
});

describe("summarizeScreen", () => {
  it("is null until a device reports its screen", () => {
    expect(summarizeScreen(null)).toBeNull();
  });

  it("gives the sides unformatted and the format as a ratio", () => {
    expect(
      summarizeScreen({
        width: 3840,
        height: 2160,
        scale: 1,
        format: "16x9",
        mode: "screen",
      }),
    ).toEqual({
      width: "3840",
      height: "2160",
      format: "16:9",
      mode: "screen",
    });
  });

  it("leaves the format out when the device sent none", () => {
    expect(
      summarizeScreen({ width: 1080, height: 1920, scale: 2, mode: "scroll" }),
    ).toEqual({ width: "1080", height: "1920", format: null, mode: "scroll" });
  });
});
