import type { SyncRequest } from "@netrics/connector-sdk";
import type {
  CustomApiStream,
  CustomApiWindow,
} from "@netrics/connector-sdk/custom-api";
import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  nextFromFor,
  streamChunks,
  windowPlaceholders,
  type CustomApiCursorV1,
} from "./index.js";
import { sdkFixture } from "./test-helpers.js";

function daily(
  window: Partial<Exclude<CustomApiWindow, { type: "none" }>> = {},
): Pick<CustomApiStream, "window"> {
  return {
    window: {
      type: "date",
      stepDays: 1,
      lookbackDays: 0,
      backfillDays: 365,
      paramFormat: "date",
      endInclusive: false,
      ...window,
    },
  };
}
const backfill = (from: string, to: string): SyncRequest => ({
  mode: "backfill",
  from,
  to,
});
const incremental = (from: string, to: string): SyncRequest => ({
  mode: "incremental",
  from,
  to,
});
const unixWindow: CustomApiWindow = {
  type: "date",
  stepDays: 1,
  lookbackDays: 0,
  backfillDays: 30,
  paramFormat: "unix_seconds",
  endInclusive: false,
};

describe("custom API windows", () => {
  it("splits a backfill into step chunks within backfillDays", () =>
    expect(
      streamChunks(
        daily({ stepDays: 31, backfillDays: 60 }),
        backfill("2024-01-01T00:00:00Z", "2024-03-15T12:00:00Z"),
        "UTC",
      ),
    ).toEqual([
      { from: "2024-01-15", to: "2024-02-15" },
      { from: "2024-02-15", to: "2024-03-16" },
    ]));

  it("returns one null chunk without a window", () =>
    expect(
      streamChunks(
        { window: { type: "none" } },
        backfill("2024-01-01T00:00:00Z", "2024-03-15T12:00:00Z"),
        "UTC",
      ),
    ).toEqual([null]));

  it("keeps DST days contiguous in Europe/Berlin", () => {
    // 21:30 UTC on 31 March is 23:30 in Berlin (CEST).
    const chunks = streamChunks(
      daily({ stepDays: 1 }),
      incremental("2024-03-29T23:00:00Z", "2024-03-31T21:30:00Z"),
      "Europe/Berlin",
    );
    expect(chunks).toEqual([
      { from: "2024-03-30", to: "2024-03-31" },
      { from: "2024-03-31", to: "2024-04-01" },
    ]);
    expect(windowPlaceholders(unixWindow, chunks[1]!, "Europe/Berlin")).toEqual(
      { "window.start": "1711839600", "window.end": "1711922400" },
    );
    expect(
      windowPlaceholders(
        { ...unixWindow, paramFormat: "date", endInclusive: true },
        chunks[1]!,
        "Europe/Berlin",
      ),
    ).toEqual({ "window.start": "2024-03-31", "window.end": "2024-03-31" });
    expect(
      windowPlaceholders(
        { ...unixWindow, paramFormat: "timestamp", endInclusive: true },
        chunks[0]!,
        "Europe/Berlin",
      ),
    ).toEqual({
      "window.start": "2024-03-29T23:00:00.000Z",
      "window.end": "2024-03-30T22:59:59.999Z",
    });
  });

  it("gives timestamp windows instants at the zone's midnight", () => {
    const chunks = streamChunks(
      { window: { ...daily().window, type: "timestamp" } as CustomApiWindow },
      incremental("2024-03-30T12:00:00Z", "2024-03-31T12:00:00Z"),
      "Europe/Berlin",
    );
    expect(chunks).toEqual([
      { from: "2024-03-29T23:00:00.000Z", to: "2024-03-30T23:00:00.000Z" },
      { from: "2024-03-30T23:00:00.000Z", to: "2024-03-31T22:00:00.000Z" },
    ]);
  });

  it("returns nextFrom with the lookback at the start of the day", () => {
    const shop = sdkFixture("v1-shop"); // lookbackDays 3, UTC
    expect(
      nextFromFor(shop, {
        mode: "incremental",
        to: "2024-05-10T15:00:00.000Z",
      }),
    ).toBe("2024-05-07T00:00:00.000Z");
    expect(
      nextFromFor(shop, { mode: "backfill", to: "2024-05-10T15:00:00.000Z" }),
    ).toBeUndefined();
    expect(
      nextFromFor(sdkFixture("v1-images"), {
        mode: "incremental",
        to: "2024-05-10T15:00:00.000Z",
      }),
    ).toBeUndefined();
    const berlin = {
      ...shop,
      defaults: { ...shop.defaults, timeZone: "Europe/Berlin" },
    };
    expect(
      nextFromFor(berlin, {
        mode: "incremental",
        to: "2024-05-10T15:00:00.000Z",
      }),
    ).toBe("2024-05-06T22:00:00.000Z");
  });

  it("restarts on an unknown cursor shape", () => {
    expect(decodeCursor("v0:xyz")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("cav1.bm90LWpzb24")).toBeNull();
    const cursor: CustomApiCursorV1 = {
      v: 1,
      stream: 1,
      chunk: 2,
      page: { type: "cursor", cursor: "c10" },
      refreshKey: "abc",
      pageIndex: 3,
      run: {
        pages: 4,
        records: 40,
        startedAt: "2024-01-01T00:00:00.000Z",
        request: "backfill|a|b",
      },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(
      decodeCursor(
        encodeCursor({ ...cursor, page: { type: "nope" } } as never),
      ),
    ).toBeNull();
  });
});
