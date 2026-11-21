import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_API_SCHEMA_VERSION,
  CUSTOM_API_UPGRADES,
  CustomApiDefinitionError,
  customApiDefinitionSchema,
  readStoredCustomApiDefinition,
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

  it.each<[unknown, string, string]>([
    [null, "not_an_object", ""],
    [[], "not_an_object", ""],
    ["x", "not_an_object", ""],
    [{ schemaVersion: "1" }, "unsupported_schema_version", "schemaVersion"],
    [{ schemaVersion: 0 }, "unsupported_schema_version", "schemaVersion"],
    [{ schemaVersion: 1.5 }, "unsupported_schema_version", "schemaVersion"],
    [{}, "unsupported_schema_version", "schemaVersion"],
  ])("refuses %j with one issue to mark", (raw, code, path) => {
    try {
      upgradeCustomApiDefinition(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CustomApiDefinitionError);
      const e = error as CustomApiDefinitionError;
      expect(e.code).toBe(code);
      expect(e.issues).toEqual([{ path, code: "invalid", message: e.message }]);
    }
  });

  it("refuses an oversized document before parsing it", () => {
    const raw = {
      ...fixture("v1-shop"),
      // Unknown and over the size limit: only the size is reported, so the
      // parse never ran.
      padding: "x".repeat(300_000),
    };
    try {
      upgradeCustomApiDefinition(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid",
        issues: [{ path: "", code: "document_too_large" }],
      });
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

describe("readStoredCustomApiDefinition", () => {
  it("reads a stored document a later rule rejects", () => {
    // Saved before secret variables could not be named like a credential.
    const stored = {
      ...fixture("v1-shop"),
      variables: [{ id: "token", label: "Token", secret: true }],
    };
    expect(() => upgradeCustomApiDefinition(stored)).toThrow(
      CustomApiDefinitionError,
    );
    const read = readStoredCustomApiDefinition(stored);
    expect(read.variables).toEqual([
      { id: "token", label: "Token", secret: true },
    ]);
    expect(read.defaults.timeZone).toBe("UTC");
  });

  it("still refuses a document without the shape", () => {
    expect(() =>
      readStoredCustomApiDefinition({ ...fixture("v1-shop"), streams: 3 }),
    ).toThrow(CustomApiDefinitionError);
    expect(() => readStoredCustomApiDefinition({ schemaVersion: 9 })).toThrow(
      expect.objectContaining({ code: "unsupported_schema_version" }),
    );
  });
});
