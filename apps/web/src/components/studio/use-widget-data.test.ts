import { afterEach, describe, expect, it } from "vitest";

import type { DashboardSlide } from "@netrics/contracts";

import { scopedSlide, type ReviewWidget } from "@/lib/studio-widgets";

import {
  SHARED_LOAD_MS,
  clearSharedLoads,
  latestReviewRequest,
  sharedLoad,
} from "./use-widget-data";

describe("latest-review request (#705)", () => {
  const CONNECTION = "00000000-0000-4000-8000-000000000009";
  const widget = {
    id: "00000000-0000-4000-8000-000000000001",
    type: "review",
    title: null,
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    connectionId: CONNECTION,
    dimensions: {},
    imageId: null,
    options: { minRating: 1, requireText: false, showAuthor: true },
  } as unknown as ReviewWidget;
  const slide = (scope: DashboardSlide["scope"]) =>
    ({ widgets: [widget], scope }) as unknown as DashboardSlide;

  it("sends the app of the slide's scope as resource", () => {
    const scoped = scopedSlide(
      slide({ app: { kind: "values", values: [`${CONNECTION}:123`] } }),
    ).widgets[0] as ReviewWidget;
    expect(latestReviewRequest(scoped)).toEqual({
      resource: "123",
      minRating: 1,
      requireText: false,
      showAuthor: true,
    });
  });

  it("sends no resource for an unscoped slide (all apps)", () => {
    const unscoped = scopedSlide(slide({})).widgets[0] as ReviewWidget;
    expect(latestReviewRequest(unscoped)).not.toHaveProperty("resource");
  });
});

// Copies of one widget share their loads (#284): "All formats" shows a
// slide in every format at once, and each copy would query alone.

afterEach(() => clearSharedLoads());

function counter<T>(value: T) {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}

describe("shared loads", () => {
  it("runs one request for every copy of the same query", async () => {
    const source = counter({ value: 42 });
    let now = 1_000;
    const clock = () => now;
    const results = await Promise.all([
      sharedLoad("metric|a", source.load, SHARED_LOAD_MS, clock),
      sharedLoad("metric|a", source.load, SHARED_LOAD_MS, clock),
      sharedLoad("metric|a", source.load, SHARED_LOAD_MS, clock),
    ]);
    expect(results).toEqual([{ value: 42 }, { value: 42 }, { value: 42 }]);
    expect(source.calls()).toBe(1);
    // Still fresh a moment later: a copy mounted now reuses it.
    now += SHARED_LOAD_MS - 1;
    await sharedLoad("metric|a", source.load, SHARED_LOAD_MS, clock);
    expect(source.calls()).toBe(1);
    // A refresh after the window loads again.
    now += 1;
    await sharedLoad("metric|a", source.load, SHARED_LOAD_MS, clock);
    expect(source.calls()).toBe(2);
  });

  it("keeps different queries apart", async () => {
    const source = counter(1);
    await sharedLoad("metric|a", source.load);
    await sharedLoad("metric|b", source.load);
    await sharedLoad("breakdown|a", source.load);
    expect(source.calls()).toBe(3);
  });

  it("does not keep a failure: the next copy tries again", async () => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve("ok");
    };
    const first = sharedLoad("metric|x", failing);
    const waiting = sharedLoad("metric|x", failing);
    await expect(first).rejects.toThrow("offline");
    await expect(waiting).rejects.toThrow("offline");
    await expect(sharedLoad("metric|x", failing)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
