import { createHash } from "node:crypto";
import type { DatasetPage } from "@netrics/contracts";
import { describe, expect, it } from "vitest";

import { connectorStagePageDigest } from "./connector-staging.js";

// Stored stage pages are checked against digests written by earlier server
// versions, so the serialization behind them must not change by one byte
// (#528 rewrote it to allocate less). This is the implementation before.
function previousStable(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(previousStable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + previousStable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const previousDigest = (value: unknown) =>
  createHash("sha256").update(previousStable(value)).digest("hex");

function page(records: DatasetPage["records"]): DatasetPage {
  return {
    datasetKey: "earning_rows",
    schemaVersion: 1,
    refreshKey: "staging",
    pageKey: "0",
    previousPageKey: null,
    complete: true,
    records,
    window: {
      from: "2026-10-01",
      toExclusive: "2026-11-01",
      partition: { app_id: "com.example.app" },
    },
  };
}

describe("connector stage page digests (#528)", () => {
  it("match the previous serialization", () => {
    const pages: unknown[] = [
      page([]),
      page([
        { values: { z: "1", a: null, m: 2.5, b: true, é: "ü", "😀": "x" } },
        { values: { id: "x" }, deleted: true },
        { values: { nested: { b: [1, null, { d: "q", c: [] }], a: {} } } },
        { values: { Z: 1, a: 2, _: 3, "10": 4, "9": 5, "": 6 } },
      ]),
      { ...page([{ values: { a: "1" } }]), stagingId: undefined },
      // Shapes a validated page never has, still serialized the same way.
      Object.assign(new Array<unknown>(5), {
        0: 1,
        1: undefined,
        2: null,
        4: "x",
      }), // index 3 is a hole
      { a: undefined, b: [undefined], c: [[], {}], d: -0, e: 1e21 },
    ];
    for (const value of pages)
      expect(connectorStagePageDigest(value as DatasetPage)).toBe(
        previousDigest(value),
      );
  });

  it("match on random pages", () => {
    let seed = 528;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const text = () =>
      String.fromCharCode(
        ...Array.from(
          { length: Math.floor(random() * 6) },
          () =>
            [0x41, 0x7a, 0xe9, 0x4e2d, 0xd83d, 0xde00, 0x22, 0x5c][
              Math.floor(random() * 8)
            ]!,
        ),
      );
    const value = (depth: number): unknown => {
      const kind = Math.floor(random() * (depth > 2 ? 5 : 7));
      if (kind === 0) return null;
      if (kind === 1) return random() < 0.5;
      if (kind === 2) return Math.round(random() * 1e6) / 100;
      if (kind === 3 || kind === 4) return text();
      if (kind === 5)
        return Array.from({ length: Math.floor(random() * 4) }, () =>
          value(depth + 1),
        );
      return Object.fromEntries(
        Array.from({ length: Math.floor(random() * 4) }, () => [
          text(),
          value(depth + 1),
        ]),
      );
    };
    for (let i = 0; i < 200; i++) {
      const records = Array.from(
        { length: 1 + Math.floor(random() * 5) },
        () => ({
          values: Object.fromEntries(
            Array.from({ length: 1 + Math.floor(random() * 6) }, () => [
              text(),
              value(0),
            ]),
          ),
        }),
      );
      const p = page(records);
      expect(connectorStagePageDigest(p)).toBe(previousDigest(p));
    }
  });
});
