import { describe, expect, it, vi } from "vitest";
import {
  DATASET_LIMITS,
  validateDatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";

import {
  retainSalesRows,
  salesDataset,
  syncSalesDataset,
} from "./sales-dataset.js";
import { parseSalesReport } from "./sales-report.js";
import { buildReport, reportFixture } from "./test-helpers.js";

const DAY = Date.parse("2026-10-01T00:00:00.000Z");
const request: SyncRequest = {
  mode: "incremental",
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-02T12:00:00.000Z",
  resources: ["101", "102"],
};
function rows(count: number, app = "101", extra: Record<string, string> = {}) {
  return parseSalesReport(
    buildReport(
      Array.from({ length: count }, (_, i) => ({
        SKU: `sku-${i}`,
        "Apple Identifier": app,
        "Product Type Identifier": "1F",
        Units: "1",
        "Developer Proceeds": "0.70",
        "Currency of Proceeds": "EUR",
        ...extra,
      })),
    ),
  );
}
function scope(count: number, apps = ["101", "102"]) {
  return retainSalesRows(
    new Map([[DAY, rows(count)]]),
    DAY,
    DAY + 86_400_000,
    new Map(),
    apps,
    new Set(apps),
  )!;
}
const result = {
  observations: [
    {
      metricKey: "app_store_connect.downloads",
      sourceTimestamp: "2026-10-01T00:00:00.000Z",
      value: 1001,
      dimensions: { resource: "101" },
    },
  ],
  done: true,
  nextCursor: "2026-09-29T00:00:00.000Z",
};

describe("retained sales provider records", () => {
  it("retains unknown columns/types, exact refund factors, and legitimate duplicate rows", () => {
    const source = parseSalesReport(
      reportFixture("sales-2026-09-27-reordered"),
    );
    expect(source[0]?.providerFields["Future Column"]).toBe("x");
    const refund = rows(1, "101", {
      Units: "-0002.00",
      "Developer Proceeds": "+000.700000",
      "Product Type Identifier": "FUTURE_TYPE",
    })[0]!;
    const retained = retainSalesRows(
      new Map([[DAY, [refund, refund, ...source]]]),
      DAY,
      DAY + 86_400_000,
      new Map(),
      ["101"],
      new Set(["101"]),
    )!;
    const records = retained.records.get("101")!;
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.values)).toEqual([
      expect.objectContaining({
        units: "-2.00",
        developer_proceeds_per_unit: "0.700000",
        product_type: "FUTURE_TYPE",
        provider_fields: expect.objectContaining({
          Units: "-0002.00",
          "Developer Proceeds": "+000.700000",
        }),
      }),
      expect.objectContaining({ units: "-2.00" }),
    ]);
    expect(new Set(records.map((r) => r.values.row_id)).size).toBe(2);
    expect(salesDataset.retentionDays).toBeNull();
  });

  it("maps purchases/restores by parent SKU and retains unmapped records only for account-wide scope", () => {
    const provider = rows(1, "901", {
      "Parent Identifier": "PARENT",
      "Product Type Identifier": "IA1",
    });
    const published = new Map([[DAY, provider]]);
    expect(
      retainSalesRows(
        published,
        DAY,
        DAY + 86_400_000,
        new Map([["PARENT", "101"]]),
        ["101"],
        new Set(["101"]),
      )?.records.get("101"),
    ).toHaveLength(1);
    expect(
      retainSalesRows(
        published,
        DAY,
        DAY + 86_400_000,
        new Map(),
        ["101"],
        new Set(["101"]),
      )?.records.get("101"),
    ).toHaveLength(0);
    const all = retainSalesRows(
      published,
      DAY,
      DAY + 86_400_000,
      new Map(),
      ["101"],
      undefined,
    )!;
    expect(all.records.get("__unmapped")).toHaveLength(1);
  });

  it("treats a blank proceeds currency as explicitly unspecified and rejects duplicate columns", () => {
    const retained = retainSalesRows(
      new Map([
        [
          DAY,
          rows(1, "101", {
            "Currency of Proceeds": "",
            "Developer Proceeds": "",
          }),
        ],
      ]),
      DAY,
      DAY + 86_400_000,
      new Map(),
      ["101"],
      new Set(["101"]),
    )!;
    expect(retained.records.get("101")?.[0]?.values).toMatchObject({
      currency: "XXX",
      developer_proceeds_per_unit: "0",
      provider_fields: expect.objectContaining({ "Currency of Proceeds": "" }),
    });
    expect(() => parseSalesReport(buildReport([]) + "\tUnits")).toThrow(
      "duplicate",
    );
  });
});

