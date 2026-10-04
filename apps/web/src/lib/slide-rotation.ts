/**
 * Client-side slide rotation (ADR 0015, section 7): a screen shows each
 * slide for its `durationSec`, then the next, wrapping round. A new payload
 * keeps the slide on screen when its id still exists (and lets its time run
 * on), otherwise it starts at the first slide. Without auto-advance only the
 * first slide is shown.
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
}

/** A slide shows at least this long, whatever its duration says. */
export const MIN_SLIDE_MS = 1000;

const systemClock: RotationClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
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
  if (slides.length === 0) {
    return null;
  }
  const index = slides.findIndex((slide) => slide.id === currentId);
  return slides[(index + 1) % slides.length]!.id;
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
  stop(): void;
}

export function createSlideRotation(options: {
  onChange: (slideId: string | null) => void;
  clock?: RotationClock;
}): SlideRotation {
  const clock = options.clock ?? systemClock;
  let slides: readonly RotationSlide[] = [];
  let autoAdvance = false;
  let currentId: string | null = null;
  let timer: unknown = null;
  let stopped = false;

  function clear() {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  function arm() {
    clear();
    if (stopped || !autoAdvance || slides.length < 2 || currentId === null) {
      return;
    }
    const slide = slides.find((candidate) => candidate.id === currentId);
    timer = clock.setTimeout(advance, slideMs(slide));
  }

  function advance() {
    timer = null;
    const next = nextSlideId(slides, currentId);
    if (next !== currentId) {
      currentId = next;
      options.onChange(currentId);
    }
    arm();
  }

  return {
    update(nextSlides, nextAutoAdvance) {
      const wasRotating = autoAdvance && slides.length > 1;
      slides = nextSlides;
      autoAdvance = nextAutoAdvance;
      const kept = keptSlideId(slides, currentId, autoAdvance);
      const changed = kept !== currentId;
      currentId = kept;
      if (changed) {
        options.onChange(currentId);
      }
      // The slide on screen keeps its remaining time across payloads;
      // a different slide (or a rotation that just started) starts fresh.
      if (changed || !wasRotating || timer === null) {
        arm();
      } else if (!autoAdvance || slides.length < 2) {
        clear();
      }
    },
    current() {
      return currentId;
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
