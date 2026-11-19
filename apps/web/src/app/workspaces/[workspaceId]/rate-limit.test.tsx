import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderI18n } from "@/lib/i18n/test-render";
import { rateLimitLabel } from "@/lib/rate-limit";

import { HealthBadge, RateLimitText } from "./health-badge";
import { SyncRunError } from "./connections/[connectionId]/sync-run-error";

// #781: a connection whose provider limit is used up shows when syncing
// continues, in the viewer's language and clock, instead of an outage; a
// failed run's error is no longer English only.

const NOW = Date.parse("2026-11-19T09:05:00.000Z");
const UNTIL = "2026-11-19T09:40:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the rate-limited state", () => {
  it("shows the limit and when syncing continues, in English and German", () => {
    const en = renderI18n(
      <HealthBadge
        health="ok"
        rateLimitedUntil={UNTIL}
        connectorName="Vercel Web Analytics"
      />,
      "en",
      "Europe/Berlin",
    );
    expect(en).toContain("health-badge rate_limited");
    expect(en).toContain(
      "Vercel Web Analytics limit reached, continuing at 10:40 AM",
    );
    expect(en).not.toContain("Outage");
    const de = renderI18n(
      <HealthBadge
        health="pending"
        rateLimitedUntil={UNTIL}
        connectorName="Vercel Web Analytics"
      />,
      "de",
      "Europe/Berlin",
    );
    expect(de).toContain(
      "Vercel Web Analytics-Limit erreicht, weiter um 10:40",
    );
    expect(de).not.toContain("Ausfall");
    expect(
      renderI18n(
        <RateLimitText rateLimitedUntil={UNTIL} connectorName="Vercel" />,
        "de",
        "Europe/Berlin",
      ),
    ).toBe("Vercel-Limit erreicht, weiter um 10:40");
  });

  it("names the day when syncing continues on another one", () => {
    expect(
      rateLimitLabel(
        { rateLimitedUntil: "2026-11-20T07:30:00.000Z" },
        "Search Console",
        "en",
        "Europe/Berlin",
        NOW,
      ),
    ).toBe("Search Console limit reached, continuing on Nov 20 at 8:30 AM");
    expect(
      rateLimitLabel(
        { rateLimitedUntil: "2026-11-20T07:30:00.000Z" },
        "Search Console",
        "de",
        "Europe/Berlin",
        NOW,
      ),
    ).toBe("Search Console-Limit erreicht, weiter am 20. Nov. um 08:30");
  });

  it("shows the health as before once the reset has passed", () => {
    const html = renderI18n(
      <HealthBadge
        health="ok"
        rateLimitedUntil="2026-11-19T09:00:00.000Z"
        connectorName="Vercel"
      />,
      "en",
    );
    expect(html).toContain("health-badge ok");
    expect(html).toContain("Healthy");
    expect(
      rateLimitLabel({ rateLimitedUntil: null }, "Vercel", "en", "UTC", NOW),
    ).toBeNull();
  });
});

describe("a failed run's error", () => {
  it("says what went wrong in the viewer's language, then the provider's words", () => {
    const html = renderI18n(
      <SyncRunError
        run={{
          errorClass: "transient",
          errorMessage: "Vercel is not answering right now (503).",
        }}
      />,
      "de",
    );
    expect(html).toContain("Vorübergehender Fehler");
    expect(html).toContain(
      '<span lang="en">Vercel is not answering right now (503).</span>',
    );
    expect(html).not.toContain("transient");
  });

  it("says a rate limit in the viewer's language alone", () => {
    const html = renderI18n(
      <SyncRunError
        run={{
          errorClass: "rate_limited",
          errorMessage:
            "Vercel's API rate limit is used up (429). netrics continues after the reset.",
        }}
      />,
      "de",
    );
    expect(html).toBe(
      "Limit des Anbieters erreicht, weiter nach dem Zurücksetzen",
    );
  });
});
