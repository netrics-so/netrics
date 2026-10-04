import type { DashboardSettings } from "@netrics/contracts";

// The rotation a screen plays (ADR 0015, section 7), for the Studio's Play
// preview: enabled slides only, each for its own duration or the
// dashboard's default; without auto-advance only the first enabled slide.

export interface PlayItem<S> {
  slide: S;
  seconds: number;
}

export function playlist<
  S extends { enabled: boolean; durationSeconds: number | null },
>(
  slides: readonly S[],
  settings: Pick<DashboardSettings, "autoAdvance" | "defaultSlideSeconds">,
): Array<PlayItem<S>> {
  const enabled = slides
    .filter((slide) => slide.enabled)
    .map((slide) => ({
      slide,
      seconds: slide.durationSeconds ?? settings.defaultSlideSeconds,
    }));
  return settings.autoAdvance ? enabled : enabled.slice(0, 1);
}

/** The next index in a rotation of `length`, wrapping both ways. */
export function stepIndex(index: number, by: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return (((index + by) % length) + length) % length;
}
