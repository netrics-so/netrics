import { describe, expect, it } from "vitest";

import { scopeNeedsUpdateFirst, type StoreInstall } from "./store-updates";

const install = (values: Partial<StoreInstall>): StoreInstall => ({
  requestId: "00000000-0000-4000-8000-0000000000f1",
  name: "App portfolio",
  templateVersion: 4,
  latestVersion: 4,
  updateAvailable: false,
  newerVersion: false,
  summary: null,
  error: null,
  dashboardIds: [],
  modelIds: [],
  preparationIds: [],
  openUpdate: null,
  lastUpdate: null,
  ...values,
});

describe("changing an install's apps", () => {
  it("waits for a newer template version the dashboard is not built from yet", () => {
    // Applied v3 → v4 and closed before the swap: the install says 4, its
    // dashboard is still version 3's.
    expect(
      scopeNeedsUpdateFirst(
        install({ updateAvailable: true, newerVersion: true }),
      ),
    ).toBe(true);
    expect(
      scopeNeedsUpdateFirst(
        install({
          templateVersion: 3,
          updateAvailable: true,
          newerVersion: true,
        }),
      ),
    ).toBe(true);
  });

  it("stays open for an update that only follows changed apps", () => {
    expect(
      scopeNeedsUpdateFirst(
        install({ updateAvailable: true, newerVersion: false }),
      ),
    ).toBe(false);
    expect(scopeNeedsUpdateFirst(install({}))).toBe(false);
    expect(
      scopeNeedsUpdateFirst(
        install({
          updateAvailable: true,
          newerVersion: true,
          error: "store_template_baseline_unavailable",
        }),
      ),
    ).toBe(false);
  });
});
