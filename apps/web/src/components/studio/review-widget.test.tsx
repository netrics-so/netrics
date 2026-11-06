import { describe, expect, it } from "vitest";

import type { DeviceWidget } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import {
  reviewAuthorLine,
  reviewStars,
  territoryName,
  type ReviewReading,
} from "@/lib/studio-review";
import { ScrollReviewCard } from "@/components/scroll/scroll-widgets";

import { DeviceWidgetView } from "./device-widget";
import { ReviewWidgetView, deviceReviewReading } from "./review-widget";

// The latest-review widget (ADR 0019 section 12, #340).

/** Every font size the markup sets, in units. */
function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size:calc\(var\(--u\) \* ([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );
}

const NOW = Date.parse("2026-10-04T09:02:00Z");

const review: ReviewReading = {
  rating: 4,
  title: "Finally",
  body: "Finally a dashboard I can leave on the office TV. Everyone sees the numbers without asking me, and the new goals make it even better than before.",
  author: "Marta P.",
  territory: "DE",
  createdAt: "2026-10-04T07:02:00Z",
};

const props = {
  label: "Latest review · Wurfel",
  reading: review,
  icon: "/v1/workspaces/w/images/i/content?v=1",
  notice: null,
  placement: { x: 0, y: 0, w: 4, h: 3 },
  showHeader: true,
  fontScale: 1,
};

describe("review widget", () => {
  it("shows the icon, stars, title, the body that fits and the author", () => {
    const html = renderI18n(<ReviewWidgetView {...props} />);
    expect(html).toContain(">Latest review</h3>");
    expect(html).toContain(">Wurfel</p>");
    expect(html).toContain('class="sw-review-icon"');
    expect(html).toContain('aria-label="4 of 5 stars"');
    expect(html.match(/sw-review-star filled/g)).toHaveLength(4);
    expect(html.match(/class="sw-review-star"/g)).toHaveLength(1);
    expect(html).toContain(">Finally</p>");
    // Two lines at the minimum, then an ellipsis.
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain("Marta P. · Germany · ");
    // Every text at least 24 units.
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
  });

  it("asks for a reviews key, and says when there are none yet", () => {
    const paused = renderI18n(
      <ReviewWidgetView {...props} reading={null} status="auth_failed" />,
    );
    expect(paused).toContain(
      "App Store reviews paused — upload a new reviews key",
    );
    expect(paused).toContain("sw--auth");
    const empty = renderI18n(
      <ReviewWidgetView {...props} reading={null} status="no_data" />,
    );
    expect(empty).toContain("No reviews yet");
    const german = renderI18n(
      <ReviewWidgetView {...props} reading={null} status="no_data" />,
      "de",
    );
    expect(german).toContain("Noch keine Bewertungen");
  });

  it("renders a payload widget, without an icon or an author", () => {
    const widget: DeviceWidget = {
      type: "review",
      id: "00000000-0000-4000-8000-000000000001",
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      label: "Latest review",
      imageId: null,
      options: { minRating: 1, requireText: true, showAuthor: false },
      data: {
        status: "ok",
        updatedAt: "2026-10-04T09:00:00.000Z",
        review: { ...review, author: null, title: null, body: "Short." },
      },
    };
    const reading = deviceReviewReading(widget, new Map(), "en");
    expect(reading.icon).toBeNull();
    const html = renderI18n(
      <DeviceWidgetView
        widget={widget}
        env={{
          timeZone: "UTC",
          fontScale: 1,
          showHeader: true,
          images: new Map(),
        }}
      />,
    );
    expect(html).toContain(">Short.</p>");
    expect(html).not.toContain("sw-review-icon");
    expect(html).not.toContain("Marta");
  });

  it("shows the whole text in the scroll view", () => {
    const html = renderI18n(
      <ScrollReviewCard
        {...props}
        icon={null}
        status="ok"
        width={358}
        rootPx={16}
      />,
    );
    expect(html).toContain(review.body);
    expect(html).not.toContain("line-clamp");
  });
});

describe("review author line", () => {
  it("names the author, the country in the viewer's language and the age", () => {
    expect(reviewAuthorLine(review, "en", NOW)).toBe(
      "Marta P. · Germany · 2 hr. ago",
    );
    expect(reviewAuthorLine({ ...review, author: null }, "de", NOW)).toBe(
      "Deutschland · vor 2 Std.",
    );
    expect(
      reviewAuthorLine({ ...review, author: "  ", territory: null }, "en", NOW),
    ).toBe("2 hr. ago");
  });

  it("keeps an unknown or odd territory code as it is", () => {
    expect(territoryName("XX", "en")).toBe("XX");
    expect(territoryName("usa", "en")).toBeNull();
    expect(territoryName(null, "en")).toBeNull();
  });

  it("fills stars up to the rating", () => {
    expect(reviewStars(3)).toEqual([true, true, true, false, false]);
  });
});
