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

describe("arrays of objects (#874)", () => {
  const listSchema = {
    type: "object",
    properties: {
      checks: {
        type: "array",
        title: "Checks",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name", minLength: 1 },
            method: { type: "string", enum: ["GET", "HEAD"], default: "GET" },
            timeout: { type: "integer", minimum: 1, maximum: 10 },
            headers: { type: "string", format: "multiline" },
          },
          required: ["name"],
        },
      },
    },
    required: ["checks"],
    additionalProperties: false,
  };

  it("validates every item and applies item defaults", () => {
    expect(
      validateConnectionConfig(listSchema, { checks: [{ name: "Site" }] }),
    ).toEqual({
      ok: true,
      config: { checks: [{ name: "Site", method: "GET" }] },
    });
  });

  it.each([
    [{ checks: "x" }, "checks must be a list"],
    [{ checks: [] }, "checks must not be empty"],
    [
      { checks: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      "checks must have at most 2 entries",
    ],
    [{ checks: ["a"] }, "checks[0] must be an object"],
    [
      { checks: [{ name: "a" }, {}] },
      'missing required config property "checks[1].name"',
    ],
    [
      { checks: [{ name: "a", extra: 1 }] },
      'unknown config property "checks[0].extra"',
    ],
    [
      { checks: [{ name: "a", method: "POST" }] },
      "checks[0].method must be one of: GET, HEAD",
    ],
    [
      { checks: [{ name: "a", timeout: 11 }] },
      "checks[0].timeout must be at most 10",
    ],
    [{ checks: [{ name: " " }] }, "checks[0].name must not be empty"],
  ])("refuses %j", (config, message) => {
    expect(validateConnectionConfig(listSchema, config)).toEqual({
      ok: false,
      message,
    });
  });

  it("refuses a list inside an item", () => {
    const nested = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", properties: { inner: { type: "array" } } },
        },
      },
    };
    expect(validateConnectionConfig(nested, { list: [{ inner: [] }] })).toEqual(
      { ok: false, message: "list[0].inner must not be a list" },
    );
  });

  it("parses the item fields for forms", () => {
    const [field] = parseConfigSchema(listSchema);
    expect(field).toMatchObject({
      key: "checks",
      label: "Checks",
      type: "array",
      required: true,
      minItems: 1,
      maxItems: 2,
    });
    expect(field?.itemFields?.map((item) => item.key)).toEqual([
      "name",
      "method",
      "timeout",
      "headers",
    ]);
    expect(field?.itemFields?.[1]?.enumValues).toEqual(["GET", "HEAD"]);
    expect(field?.itemFields?.[3]?.multiline).toBe(true);
  });
});
