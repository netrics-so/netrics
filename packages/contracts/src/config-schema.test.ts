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

  it("enforces a string's minLength and maxLength in characters (#830)", () => {
    const named = {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 5 } },
    };
    expect(validateConnectionConfig(named, { name: "" })).toEqual({
      ok: false,
      message: "name must not be empty",
    });
    expect(validateConnectionConfig(named, { name: "abcdef" })).toEqual({
      ok: false,
      message: "name must be at most 5 characters",
    });
    // Counted as connectors read it, trimmed; stored as sent.
    expect(validateConnectionConfig(named, { name: "   " }).ok).toBe(false);
    expect(validateConnectionConfig(named, { name: " abcde " })).toEqual({
      ok: true,
      config: { name: " abcde " },
    });
    // Five characters, more UTF-16 units.
    expect(validateConnectionConfig(named, { name: "ab😀😀😀" }).ok).toBe(true);
    expect(
      validateConnectionConfig(
        { properties: { name: { type: "string", minLength: 3 } } },
        { name: "ab" },
      ),
    ).toEqual({ ok: false, message: "name must be at least 3 characters" });
    expect(parseConfigSchema(named)[0]).toMatchObject({
      minLength: 1,
      maxLength: 5,
    });
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
        label: "region",
        type: "string",
        enumValues: ["eu", "us"],
        required: false,
        defaultValue: "eu",
      },
      {
        key: "days",
        label: "days",
        type: "integer",
        required: true,
        minimum: 1,
        maximum: 90,
      },
      { key: "ratio", label: "ratio", type: "number", required: false },
      { key: "verbose", label: "verbose", type: "boolean", required: false },
      { key: "note", label: "note", type: "string", required: false },
    ]);
  });

  it("labels fields with their title and description", () => {
    expect(
      parseConfigSchema({
        type: "object",
        properties: {
          teamId: {
            type: "string",
            title: "Team ID",
            description: "Only for tokens that see several teams.",
          },
          empty: { type: "string", title: "", description: "" },
        },
      }),
    ).toEqual([
      {
        key: "teamId",
        label: "Team ID",
        description: "Only for tokens that see several teams.",
        type: "string",
        required: false,
      },
      { key: "empty", label: "empty", type: "string", required: false },
    ]);
  });
});
