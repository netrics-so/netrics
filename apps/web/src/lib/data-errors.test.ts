import { describe, expect, it } from "vitest";
import { dataErrorCodeKey } from "./data-errors";

describe("data error keys", () => {
  it("maps builder_incomplete to builderIncomplete", () => {
    expect(dataErrorCodeKey("builder_incomplete")).toBe("builderIncomplete");
    expect(dataErrorCodeKey("formula_syntax_invalid")).toBe("formula");
  });
});
