import { describe, expect, it } from "vitest";

import { copyName } from "./theme-name";

describe("copyName", () => {
  it("names the first copy after the built-in", () => {
    expect(copyName("Paper", [])).toBe("Copy of Paper");
  });

  it("numbers further copies, ignoring case", () => {
    expect(copyName("Paper", ["copy of paper", "Copy of Paper 2"])).toBe(
      "Copy of Paper 3",
    );
  });
});
