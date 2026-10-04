import { describe, expect, it } from "vitest";

import { builtinThemeName, copyName } from "./theme-name";

describe("copyName", () => {
  it("names the first copy after the built-in", () => {
    expect(copyName("Paper", [], "en")).toBe("Copy of Paper");
    expect(copyName("Papier", [], "de")).toBe("Kopie von Papier");
  });

  it("numbers further copies, ignoring case", () => {
    expect(copyName("Paper", ["copy of paper", "Copy of Paper 2"], "en")).toBe(
      "Copy of Paper 3",
    );
    expect(copyName("Papier", ["kopie von papier"], "de")).toBe(
      "Kopie von Papier 2",
    );
  });
});

describe("builtinThemeName", () => {
  it("names built-in themes by key in each language", () => {
    expect(builtinThemeName("high_contrast", "en")).toBe("High contrast");
    expect(builtinThemeName("high_contrast", "de")).toBe("Hoher Kontrast");
    expect(builtinThemeName("netrics_dark", "de")).toBe("netrics Dunkel");
  });
});
