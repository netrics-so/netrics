import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_API_SCHEMA_VERSION,
  CUSTOM_API_UPGRADES,
  CustomApiDefinitionError,
  customApiDefinitionSchema,
  upgradeCustomApiDefinition,
} from "./definition.js";

const fixturesDir = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixturesDir), "utf8"));
const fixturesFor = (version: number) =>
  readdirSync(fixturesDir)
    .filter((file) => file.startsWith(`v${version}-`) && file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));

describe("upgradeCustomApiDefinition", () => {
  it("returns a current document unchanged except defaults", () =>
    expect(upgradeCustomApiDefinition(fixture("v1-shop"))).toEqual(
      customApiDefinitionSchema.parse(fixture("v1-shop")),
    ));

  it("refuses a newer schema version", () =>
    expect(() =>
      upgradeCustomApiDefinition({ ...fixture("v1-shop"), schemaVersion: 2 }),
    ).toThrow(expect.objectContaining({ code: "unsupported_schema_version" })));

  it.each<[unknown, string]>([
    [null, "not_an_object"],
    [[], "not_an_object"],
    ["x", "not_an_object"],
    [{ schemaVersion: "1" }, "unsupported_schema_version"],
    [{ schemaVersion: 0 }, "unsupported_schema_version"],
    [{ schemaVersion: 1.5 }, "unsupported_schema_version"],
    [{}, "unsupported_schema_version"],
  ])("refuses %j", (raw, code) => {
    try {
      upgradeCustomApiDefinition(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CustomApiDefinitionError);
      expect(error).toMatchObject({ code, issues: [] });
    }
  });

  it("reports issues of an invalid current document", () => {
    try {
      upgradeCustomApiDefinition({ ...fixture("v1-shop"), environments: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CustomApiDefinitionError);
      const { code, issues } = error as CustomApiDefinitionError;
      expect(code).toBe("invalid");
      expect(issues).toContainEqual(
        expect.objectContaining({ path: "environments", code: "invalid" }),
      );
    }
  });

  it("has a fixture for every older version", () => {
    // Every key n of CUSTOM_API_UPGRADES needs fixtures/v<n>-*.json that upgrade to a valid current document.
    for (const version of Object.keys(CUSTOM_API_UPGRADES).map(Number)) {
      expect(version).toBeLessThan(CUSTOM_API_SCHEMA_VERSION);
      expect(fixturesFor(version).length).toBeGreaterThan(0);
      for (const name of fixturesFor(version))
        expect(upgradeCustomApiDefinition(fixture(name)).schemaVersion).toBe(
          CUSTOM_API_SCHEMA_VERSION,
        );
    }
    expect(fixturesFor(CUSTOM_API_SCHEMA_VERSION).length).toBeGreaterThan(0);
  });

  it("does not modify its input", () => {
    const raw = fixture("v1-all-auth");
    const before = JSON.stringify(raw);
    upgradeCustomApiDefinition(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
