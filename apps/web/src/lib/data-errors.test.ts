import { describe, expect, it } from "vitest";
import { dataErrorCodeKey } from "./data-errors";

describe("data error keys", () => {
  it("maps builder_incomplete to builderIncomplete", () => {
    expect(dataErrorCodeKey("builder_incomplete")).toBe("builderIncomplete");
    expect(dataErrorCodeKey("formula_syntax_invalid")).toBe("formula");
  });
  it("gives a column of the wrong type in a calculation its own message (#629)", () => {
    expect(dataErrorCodeKey("expression_numeric_required")).toBe("numeric");
    expect(dataErrorCodeKey("expression_units_incompatible")).toBe("units");
  });
});
