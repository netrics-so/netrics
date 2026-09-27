import { describe, expect, it } from "vitest";

import {
  compareSemver,
  parseRange,
  parseSemver,
  satisfiesRange,
} from "./semver.js";

describe("parseSemver", () => {
  it("parses plain versions", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseSemver("10.20.30")).toEqual({
      major: 10,
      minor: 20,
      patch: 30,
    });
  });

  it("rejects non-semver input", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("1.2.x")).toBeNull();
    expect(parseSemver("1.2.3-beta")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    const a = { major: 1, minor: 2, patch: 3 };
    expect(compareSemver(a, a)).toBe(0);
    expect(compareSemver(a, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
    expect(compareSemver(a, { major: 1, minor: 3, patch: 0 })).toBeLessThan(0);
    expect(compareSemver(a, { major: 1, minor: 2, patch: 4 })).toBeLessThan(0);
    expect(compareSemver(a, { major: 0, minor: 9, patch: 9 })).toBeGreaterThan(
      0,
    );
  });
});

describe("parseRange", () => {
  it("parses exact versions", () => {
    expect(parseRange("1.2.3")).toEqual([
      { operator: "=", version: { major: 1, minor: 2, patch: 3 } },
    ]);
  });

  it("parses caret ranges with semver upper bounds", () => {
    expect(parseRange("^1.2.3")).toEqual([
      { operator: ">=", version: { major: 1, minor: 2, patch: 3 } },
      { operator: "<", version: { major: 2, minor: 0, patch: 0 } },
    ]);
    expect(parseRange("^0.2.3")).toEqual([
      { operator: ">=", version: { major: 0, minor: 2, patch: 3 } },
      { operator: "<", version: { major: 0, minor: 3, patch: 0 } },
    ]);
    expect(parseRange("^0.0.3")).toEqual([
      { operator: ">=", version: { major: 0, minor: 0, patch: 3 } },
      { operator: "<", version: { major: 0, minor: 0, patch: 4 } },
    ]);
  });

  it("parses comparator sets", () => {
    expect(parseRange(">=1.2.3 <2.0.0")).toEqual([
      { operator: ">=", version: { major: 1, minor: 2, patch: 3 } },
      { operator: "<", version: { major: 2, minor: 0, patch: 0 } },
    ]);
    expect(parseRange(">1.0.0 <=1.5.0")).toEqual([
      { operator: ">", version: { major: 1, minor: 0, patch: 0 } },
      { operator: "<=", version: { major: 1, minor: 5, patch: 0 } },
    ]);
  });

  it("rejects unsupported range syntax", () => {
    expect(parseRange("")).toBeNull();
    expect(parseRange("   ")).toBeNull();
    expect(parseRange("*")).toBeNull();
    expect(parseRange("1.x")).toBeNull();
    expect(parseRange("~1.2.3")).toBeNull();
    expect(parseRange("^1.2")).toBeNull();
    expect(parseRange(">=1.2.3 || <1.0.0")).toBeNull();
    expect(parseRange(">=1.2.3,")).toBeNull();
  });
});

describe("satisfiesRange", () => {
  it("accepts exact matches only", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
    expect(satisfiesRange("1.2.2", "1.2.3")).toBe(false);
  });

  it("applies caret semantics", () => {
    expect(satisfiesRange("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfiesRange("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesRange("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfiesRange("0.2.5", "^0.2.3")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("applies comparator sets", () => {
    expect(satisfiesRange("1.5.0", ">=1.2.3 <2.0.0")).toBe(true);
    expect(satisfiesRange("1.2.3", ">=1.2.3 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.2.3 <2.0.0")).toBe(false);
    expect(satisfiesRange("1.2.2", ">=1.2.3 <2.0.0")).toBe(false);
    expect(satisfiesRange("1.0.1", ">1.0.0 <=1.0.1")).toBe(true);
    expect(satisfiesRange("1.0.0", ">1.0.0 <=1.0.1")).toBe(false);
    expect(satisfiesRange("1.0.2", ">1.0.0 <=1.0.1")).toBe(false);
  });

  it("rejects unparseable input on either side", () => {
    expect(satisfiesRange("not-semver", "^1.2.3")).toBe(false);
    expect(satisfiesRange("1.2.3", "not-a-range")).toBe(false);
  });
});
