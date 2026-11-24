import { describe, expect, it } from "vitest";

import {
  isKnownServiceStateValue,
  isServiceStateHealthy,
  normalizeServiceState,
  serviceStateCounts,
  serviceStateHiddenTone,
  serviceStateIcon,
  serviceStateKey,
  serviceStateSummary,
  serviceStateRank,
  serviceStateRowsShown,
  serviceStateTone,
  sortServiceStateItems,
  SERVICE_STATES,
  type ServiceState,
} from "./service-state.js";

describe("normalizeServiceState (#875)", () => {
  it("keeps the connectors' own words", () => {
    for (const state of SERVICE_STATES)
      expect(normalizeServiceState(state)).toBe(state);
  });

  it("reads provider statuses and common synonyms, in any case", () => {
    const cases: Array<[unknown, ServiceState]> = [
      ["running", "up"],
      ["SUCCESS", "up"],
      ["READY", "up"],
      [" Healthy ", "up"],
      ["offline", "down"],
      ["stopped", "down"],
      ["ERROR", "failed"],
      ["CRASHED", "failed"],
      ["In progress", "building"],
      ["in-progress", "building"],
      ["QUEUED", "building"],
      ["SLEEPING", "sleeping"],
      ["paused", "sleeping"],
    ];
    for (const [value, state] of cases)
      expect(normalizeServiceState(value), String(value)).toBe(state);
  });

  it("reads a boolean as a health flag", () => {
    expect(normalizeServiceState(true)).toBe("up");
    expect(normalizeServiceState(false)).toBe("down");
  });

  it("answers unknown for anything else", () => {
    for (const value of [
      null,
      undefined,
      "",
      "  ",
      "purple",
      {},
      [],
      "__proto__",
    ])
      expect(normalizeServiceState(value)).toBe("unknown");
    expect(normalizeServiceState("constructor")).toBe("unknown");
  });

  it("applies the widget's overrides first, keys compared loosely", () => {
    const overrides = { "Degraded Performance": "failed", ok: "down" } as const;
    expect(normalizeServiceState("degraded performance", overrides)).toBe(
      "failed",
    );
    expect(normalizeServiceState("degraded-performance", overrides)).toBe(
      "failed",
    );
    // An override wins over a built-in word.
    expect(normalizeServiceState("OK", overrides)).toBe("down");
    expect(normalizeServiceState(false, { false: "sleeping" })).toBe(
      "sleeping",
    );
    expect(normalizeServiceState(503, { "503": "down" })).toBe("down");
  });

  it("says which values need an override", () => {
    expect(isKnownServiceStateValue("Running")).toBe(true);
    expect(isKnownServiceStateValue(true)).toBe(true);
    expect(isKnownServiceStateValue("degraded")).toBe(false);
    expect(isKnownServiceStateValue(null)).toBe(false);
    expect(serviceStateKey(" In  Progress ")).toBe("in_progress");
  });
});

