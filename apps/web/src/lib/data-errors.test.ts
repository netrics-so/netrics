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
  it("gives time grain refusals their own messages (#838)", () => {
    expect(dataErrorCodeKey("dashboard_measure_grain_unsupported")).toBe(
      "grainUnsupported",
    );
    expect(dataErrorCodeKey("model_group_grain_window_unsupported")).toBe(
      "grainUnsupported",
    );
    for (const code of [
      "dashboard_measure_grain_invalid",
      "model_group_grain_invalid",
      "model_group_grain_not_grouped",
      "model_group_grain_not_temporal",
    ])
      expect(dataErrorCodeKey(code), code).toBe("grainInvalid");
    expect(dataErrorCodeKey("dashboard_interaction_grain_unsupported")).toBe(
      "interactionGrain",
    );
    // The measure-scope code that looks alike keeps its own.
    expect(dataErrorCodeKey("model_measure_grain_invalid")).toBe("scope");
    expect(dataErrorCodeKey("dashboard_interaction_view_unsupported")).toBe(
      "interaction",
    );
  });
  it("says a widget's own period needs a reporting date (#784)", () => {
    expect(dataErrorCodeKey("dashboard_measure_period_unsupported")).toBe(
      "periodUnsupported",
    );
  });
});
