// Slide enter motion (ADR 0018 section 6): on every slide change, the
// first paint included, values count up from zero and charts draw over
// 1200 ms with an ease-out cubic; then the slide is still. One clock per
// slide drives it all: a single requestAnimationFrame loop that sets the
// eased progress as `--enter-p` on the slide (the CSS draws, fades and
// grows read it) and tells the counting values, and stops when done.
// Without the clock (server render, the Studio canvas, reduced motion)
// everything shows its final state.

/** How long a slide's enter motion lasts. */
export const ENTER_MS = 1200;

/** The enter easing, `1 − (1 − t)³` (ease-out cubic), t clamped to 0…1. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

/** Decimal places of a number as written (at most 6). */
function decimalsOf(value: number): number {
  for (let places = 0; places < 6; places += 1) {
    const scaled = value * 10 ** places;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return places;
  }
  return 6;
}

/**
 * The value shown at linear progress `t` of the enter: the target eased
 * up from zero, at the target's precision (a whole count stays whole);
 * exactly the target from `t = 1` on.
 */
export function countUpValue(target: number, t: number): number {
  if (t >= 1) return target;
  const places = decimalsOf(target);
  const factor = 10 ** places;
  return Math.round(target * easeOutCubic(t) * factor) / factor;
}

/**
 * A counting value's text at progress `t`: `format` of the counted value,
 * and from `t = 1` on exactly `final` (the text the widget shows at rest,
 * so the last frame never differs from the static render). A frame that
 * would be longer than the final text shows the final text instead, so
 * the value never needs more room than it has at rest.
 */
export function countUpText(
  target: number,
  t: number,
  format: (value: number) => string,
  final: string,
): string {
  if (t >= 1 || !Number.isFinite(target)) return final;
  const text = format(countUpValue(target, t));
  return text.length > final.length ? final : text;
}

/** The parts of `window` the motion check reads (tests pass their own). */
export interface MotionEnvironment {
  matchMedia?: (query: string) => { matches: boolean };
  document?: { visibilityState?: string };
  requestAnimationFrame?: unknown;
}

/**
 * Whether enter motion may run: not with `prefers-reduced-motion: reduce`,
 * not while the page is hidden (nobody sees it), and not without
 * requestAnimationFrame.
 */
export function enterMotionAllowed(
  env: MotionEnvironment | undefined = typeof window === "undefined"
    ? undefined
    : window,
): boolean {
  if (!env || typeof env.requestAnimationFrame !== "function") return false;
  if (env.document?.visibilityState === "hidden") return false;
  try {
    if (env.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** A frame scheduler: the browser's, or a test's. */
export interface FrameScheduler {
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export const browserFrames: FrameScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** Told the enter's linear progress, 0 to 1, on every frame of an enter. */
export type EnterListener = (t: number) => void;

/** The element the clock marks: `--enter-p` and `data-entering`. */
export interface EnterTarget {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * One slide's enter clock. `start()` runs one enter (restarting a running
 * one); listeners hear the linear progress on every frame, and 1 at the
 * end; the target carries the eased progress as `--enter-p` and
 * `data-entering` while it runs, and neither once it is done.
 */
export class EnterClock {
  private readonly listeners = new Set<EnterListener>();
  private startedAt = 0;
  private handle: number | null = null;
  private target: EnterTarget | null = null;
  private progress = 1;

  constructor(
    private readonly frames: FrameScheduler = browserFrames,
    private readonly duration: number = ENTER_MS,
  ) {}

  /** True while an enter runs. */
  get running(): boolean {
    return this.handle !== null;
  }

  /** The running enter's linear progress; 1 when none runs. */
  get t(): number {
    return this.progress;
  }

  /**
   * Hears every frame of every enter; while one runs, at once with its
   * progress (a value that mounts mid-enter joins in).
   */
  subscribe(listener: EnterListener): () => void {
    this.listeners.add(listener);
    if (this.running) listener(this.progress);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Runs an enter on `target`; frame 0 is applied at once (before paint). */
  start(target: EnterTarget): void {
    this.cancel();
    this.target = target;
    this.startedAt = this.frames.now();
    target.setAttribute("data-entering", "");
    this.apply(0);
    this.handle = this.frames.request(this.tick);
  }

  /** Ends a running enter at its final state. */
  finish(): void {
    if (!this.running && this.progress === 1) return;
    this.cancel();
    this.apply(1);
  }

  private readonly tick = () => {
    const t = Math.min(
      1,
      (this.frames.now() - this.startedAt) / Math.max(1, this.duration),
    );
    if (t >= 1) {
      this.handle = null;
      this.apply(1);
      return;
    }
    this.apply(t);
    this.handle = this.frames.request(this.tick);
  };

  private cancel(): void {
    if (this.handle !== null) {
      this.frames.cancel(this.handle);
      this.handle = null;
    }
  }

  private apply(t: number): void {
    this.progress = t;
    const target = this.target;
    if (target) {
      if (t >= 1) {
        target.style.removeProperty("--enter-p");
        target.removeAttribute("data-entering");
        this.target = null;
      } else {
        target.style.setProperty("--enter-p", easeOutCubic(t).toFixed(4));
      }
    }
    for (const listener of this.listeners) listener(t);
  }
}
