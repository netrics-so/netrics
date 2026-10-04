import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIN_SLIDE_MS,
  createSlideRotation,
  documentRotation,
  keptSlideId,
  nextSlideId,
  type SlideRotation,
} from "./slide-rotation";

const A = { id: "a", durationSec: 10 };
const B = { id: "b", durationSec: 20 };
const C = { id: "c", durationSec: 5 };

let rotation: SlideRotation | null = null;

function rotate(): { rotation: SlideRotation; seen: Array<string | null> } {
  const seen: Array<string | null> = [];
  rotation = createSlideRotation({ onChange: (id) => seen.push(id) });
  return { rotation, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rotation?.stop();
  rotation = null;
  vi.useRealTimers();
});

describe("keptSlideId and nextSlideId", () => {
  it("keeps a slide that still exists, else the first", () => {
    expect(keptSlideId([A, B], "b", true)).toBe("b");
    expect(keptSlideId([A, C], "b", true)).toBe("a");
    expect(keptSlideId([], "b", true)).toBeNull();
    expect(keptSlideId([A, B], null, true)).toBe("a");
  });

  it("shows the first slide without auto-advance", () => {
    expect(keptSlideId([A, B], "b", false)).toBe("a");
  });

  it("wraps round", () => {
    expect(nextSlideId([A, B, C], "a")).toBe("b");
    expect(nextSlideId([A, B, C], "c")).toBe("a");
    expect(nextSlideId([A, B, C], "gone")).toBe("a");
    expect(nextSlideId([], "a")).toBeNull();
  });
});