describe("state order, tone and icon (#875)", () => {
  it("ranks problems first and a rollback before a plain up", () => {
    const order = [
      serviceStateRank("down"),
      serviceStateRank("failed"),
      serviceStateRank("unknown"),
      serviceStateRank("building"),
      serviceStateRank("sleeping"),
      serviceStateRank("up", true),
      serviceStateRank("up"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  it("is healthy only when up without a rollback", () => {
    expect(isServiceStateHealthy("up")).toBe(true);
    expect(isServiceStateHealthy("up", true)).toBe(false);
    expect(isServiceStateHealthy("sleeping")).toBe(false);
  });

  it("gives every state a distinct icon and a tone", () => {
    const icons = SERVICE_STATES.map(serviceStateIcon);
    expect(new Set(icons).size).toBe(SERVICE_STATES.length);
    expect(serviceStateTone("up")).toBe("up");
    expect(serviceStateTone("up", true)).toBe("warning");
    expect(serviceStateTone("failed")).toBe("down");
    expect(serviceStateTone("down")).toBe("down");
    expect(serviceStateTone("building")).toBe("muted");
    expect(serviceStateTone("unknown")).toBe("warning");
  });

  it("sorts by rank, then by name, nameless last", () => {
    const item = (
      name: string | null,
      state: ServiceState,
      rolledBack = false,
    ) => ({ name, state, rolledBack });
    const sorted = sortServiceStateItems([
      item("web", "up"),
      item("api", "up"),
      item("Worker", "failed"),
      item(null, "failed"),
      item("db", "down"),
      item("site", "up", true),
      item("cron", "building"),
      item("Api", "up"),
    ]);
    expect(sorted.map((entry) => `${entry.name}:${entry.state}`)).toEqual([
      "db:down",
      "Worker:failed",
      "null:failed",
      "cron:building",
      "site:up",
      "Api:up",
      "api:up",
      "web:up",
    ]);
  });
});

describe("serviceStateRowsShown (#875)", () => {
  it("shows every item that fits", () => {
    expect(serviceStateRowsShown(3, 3, 5)).toEqual({ rows: 3, more: 0 });
    expect(serviceStateRowsShown(5, 5, 5)).toEqual({ rows: 5, more: 0 });
  });

  it("turns the last row into +N more when items do not fit", () => {
    expect(serviceStateRowsShown(8, 8, 5)).toEqual({ rows: 4, more: 4 });
    expect(serviceStateRowsShown(2, 2, 1)).toEqual({ rows: 0, more: 2 });
  });

  it("counts items the server left out beyond its limit", () => {
    expect(serviceStateRowsShown(5, 7, 10)).toEqual({ rows: 5, more: 2 });
    expect(serviceStateRowsShown(5, 7, 5)).toEqual({ rows: 4, more: 3 });
  });

  it("shows nothing without room", () => {
    expect(serviceStateRowsShown(3, 3, 0)).toEqual({ rows: 0, more: 0 });
  });
});

describe("counts, summary and the hidden tone (#875 review)", () => {
  const item = (state: ServiceState, rolledBack = false) => ({
    name: "x",
    state,
    rolledBack,
  });
  const counts = (patch: Partial<ReturnType<typeof serviceStateCounts>>) => ({
    ...serviceStateCounts([]),
    ...patch,
  });

  it("counts every state and the rollbacks on up", () => {
    expect(
      serviceStateCounts([
        item("up"),
        item("up", true),
        item("down"),
        item("down"),
        item("building"),
      ]),
    ).toEqual({
      up: 2,
      down: 2,
      failed: 0,
      building: 1,
      sleeping: 0,
      unknown: 0,
      rolledBack: 1,
    });
  });

  it("sums up all up, else the worst state and its count", () => {
    expect(serviceStateSummary(counts({ up: 5 }))).toEqual({
      kind: "all_up",
      total: 5,
    });
    expect(
      serviceStateSummary(counts({ up: 3, down: 2, building: 1 })),
    ).toEqual({
      kind: "worst",
      state: "down",
      rolledBack: false,
      count: 2,
      total: 6,
    });
    expect(serviceStateSummary(counts({ up: 4, rolledBack: 1 }))).toEqual({
      kind: "worst",
      state: "up",
      rolledBack: true,
      count: 1,
      total: 4,
    });
    expect(serviceStateSummary(counts({}))).toBeNull();
  });

  it("tones +N more by the worst item it hides", () => {
    const all = serviceStateCounts([item("down"), item("up"), item("up")]);
    // The down item is shown: the hidden ones are up.
    expect(serviceStateHiddenTone(all, [item("down")])).toBe("up");
    // The server left the down item out.
    expect(serviceStateHiddenTone(all, [item("up")])).toBe("down");
    expect(
      serviceStateHiddenTone(all, [item("down"), item("up"), item("up")]),
    ).toBeNull();
  });
});
