import { describe, expect, it } from "vitest";

import {
  isFreshnessLate,
  isFreshnessOverdue,
  nextDueAfterSuccess,
} from "./freshness.js";
import { localizedFreshnessStreamName } from "./i18n/connector.js";

const SIX_HOURS = 6 * 60 * 60;
const at = (time: string) => new Date(`2026-11-16T${time}:00.000Z`);
const due = (
  now: string,
  rows: { expectedFrom?: string; nextExpectedAt: string | null }[],
  intervalSeconds = SIX_HOURS,
) =>
  nextDueAfterSuccess({
    now: at(now),
    intervalSeconds,
    rows: rows.map((row) => ({
      expectedFrom: row.expectedFrom ? at(row.expectedFrom) : null,
      nextExpectedAt: row.nextExpectedAt ? at(row.nextExpectedAt) : null,
    })),
  }).toISOString();

describe("nextDueAfterSuccess (ADR 0025 §5)", () => {
  it("is exactly now + interval without rows", () => {
    expect(due("09:00", [])).toBe(at("15:00").toISOString());
  });

  it("is now + interval when no row knows its next period", () => {
    expect(due("09:00", [{ nextExpectedAt: null }])).toBe(
      at("15:00").toISOString(),
    );
  });

  it("keeps the 300 s demo interval exactly, with or without rows", () => {
    expect(due("09:00", [], 300)).toBe(at("09:05").toISOString());
    // A row expected later than the interval cannot delay or advance it.
    expect(due("09:00", [{ nextExpectedAt: "12:00" }], 300)).toBe(
      at("09:05").toISOString(),
    );
    // In the window and when late, step and floor are the interval itself.
    expect(due("09:00", [{ nextExpectedAt: "08:58" }], 300)).toBe(
      at("09:05").toISOString(),
    );
    expect(due("09:00", [{ nextExpectedAt: "08:00" }], 300)).toBe(
      at("09:05").toISOString(),
    );
  });

  it("waits for nextExpectedAt + grace (normal)", () => {
    // Expected at 11:00: the next sync runs at 11:10, before the 15:00 interval.
    expect(due("09:00", [{ nextExpectedAt: "11:00" }])).toBe(
      at("11:10").toISOString(),
    );
  });

  it("never schedules later than the interval", () => {
    expect(due("09:00", [{ nextExpectedAt: "20:00" }])).toBe(
      at("15:00").toISOString(),
    );
  });

  it("checks every 30 min from expectedFrom + grace, with one check at nextExpectedAt + grace", () => {
    const row = { expectedFrom: "17:00", nextExpectedAt: "20:00" };
    expect(due("13:00", [row])).toBe(at("17:10").toISOString());
    expect(due("17:10", [row])).toBe(at("17:40").toISOString());
    expect(due("19:30", [row])).toBe(at("20:00").toISOString());
    expect(due("19:50", [row])).toBe(at("20:10").toISOString());
  });

  it("keeps checking every 30 min while the provider is late", () => {
    expect(due("11:10", [{ nextExpectedAt: "11:00" }])).toBe(
      at("11:40").toISOString(),
    );
    expect(due("16:00", [{ nextExpectedAt: "11:00" }])).toBe(
      at("16:30").toISOString(),
    );
  });

  it("returns to the interval once the provider is a full interval late", () => {
    expect(due("17:00", [{ nextExpectedAt: "11:00" }])).toBe(
      at("23:00").toISOString(),
    );
    expect(due("17:30", [{ nextExpectedAt: "11:00" }])).toBe(
      at("23:30").toISOString(),
    );
  });

  it("keeps the 15 min floor", () => {
    // Expected 5 minutes from now: wait candidate 09:15 is the floor anyway.
    expect(due("09:00", [{ nextExpectedAt: "08:55" }])).toBe(
      at("09:15").toISOString(),
    );
    expect(due("09:00", [{ nextExpectedAt: "08:52" }])).toBe(
      at("09:15").toISOString(),
    );
  });

  it("takes the earliest candidate of several rows", () => {
    expect(
      due("09:00", [
        { nextExpectedAt: "13:00" },
        { nextExpectedAt: "11:00" },
        { nextExpectedAt: null },
      ]),
    ).toBe(at("11:10").toISOString());
  });

  it("uses min(15 min, interval) as the floor for short intervals", () => {
    // 10-minute interval: floor and step are 10 minutes.
    expect(due("09:00", [{ nextExpectedAt: "08:55" }], 600)).toBe(
      at("09:10").toISOString(),
    );
  });
});

describe("localizedFreshnessStreamName", () => {
  it("translates a stream's name and falls back to English", () => {
    const manifest = {
      translations: { de: { freshnessStreams: { sales: "Verkäufe" } } },
    };
    const sales = { key: "sales", name: "Sales" };
    expect(localizedFreshnessStreamName(manifest, sales, "de")).toBe(
      "Verkäufe",
    );
    expect(localizedFreshnessStreamName(manifest, sales, "fr")).toBe("Sales");
    expect(
      localizedFreshnessStreamName(
        manifest,
        { key: "reviews", name: "Reviews" },
        "de",
      ),
    ).toBe("Reviews");
  });
});

describe("late and overdue (ADR 0025 §7)", () => {
  it("is late when a check after nextExpectedAt + grace did not find the period", () => {
    expect(
      isFreshnessLate({ nextExpectedAt: at("11:00"), checkedAt: at("11:10") }),
    ).toBe(false);
    expect(
      isFreshnessLate({ nextExpectedAt: at("11:00"), checkedAt: at("11:11") }),
    ).toBe(true);
    expect(
      isFreshnessLate({ nextExpectedAt: null, checkedAt: at("11:11") }),
    ).toBe(false);
  });

  it("is overdue 24 h after nextExpectedAt", () => {
    const nextExpectedAt = new Date("2026-11-15T11:00:00.000Z");
    expect(isFreshnessOverdue({ nextExpectedAt, checkedAt: at("10:59") })).toBe(
      false,
    );
    expect(isFreshnessOverdue({ nextExpectedAt, checkedAt: at("11:00") })).toBe(
      true,
    );
  });
});
