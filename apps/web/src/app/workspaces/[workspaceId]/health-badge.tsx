"use client";

import type { ConnectionHealth } from "@netrics/contracts";

import { useLocale, useT } from "@/lib/i18n/client";
import { rateLimitLabel } from "@/lib/rate-limit";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * "Vercel limit reached, continuing at 10:40" (#781), at the viewer's
 * clock (ADR 0025 §8); null when no limit holds.
 */
function useRateLimitLabel(
  rateLimitedUntil: string | null | undefined,
  connectorName: string,
): string | null {
  const locale = useLocale();
  const zone = useViewerTimeZone();
  return rateLimitLabel({ rateLimitedUntil }, connectorName, locale, zone);
}

/** The rate-limit text alone, for the connection's health card. */
export function RateLimitText({
  rateLimitedUntil,
  connectorName,
}: {
  rateLimitedUntil: string | null | undefined;
  connectorName: string;
}) {
  return useRateLimitLabel(rateLimitedUntil, connectorName);
}

/**
 * A connection's health. While the provider's request limit holds (#781),
 * the limit and when syncing continues stand in for it: syncing waits for
 * the reset, which is neither healthy nor an outage.
 */
export function HealthBadge({
  health,
  rateLimitedUntil = null,
  connectorName = "",
}: {
  health: ConnectionHealth;
  rateLimitedUntil?: string | null;
  connectorName?: string;
}) {
  const t = useT("health.states");
  const rateLimited = useRateLimitLabel(rateLimitedUntil, connectorName);
  if (rateLimited) {
    return (
      <span className="health-badge rate_limited">
        <span className="dot warning" />
        {rateLimited}
      </span>
    );
  }
  return (
    <span className={`health-badge ${health}`}>
      <span
        className={`dot ${health === "ok" ? "up" : health === "pending" ? "unknown" : "down"}`}
      />
      {t(health)}
    </span>
  );
}
