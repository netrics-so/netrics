import { describe, expect, it } from "vitest";
import type { DataExpression } from "@netrics/domain";

import { fixedFilterValues } from "./freshness.js";

// The values a widget's own filter fixes (#784 review), which freshness
// treats like a scope.
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const text = (value: string): DataExpression => ({
  kind: "literal",
  type: "string",
  value,
});
const call = (fn: string, ...args: DataExpression[]): DataExpression =>
  ({ kind: "call", fn, args }) as DataExpression;

describe("fixedFilterValues", () => {
  it("reads eq and in, alone or joined by and", () => {
    expect(
      fixedFilterValues(call("eq", field("store"), text("google"))),
    ).toEqual(new Map([["store", ["google"]]]));
    expect(
      fixedFilterValues(
        call(
          "and",
          call("in", field("app"), text("a"), text("b")),
          call("eq", field("store"), text("apple")),
          call("eq", field("app"), text("b")),
        ),
      ),
    ).toEqual(
      new Map([
        ["app", ["b"]],
        ["store", ["apple"]],
      ]),
    );
  });
  it("ignores what fixes nothing", () => {
    expect(fixedFilterValues(undefined).size).toBe(0);
    expect(
      fixedFilterValues(
        call(
          "or",
          call("eq", field("store"), text("google")),
          call("eq", field("store"), text("apple")),
        ),
      ).size,
    ).toBe(0);
    expect(
      fixedFilterValues(call("ne", field("store"), text("google"))).size,
    ).toBe(0);
  });
});
