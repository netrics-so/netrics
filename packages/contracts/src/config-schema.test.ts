import { describe, expect, it } from "vitest";

import {
  parseConfigSchema,
  validateConnectionConfig,
} from "./config-schema.js";

const schema = {
  type: "object",
  properties: {
    region: { type: "string", enum: ["eu", "us"], default: "eu" },
    days: { type: "integer", minimum: 1, maximum: 90 },
    ratio: { type: "number" },
    verbose: { type: "boolean" },
    note: {},
  },
  required: ["days"],
  additionalProperties: false,
};

describe("validateConnectionConfig", () => {
  it("applies defaults and accepts a valid config", () => {
    expect(validateConnectionConfig(schema, { days: 7 })).toEqual({
      ok: true,
      config: { region: "eu", days: 7 },
    });
  });

  it.each([
    [{}, 'missing required config property "days"'],
    [{ days: 7, extra: 1 }, 'unknown config property "extra"'],
    [{ days: 1.5 }, "days must be an integer"],
    [{ days: 0 }, "days must be at least 1"],
    [{ days: 91 }, "days must be at most 90"],
    [{ days: 7, region: "ap" }, "region must be one of: eu, us"],
    [{ days: 7, ratio: Number.NaN }, "ratio must be a number"],
    [{ days: 7, verbose: "yes" }, "verbose must be a boolean"],
    [{ days: 7, region: 1 }, "region must be a string"],
  ])("rejects %j", (config, message) => {
    expect(validateConnectionConfig(schema, config)).toEqual({
      ok: false,
      message,
    });
  });

  it("allows unknown keys unless additionalProperties is false", () => {
    const open = { ...schema, additionalProperties: undefined };
    expect(validateConnectionConfig(open, { days: 7, extra: 1 }).ok).toBe(true);
  });

  it("treats a property without a type as unconstrained", () => {
    expect(validateConnectionConfig(schema, { days: 7, note: 42 }).ok).toBe(
      true,
    );
  });
});

describe("parseConfigSchema", () => {
  it("reads the same subset as form fields", () => {
    expect(parseConfigSchema(schema)).toEqual([
      {
        key: "region",
        type: "string",
        enumValues: ["eu", "us"],
        required: false,
        defaultValue: "eu",
      },
      { key: "days", type: "integer", required: true, minimum: 1, maximum: 90 },
      { key: "ratio", type: "number", required: false },
      { key: "verbose", type: "boolean", required: false },
      { key: "note", type: "string", required: false },
    ]);
  });
});
