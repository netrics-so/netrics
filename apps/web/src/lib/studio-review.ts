import {
  reviewLayout,
  reviewStarsFilled,
  REVIEW_STARS,
  type Locale,
  type ReviewLayout,
} from "@netrics/domain";

import { relativeTimeIn } from "./relative-time";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  type ScreenPlacement,
  type WidgetLabelLayout,
} from "./studio-render";

// How the web lays out a latest-review widget (ADR 0019 section 12): the
// domain's `reviewLayout` (shared with tvOS through the studio-layout
// vectors) for how many body lines fit; the author line worded for the
// viewer ("Marta P. · Germany · 2 hr. ago", the age from this device's
// clock).

/** A review as a widget shows it (the payload's or the Studio's). */
export interface ReviewReading {
  rating: number;
  title: string | null;
  body: string | null;
  author: string | null;
  territory: string | null;
  createdAt: string;
}

/** A territory's name in the viewer's language ("DE" → "Germany"). */
export function territoryName(
  code: string | null,
  locale: Locale,
): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try {
    const name = new Intl.DisplayNames([locale], { type: "region" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/**
 * "Marta P. · Germany · 2 hr. ago": the nickname (when shown), the
 * territory's name and the review's age; the parts there are.
 */
export function reviewAuthorLine(
  review: Pick<ReviewReading, "author" | "territory" | "createdAt">,
  locale: Locale,
  now: number = Date.now(),
): string {
  return [
    review.author?.trim() || null,
    territoryName(review.territory, locale),
    relativeTimeIn(review.createdAt, locale, now, "short"),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

/** Filled (true) and empty stars, five in all. */
export function reviewStars(rating: number): boolean[] {
  const filled = reviewStarsFilled(rating);
  return Array.from({ length: REVIEW_STARS }, (_, index) => index < filled);
}

export interface ReviewWidgetLayout {
  label: WidgetLabelLayout;
  review: ReviewLayout;
}

/** A latest-review widget at its size (ADR 0019 section 12). */
export function reviewWidgetLayout(input: {
  label: string;
  reading: ReviewReading | null;
  icon: boolean;
  notice: boolean;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
}): ReviewWidgetLayout {
  const box = contentBox(input.placement, input.showHeader);
  const sizes = typeScaleFor(
    "review",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  return {
    label: labelLayout(input.label, box.width, sizes),
    review: reviewLayout({
      label: input.label,
      width: box.width,
      height: box.height,
      fontScale: input.fontScale,
      icon: input.icon,
      title: input.reading?.title ?? null,
      body: input.reading?.body ?? null,
      notice: input.notice,
    }),
  };
}
