import { describe, expect, it } from "vitest";
import {
  dataPolicyOverrideSchema,
  parseDataPolicyDefaults,
} from "./data-policy.js";

describe("data cache policy", () => {
  it("gives connector staging its own configurable admission budget", () => {
    expect(parseDataPolicyDefaults().maxConnectorStagingBytes).toBe(
      134_217_728,
    );
    for (const budget of [0, 2_097_152, null]) {
      expect(
        parseDataPolicyDefaults({
          maxWorkspaceBytes: 4096,
          maxConnectorStagingBytes: budget,
        }),
      ).toMatchObject({
        maxWorkspaceBytes: 4096,
        maxConnectorStagingBytes: budget,
      });
    }
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        dataPolicyOverrideSchema.safeParse({
          maxConnectorStagingBytes: invalid,
        }).success,
      ).toBe(false);
  });

  it("limits pinned page sessions per caller without removing the release-wide bound", () => {
    expect(parseDataPolicyDefaults().queryPageSessionsPerCaller).toBe(10);
    for (const limit of [0, 3, null]) {
      expect(
        parseDataPolicyDefaults({
          querySnapshotCount: 100,
          queryPageSessionsPerCaller: limit,
        }),
      ).toMatchObject({
        querySnapshotCount: 100,
        queryPageSessionsPerCaller: limit,
      });
    }
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        dataPolicyOverrideSchema.safeParse({
          queryPageSessionsPerCaller: invalid,
        }).success,
      ).toBe(false);
    expect(
      parseDataPolicyDefaults({
        queryPageSessionsPerCaller: Number.MAX_SAFE_INTEGER,
      }).queryPageSessionsPerCaller,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

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
