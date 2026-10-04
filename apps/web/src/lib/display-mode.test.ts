import { describe, expect, it } from "vitest";

import {
  DISPLAY_MODE_STORAGE_KEY,
  initialDisplayMode,
  readDisplayMode,
  writeDisplayMode,
  type ModeStorage,
} from "./display-mode";

function memoryStorage(): ModeStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwing: ModeStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("display mode default (ADR 0017, section 5)", () => {
  const cases: Array<[string, number, number, boolean, "scroll" | "screen"]> = [
    ["phone portrait", 360, 800, true, "scroll"],
    ["phone (iPhone 14)", 390, 844, true, "scroll"],
    ["phone landscape", 844, 390, true, "scroll"],
    ["tablet portrait", 820, 1180, true, "scroll"],
    ["tablet landscape", 1180, 820, true, "scroll"],
    ["iPad Pro 12.9 portrait", 1024, 1366, true, "scroll"],
    ["large touch screen", 1920, 1200, true, "screen"],
    ["desktop", 1440, 900, false, "screen"],
    ["small desktop window", 800, 700, false, "screen"],
    ["laptop 1280 × 800", 1280, 800, false, "screen"],
  ];
  it.each(cases)("%s (%i × %i) starts in %s view", (_, w, h, coarse, mode) => {
    expect(
      initialDisplayMode({
        stored: null,
        width: w,
        height: h,
        coarsePointer: coarse,
      }),
    ).toBe(mode);
  });

  it("the viewer's remembered choice wins over the default", () => {
    expect(
      initialDisplayMode({
        stored: "screen",
        width: 390,
        height: 844,
        coarsePointer: true,
      }),
    ).toBe("screen");
    expect(
      initialDisplayMode({
        stored: "scroll",
        width: 1440,
        height: 900,
        coarsePointer: false,
      }),
    ).toBe("scroll");
  });
});

describe("remembering the choice per browser", () => {
  it("writes and reads the mode under one key", () => {
    const storage = memoryStorage();
    expect(readDisplayMode(storage)).toBeNull();
    writeDisplayMode(storage, "scroll");
    expect(storage.data.get(DISPLAY_MODE_STORAGE_KEY)).toBe("scroll");
    expect(readDisplayMode(storage)).toBe("scroll");
    writeDisplayMode(storage, "screen");
    expect(readDisplayMode(storage)).toBe("screen");
  });

  it("ignores values that are not a mode", () => {
    const storage = memoryStorage();
    storage.data.set(DISPLAY_MODE_STORAGE_KEY, "glance");
    expect(readDisplayMode(storage)).toBeNull();
  });

  it("survives a storage that is missing or throws", () => {
    expect(readDisplayMode(null)).toBeNull();
    expect(readDisplayMode(throwing)).toBeNull();
    expect(() => writeDisplayMode(throwing, "scroll")).not.toThrow();
    expect(() => writeDisplayMode(null, "scroll")).not.toThrow();
  });
});
