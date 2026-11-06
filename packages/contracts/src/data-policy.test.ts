import { describe, expect, it } from "vitest";
import {
  dataPolicyOverrideSchema,
  parseDataPolicyDefaults,
} from "./data-policy.js";

describe("data cache policy", () => {
  it("allows explicitly disabling query snapshots without allowing zero data/execution quotas", () => {
    expect(
      parseDataPolicyDefaults({
        querySnapshotCount: 0,
        querySnapshotSeconds: 0,
      }),
    ).toMatchObject({ querySnapshotCount: 0, querySnapshotSeconds: 0 });
    for (const key of [
      "maxWorkspaceBytes",
      "maxGenerationRows",
      "queryRows",
      "queryOperations",
      "preparedCacheSeconds",
      "maxRetentionDays",
    ])
      expect(dataPolicyOverrideSchema.safeParse({ [key]: 0 }).success).toBe(
        false,
      );
    expect(
      dataPolicyOverrideSchema.safeParse({ querySnapshotCount: -1 }).success,
    ).toBe(false);
    expect(
      dataPolicyOverrideSchema.safeParse({ querySnapshotSeconds: -1 }).success,
    ).toBe(false);
  });
});
