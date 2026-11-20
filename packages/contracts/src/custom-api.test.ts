import { describe, expect, it } from "vitest";

import * as subpath from "@netrics/connector-sdk/custom-api";

import * as contracts from "./index.js";

describe("custom API contracts", () => {
  it("imports from @netrics/contracts", () => {
    for (const name of [
      "CUSTOM_API_SCHEMA_VERSION",
      "CUSTOM_API_LIMITS",
      "CUSTOM_API_ISSUE_CODES",
      "CustomApiDefinitionError",
      "customApiDefinitionSchema",
      "customApiIssues",
      "upgradeCustomApiDefinition",
      "customApiEnvironmentSchema",
      "customApiVariableSchema",
      "customApiAuthSchema",
      "customApiFieldSchema",
      "customApiPaginationSchema",
      "customApiWindowSchema",
      "customApiStreamSchema",
    ] as const) {
      expect(contracts[name], name).toBeDefined();
      expect(contracts[name], name).toBe(subpath[name]);
    }
  });
});