describe("paged app/window replacement", () => {
  it("pins the reporting window, preserves page predecessors and clears an app's empty partition", async () => {
    const read = vi.fn(async (_request: SyncRequest) => ({
      result,
      scope: scope(1001),
    }));
    let cursor: string | undefined;
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const page = await syncSalesDataset(
        {
          ...request,
          to: i === 0 ? request.to : "2026-11-05T00:00:00.000Z",
          cursor,
        },
        read,
      );
      pages.push(page);
      cursor = page.nextCursor;
      expect(page.datasetPages).toHaveLength(1);
      validateDatasetPage(salesDataset, page.datasetPages![0]!);
    }
    expect(
      pages.map((p) => [
        p.datasetPages![0]!.records.length,
        p.datasetPages![0]!.complete,
        p.done,
      ]),
    ).toEqual([
      [1000, false, false],
      [1, true, false],
      [0, true, true],
    ]);
    expect(pages[1]!.datasetPages![0]).toMatchObject({
      pageKey: "1000",
      previousPageKey: "0",
      refreshKey: pages[0]!.datasetPages![0]!.refreshKey,
      window: { partition: { app_id: "101" } },
    });
    expect(pages[2]!.datasetPages![0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      window: { partition: { app_id: "102" } },
    });
    expect(pages.at(-1)!.observations).toEqual(result.observations);
    expect(pages.at(-1)!.nextCursor).toBe(result.nextCursor);
    expect(read.mock.calls[1]?.[0].to).toBe(request.to);
  });

  it("restarts an unfinished app partition if Apple changes its report", async () => {
    const first = await syncSalesDataset(request, async () => ({
      result,
      scope: scope(1001),
    }));
    const correction = scope(1001);
    correction.records.get("101")![0]!.values.units = "2";
    const second = await syncSalesDataset(
      { ...request, cursor: first.nextCursor },
      async () => ({ result, scope: correction }),
    );
    expect(second.datasetPages![0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: false,
    });
    expect(second.datasetPages![0]!.refreshKey).not.toBe(
      first.datasetPages![0]!.refreshKey,
    );
    expect(second.datasetPages![0]!.records[0]!.values.units).toBe("2");
  });

  it("restarts scope safely when selection changes without deleting a deselected app's history", async () => {
    const first = await syncSalesDataset(request, async () => ({
      result,
      scope: scope(1001),
    }));
    const selected = {
      ...request,
      resources: ["102"],
      cursor: first.nextCursor,
    };
    const second = await syncSalesDataset(selected, async () => ({
      result,
      scope: scope(0, ["102"]),
    }));
    expect(second.datasetPages![0]).toMatchObject({
      pageKey: "0",
      previousPageKey: null,
      complete: true,
      records: [],
      window: { partition: { app_id: "102" } },
    });
  });

  it("pages by byte budget as well as record count and rejects oversized records", async () => {
    const large = scope(600, ["101"]);
    for (const row of large.records.get("101")!)
      (row.values.provider_fields as Record<string, string>).Extra = "x".repeat(
        2000,
      );
    const page = await syncSalesDataset(request, async () => ({
      result,
      scope: large,
    }));
    expect(page.datasetPages![0]!.records.length).toBeLessThan(600);
    expect(
      Buffer.byteLength(JSON.stringify(page.datasetPages![0])),
    ).toBeLessThan(DATASET_LIMITS.pageBytes);
    validateDatasetPage(salesDataset, page.datasetPages![0]!);
    (
      large.records.get("101")![0]!.values.provider_fields as Record<
        string,
        string
      >
    ).Extra = "x".repeat(DATASET_LIMITS.rowBytes);
    await expect(
      syncSalesDataset(request, async () => ({ result, scope: large })),
    ).rejects.toThrow("transport record budget");
  });
});
