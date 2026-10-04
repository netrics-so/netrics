import { describe, expect, it } from "vitest";

import {
  ENTER_MS,
  EnterClock,
  countUpText,
  countUpValue,
  easeOutCubic,
  enterMotionAllowed,
  type EnterTarget,
  type FrameScheduler,
} from "./enter-motion";
import { formatCompactValue, formatValue } from "./format-metric";

describe("easeOutCubic", () => {
  it("is 1 − (1 − t)³, clamped to 0…1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("countUpValue", () => {
  it("counts from zero to exactly the target", () => {
    expect(countUpValue(1248, 0)).toBe(0);
    expect(countUpValue(1248, 0.5)).toBe(1092);
    expect(countUpValue(1248, 1)).toBe(1248);
  });

  it("keeps the target's precision: a whole count stays whole", () => {
    expect(Number.isInteger(countUpValue(7, 0.3))).toBe(true);
    expect(countUpValue(12.5, 0.5)).toBe(10.9);
    expect(countUpValue(0.034, 0.5)).toBe(0.03);
  });
});

describe("countUpText", () => {
  const usd = (value: number) => formatValue(value, "USD_minor", "en");
  const compact = (value: number) => formatCompactValue(value, "count", "en");

  it("words every frame as the final text, which it ends on exactly", () => {
    // Amounts are in minor units: 123456 is $1,234.56.
    const final = usd(123456);
    expect(final).toBe("$1,234.56");
    expect(countUpText(123456, 0, usd, final)).toBe("$0");
    expect(countUpText(123456, 0.5, usd, final)).toBe("$1,080.24");
    expect(countUpText(123456, 1, usd, final)).toBe(final);
  });

  it("counts compact forms in compact form", () => {
    const final = compact(48_200);
    expect(final).toBe("48.2K");
    expect(countUpText(48_200, 0, compact, final)).toBe("0");
    expect(countUpText(48_200, 0.5, compact, final)).toBe("42.2K");
    expect(countUpText(48_200, 1, compact, final)).toBe(final);
  });

  it("ends on the final text even when it is not the format's", () => {
    expect(countUpText(1248, 1, String, "≈ 1,248")).toBe("≈ 1,248");
  });

  it("never needs more room than the final text", () => {
    // 999,999 → "1M" at rest: "999.9K" on the way would be wider.
    const final = compact(1_000_000);
    expect(final).toBe("1M");
    for (const t of [0.2, 0.5, 0.8, 0.95, 0.999]) {
      expect(
        countUpText(1_000_000, t, compact, final).length,
      ).toBeLessThanOrEqual(final.length);
    }
  });
});

describe("enterMotionAllowed", () => {
  const raf = () => 0;
  const media = (reduce: boolean) => (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
  });

  it("allows motion in a visible page without reduced motion", () => {
    expect(
      enterMotionAllowed({
        requestAnimationFrame: raf,
        matchMedia: media(false),
        document: { visibilityState: "visible" },
      }),
    ).toBe(true);
  });

  it("skips it with prefers-reduced-motion: reduce", () => {
    expect(
      enterMotionAllowed({
        requestAnimationFrame: raf,
        matchMedia: media(true),
      }),
    ).toBe(false);
  });

  it("skips it while the page is hidden, and on the server", () => {
    expect(
      enterMotionAllowed({
        requestAnimationFrame: raf,
        matchMedia: media(false),
        document: { visibilityState: "hidden" },
      }),
    ).toBe(false);
    expect(enterMotionAllowed({ matchMedia: media(false) })).toBe(false);
    // The test environment (node) has no window.
    expect(enterMotionAllowed()).toBe(false);
  });
});

/** Frames on demand: `advance(ms)` moves the clock and runs one frame. */
function fakeFrames() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, () => void>();
  const frames: FrameScheduler = {
    now: () => now,
    request: (callback) => {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    frames,
    pending: () => pending.size,
    advance(ms: number) {
      now += ms;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function fakeTarget() {
  const props = new Map<string, string>();
  const attrs = new Set<string>();
  const target: EnterTarget = {
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
    setAttribute: (name) => attrs.add(name),
    removeAttribute: (name) => attrs.delete(name),
  };
  return { target, props, attrs };
}

describe("EnterClock", () => {
  it("runs one enter: frame 0 at once, eased progress, then still", () => {
    const clock = fakeFrames();
    const enter = new EnterClock(clock.frames);
    const { target, props, attrs } = fakeTarget();
    const heard: number[] = [];
    enter.subscribe((t) => heard.push(t));

    enter.start(target);
    expect(enter.running).toBe(true);
    expect(attrs.has("data-entering")).toBe(true);
    expect(props.get("--enter-p")).toBe("0.0000");
    expect(heard).toEqual([0]);

    clock.advance(ENTER_MS / 2);
    expect(props.get("--enter-p")).toBe("0.8750");
    expect(heard.at(-1)).toBe(0.5);

    clock.advance(ENTER_MS / 2);
    expect(heard.at(-1)).toBe(1);
    expect(enter.running).toBe(false);
    expect(props.has("--enter-p")).toBe(false);
    expect(attrs.has("data-entering")).toBe(false);
    // One loop, stopped when done.
    expect(clock.pending()).toBe(0);
  });

  it("lets a value that mounts mid-enter join at the current progress", () => {
    const clock = fakeFrames();
    const enter = new EnterClock(clock.frames);
    enter.start(fakeTarget().target);
    clock.advance(300);
    const heard: number[] = [];
    enter.subscribe((t) => heard.push(t));
    expect(heard).toEqual([0.25]);
  });

  it("finishes at the final state when the slide leaves", () => {
    const clock = fakeFrames();
    const enter = new EnterClock(clock.frames);
    const { target, props, attrs } = fakeTarget();
    const heard: number[] = [];
    enter.subscribe((t) => heard.push(t));
    enter.start(target);
    clock.advance(100);
    enter.finish();
    expect(heard.at(-1)).toBe(1);
    expect(props.size).toBe(0);
    expect(attrs.size).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("restarts on every enter, with a single loop", () => {
    const clock = fakeFrames();
    const enter = new EnterClock(clock.frames);
    const { target } = fakeTarget();
    enter.start(target);
    clock.advance(600);
    enter.start(target);
    expect(enter.t).toBe(0);
    expect(clock.pending()).toBe(1);
  });

  it("does nothing on finish when no enter runs", () => {
    const enter = new EnterClock(fakeFrames().frames);
    const heard: number[] = [];
    enter.subscribe((t) => heard.push(t));
    enter.finish();
    expect(heard).toEqual([]);
  });
});