describe("createSlideRotation", () => {
  it("advances by each slide's duration and wraps", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B, C], true);
    expect(rotation.current()).toBe("a");

    vi.advanceTimersByTime(9_999);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("b");

    vi.advanceTimersByTime(19_999);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("c");

    vi.advanceTimersByTime(5_000);
    expect(rotation.current()).toBe("a");
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });

  it("keeps the current slide and its remaining time across updates", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B, C], true);
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");

    // A new payload 15 s into b: b stays, and still leaves at 20 s.
    vi.advanceTimersByTime(15_000);
    rotation.update([{ ...A }, { ...B }, { ...C }], true);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(4_999);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("c");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("applies a shorter duration of the slide on screen at once", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B, C], true);
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");

    // 5 s into b (20 s), b becomes 8 s long: it leaves 3 s later, not
    // after the 15 s the old duration had left.
    vi.advanceTimersByTime(5_000);
    rotation.update([A, { ...B, durationSec: 8 }, C], true);
    vi.advanceTimersByTime(2_999);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("c");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("moves on at once when the shorter duration has already passed", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B, C], true);
    vi.advanceTimersByTime(10_000 + 15_000);
    expect(rotation.current()).toBe("b");

    // 15 s into b, b becomes 5 s long: its time is up, c follows now and
    // gets its full 5 s (no slide is skipped).
    rotation.update([A, { ...B, durationSec: 5 }, C], true);
    vi.advanceTimersByTime(0);
    expect(rotation.current()).toBe("c");
    vi.advanceTimersByTime(4_999);
    expect(rotation.current()).toBe("c");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("a");
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });

  it("lets a longer duration keep the slide on screen longer", () => {
    const { rotation } = rotate();
    rotation.update([A, B], true);
    vi.advanceTimersByTime(6_000);
    rotation.update([{ ...A, durationSec: 30 }, B], true);
    vi.advanceTimersByTime(23_999);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("b");
  });

  it("runs on an injected clock", () => {
    let now = 0;
    const pending: Array<{ at: number; run: () => void } | null> = [];
    const clock = {
      now: () => now,
      setTimeout: (run: () => void, ms: number) =>
        pending.push({ at: now + ms, run }) - 1,
      clearTimeout: (handle: unknown) => {
        pending[handle as number] = null;
      },
    };
    const tick = (ms: number) => {
      now += ms;
      for (const [index, entry] of pending.entries()) {
        if (entry && entry.at <= now) {
          pending[index] = null;
          entry.run();
        }
      }
    };
    const seen: Array<string | null> = [];
    const injected = createSlideRotation({
      onChange: (id) => seen.push(id),
      clock,
    });
    injected.update([A, B, C], true);
    tick(4_000);
    injected.update([{ ...A, durationSec: 5 }, B, C], true);
    tick(999);
    expect(injected.current()).toBe("a");
    tick(1);
    expect(injected.current()).toBe("b");
    expect(seen).toEqual(["a", "b"]);
    injected.stop();
  });

  it("steps both ways and starts the new slide's time afresh", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B, C], true);
    vi.advanceTimersByTime(9_000);
    rotation.step(1);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(19_999);
    expect(rotation.current()).toBe("b");
    rotation.step(-1);
    rotation.step(-1);
    expect(rotation.current()).toBe("c");
    vi.advanceTimersByTime(5_000);
    expect(rotation.current()).toBe("a");
    expect(seen).toEqual(["a", "b", "a", "c", "a"]);
  });

  it("pauses and resumes with the time the slide had left", () => {
    const { rotation } = rotate();
    rotation.update([A, B], true);
    vi.advanceTimersByTime(4_000);
    rotation.setPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(rotation.current()).toBe("a");
    // A payload while paused keeps it paused.
    rotation.update([A, B], true);
    vi.advanceTimersByTime(60_000);
    expect(rotation.current()).toBe("a");
    rotation.setPaused(false);
    vi.advanceTimersByTime(5_999);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("b");
  });

  it("starts on a given slide when it is there", () => {
    const seen: Array<string | null> = [];
    rotation = createSlideRotation({
      onChange: (id) => seen.push(id),
      startId: "c",
    });
    rotation.update([A, B, C], true);
    expect(rotation.current()).toBe("c");
    vi.advanceTimersByTime(5_000);
    expect(rotation.current()).toBe("a");
    expect(seen).toEqual(["a"]);
  });

  it("starts at the first slide when the current one is gone", () => {
    const { rotation } = rotate();
    rotation.update([A, B, C], true);
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");

    rotation.update([C, A], true);
    expect(rotation.current()).toBe("c");
    vi.advanceTimersByTime(5_000);
    expect(rotation.current()).toBe("a");
  });

  it("follows new slide order from the kept slide", () => {
    const { rotation } = rotate();
    rotation.update([A, B, C], true);
    rotation.update([C, A, B], true);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");
    vi.advanceTimersByTime(20_000);
    expect(rotation.current()).toBe("c");
  });

  it("shows only the first slide without auto-advance", () => {
    const { rotation } = rotate();
    rotation.update([A, B], true);
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");

    rotation.update([A, B], false);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(60_000);
    expect(rotation.current()).toBe("a");

    // Turned back on: the rotation starts again.
    rotation.update([A, B], true);
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");
  });

  it("does not rotate a single slide and handles none", () => {
    const { rotation, seen } = rotate();
    rotation.update([A], true);
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual(["a"]);

    rotation.update([], true);
    expect(rotation.current()).toBeNull();
    rotation.update([A, B], true);
    expect(rotation.current()).toBe("a");
    vi.advanceTimersByTime(10_000);
    expect(rotation.current()).toBe("b");
  });

  it("never advances faster than the minimum", () => {
    const { rotation } = rotate();
    rotation.update(
      [
        { id: "x", durationSec: 0 },
        { id: "y", durationSec: 5 },
      ],
      true,
    );
    vi.advanceTimersByTime(MIN_SLIDE_MS - 1);
    expect(rotation.current()).toBe("x");
    vi.advanceTimersByTime(1);
    expect(rotation.current()).toBe("y");
  });

  it("stops", () => {
    const { rotation, seen } = rotate();
    rotation.update([A, B], true);
    rotation.stop();
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual(["a"]);
  });
});

describe("documentRotation", () => {
  it("keeps enabled slides with their duration or the default", () => {
    const slides = [
      { id: "a", enabled: true, durationSeconds: 30 },
      { id: "b", enabled: false, durationSeconds: 10 },
      { id: "c", enabled: true, durationSeconds: null },
    ];
    expect(
      documentRotation(slides, { defaultSlideSeconds: 15 }).map((slide) => [
        slide.id,
        slide.durationSec,
      ]),
    ).toEqual([
      ["a", 30],
      ["c", 15],
    ]);
  });
});
