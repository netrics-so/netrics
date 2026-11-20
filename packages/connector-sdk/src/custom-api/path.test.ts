import { describe, expect, it } from "vitest";

import {
  DATA_PATH_MAX_SEGMENTS,
  DataPathError,
  formatDataPath,
  parseDataPath,
  readDataPath,
  type DataPathSegment,
} from "./path.js";

describe("parseDataPath", () => {
  it.each<[string, DataPathSegment[]]>([
    ["", []],
    ["data", [{ key: "data" }]],
    ["meta.next", [{ key: "meta" }, { key: "next" }]],
    ["items[0].url", [{ key: "items" }, { index: 0 }, { key: "url" }]],
    [
      'data["first name"][2]',
      [{ key: "data" }, { key: "first name" }, { index: 2 }],
    ],
    ["[0]", [{ index: 0 }]],
    ['["a.b"].c', [{ key: "a.b" }, { key: "c" }]],
    ["a[1][2]", [{ key: "a" }, { index: 1 }, { index: 2 }]],
    ["$ref-id_2", [{ key: "$ref-id_2" }]],
  ])("parses %s", (path, segments) =>
    expect(parseDataPath(path)).toEqual(segments),
  );

  it.each([
    "data.",
    ".data",
    "a..b",
    "a[-1]",
    "a[01x]",
    "a[01]",
    'a["x',
    'a["x"',
    "a[]",
    "a b",
    "a.b c",
    'a["\\n"]',
    "__proto__",
    "a.constructor",
    'a["prototype"]',
    "a[99999999999]",
  ])("rejects %s", (path) =>
    expect(() => parseDataPath(path)).toThrow(DataPathError),
  );

  it("rejects more than 32 segments", () => {
    const ok = Array.from({ length: DATA_PATH_MAX_SEGMENTS }, () => "a").join(
      ".",
    );
    expect(parseDataPath(ok)).toHaveLength(DATA_PATH_MAX_SEGMENTS);
    expect(() => parseDataPath(`${ok}.a`)).toThrow(DataPathError);
    expect(() => parseDataPath(`${ok}[0]`)).toThrow(DataPathError);
  });

  it("never echoes the input in its error", () => {
    const path = "sk_live_secret value";
    try {
      parseDataPath(path);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("sk_live");
    }
  });
});

describe("formatDataPath", () => {
  it.each([
    "",
    "data",
    "meta.next",
    "items[0].url",
    'data["first name"][2]',
    "[3]",
    '["a.b"]',
    '["say \\"hi\\""].x',
    '["back\\\\slash"]',
    '[""]',
  ])("round-trips %s", (path) => {
    const segments = parseDataPath(path);
    expect(formatDataPath(segments)).toBe(path);
    expect(parseDataPath(formatDataPath(segments))).toEqual(segments);
  });

  it("quotes keys outside the name characters", () =>
    expect(
      formatDataPath([{ key: "data" }, { key: "first name" }, { index: 0 }]),
    ).toBe('data["first name"][0]'));
});

describe("readDataPath", () => {
  it("reads own properties and indexes only", () => {
    const value = JSON.parse('{"a":[{"b":1}],"__proto__":{"x":1}}');
    expect(readDataPath(value, parseDataPath("a[0].b"))).toBe(1);
    expect(readDataPath(value, parseDataPath("a[1].b"))).toBeUndefined();
    expect(readDataPath({}, parseDataPath("toString"))).toBeUndefined();
    expect(readDataPath(value, [{ key: "__proto__" }])).toBeUndefined();
    expect(readDataPath(value, [{ key: "x" }])).toBeUndefined();
  });

  it("returns the root for the empty path", () => {
    const value = { a: 1 };
    expect(readDataPath(value, parseDataPath(""))).toBe(value);
  });

  it("does not read keys on arrays or indexes on objects", () => {
    expect(readDataPath([1, 2], parseDataPath("length"))).toBeUndefined();
    expect(readDataPath({ 0: "x" }, parseDataPath("[0]"))).toBeUndefined();
    expect(readDataPath("text", parseDataPath("length"))).toBeUndefined();
    expect(readDataPath(null, parseDataPath("a"))).toBeUndefined();
  });

  it("keeps null values distinct from absence", () =>
    expect(readDataPath({ a: null }, parseDataPath("a"))).toBeNull());
});
