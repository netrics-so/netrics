/**
 * Client-side slide rotation (ADR 0015, section 7): a screen shows each
 * slide for its `durationSec`, then the next, wrapping round. A new payload
 * keeps the slide on screen when its id still exists (and lets its time run
 * on, against the new duration: a shorter one applies at once), otherwise
 * it starts at the first slide. Without auto-advance only the first slide
 * is shown.
 *
 * Framework-free so the timing can be tested with fake timers; the
 * SlidePlayer component holds one and renders the slide it reports.
 */

export interface RotationSlide {
  id: string;
  durationSec: number;
}

export interface RotationClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds on a monotonic-enough clock (Date.now). */
  now(): number;
}

/** A slide shows at least this long, whatever its duration says. */
export const MIN_SLIDE_MS = 1000;

const systemClock: RotationClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * The slide to show for `slides` when `currentId` was on screen: the same
 * slide while it exists, else the first; null without slides. Without
 * auto-advance always the first.
 */
export function keptSlideId(
  slides: readonly RotationSlide[],
  currentId: string | null,
  autoAdvance: boolean,
): string | null {
  const first = slides[0]?.id ?? null;
  if (!autoAdvance || currentId === null) {
    return first;
  }
  return slides.some((slide) => slide.id === currentId) ? currentId : first;
}

/** The slide after `currentId`, wrapping round; the first when unknown. */
export function nextSlideId(
  slides: readonly RotationSlide[],
  currentId: string | null,
): string | null {
  return steppedSlideId(slides, currentId, 1);
}

/** The slide `by` places from `currentId`, wrapping both ways. */
export function steppedSlideId(
  slides: readonly RotationSlide[],
  currentId: string | null,
  by: number,
): string | null {
  if (slides.length === 0) {
    return null;
  }
  const index = slides.findIndex((slide) => slide.id === currentId);
  if (index < 0) {
    return slides[0]!.id;
  }
  const count = slides.length;
  return slides[(((index + by) % count) + count) % count]!.id;
}

function slideMs(slide: RotationSlide | undefined): number {
  const seconds = slide && slide.durationSec > 0 ? slide.durationSec : 0;
  return Math.max(seconds * 1000, MIN_SLIDE_MS);
}

export interface SlideRotation {
  /** Slides or settings changed (a new payload, a document refresh). */
  update(slides: readonly RotationSlide[], autoAdvance: boolean): void;
  /** The slide on screen, or null without slides. */
  current(): string | null;
  /**
   * Moves `by` slides (the remote, the Play controls), wrapping round; the
   * new slide's time starts now. Does nothing when the slides do not
   * rotate.
   */
  step(by: number): void;
  /** Holds the slide on screen; resuming keeps the time it had left. */
  setPaused(paused: boolean): void;
  stop(): void;
}

/**
 * The rotation itself. The slide on screen keeps its time across updates,
 * measured against its duration in the latest slides: a payload that
 * shortens it moves on when the shorter time is up (at once when that has
 * passed), one that lengthens it stays longer.
 */
export function createSlideRotation(options: {
  onChange: (slideId: string | null) => void;
  clock?: RotationClock;
  /** The slide to start on when it is there (Play from a slide). */
  startId?: string | null;
}): SlideRotation {
  const clock = options.clock ?? systemClock;
  let slides: readonly RotationSlide[] = [];
  let autoAdvance = false;
  let currentId: string | null = options.startId ?? null;
  /** When the current slide's time started, moved on by pauses. */
  let shownAt = clock.now();
  let pausedAt: number | null = null;
  let timer: unknown = null;
  let stopped = false;

  const rotates = () => autoAdvance && slides.length > 1;

  function clear() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  /** Schedules the next change for the time the current slide has left. */
  function arm() {
    clear();
    if (stopped || pausedAt !== null || !rotates() || currentId === null) {
      return;
    }
    const slide = slides.find((candidate) => candidate.id === currentId);
    const left = slideMs(slide) - (clock.now() - shownAt);
    timer = clock.setTimeout(advance, Math.max(0, left));
  }

  function show(id: string | null) {
    shownAt = clock.now();
    if (pausedAt !== null) {
      pausedAt = shownAt;
    }
    if (id !== currentId) {
      currentId = id;
      options.onChange(currentId);
    }
  }

  function advance() {
    timer = null;
    show(nextSlideId(slides, currentId));
    arm();
  }

  return {
    update(nextSlides, nextAutoAdvance) {
      const wasRotating = rotates();
      slides = nextSlides;
      autoAdvance = nextAutoAdvance;
      const kept = keptSlideId(slides, currentId, autoAdvance);
      if (kept !== currentId || !wasRotating) {
        // A different slide, or a rotation that just started: from now.
        show(kept);
      }
      if (!rotates()) {
        pausedAt = null;
      }
      // The slide on screen keeps the time it has had, against its new
      // duration.
      arm();
    },
    current() {
      return currentId;
    },
    step(by) {
      if (stopped || !rotates()) {
        return;
      }
      show(steppedSlideId(slides, currentId, by));
      arm();
    },
    setPaused(paused) {
      if (stopped || paused === (pausedAt !== null)) {
        return;
      }
      if (paused) {
        if (!rotates()) {
          return;
        }
        pausedAt = clock.now();
        clear();
      } else {
        shownAt += clock.now() - (pausedAt ?? clock.now());
        pausedAt = null;
        arm();
      }
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

/**
 * A dashboard document's rotation as a device payload has it: enabled
 * slides only, each with its own duration or the dashboard's default
 * (ADR 0015, section 7). The signed-in TV mode plays this.
 */
export function documentRotation<
  S extends { id: string; enabled: boolean; durationSeconds: number | null },
>(
  slides: readonly S[],
  settings: { defaultSlideSeconds: number },
): Array<S & { durationSec: number }> {
  return slides
    .filter((slide) => slide.enabled)
    .map((slide) => ({
      ...slide,
      durationSec: slide.durationSeconds ?? settings.defaultSlideSeconds,
    }));
}
