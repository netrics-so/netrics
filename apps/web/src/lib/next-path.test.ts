import { describe, expect, it } from "vitest";

import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
    expect(safeNextPath("/workspaces/1?tab=x")).toBe("/workspaces/1?tab=x");
  });

  it("rejects anything that could leave the origin", () => {
    for (const value of [
      "//evil.example.com",
      "https://evil.example.com",
      "/\\evil.example.com",
      "evil",
      "",
      undefined,
      ["/a"],
    ]) {
      expect(safeNextPath(value)).toBeNull();
    }
  });
});
