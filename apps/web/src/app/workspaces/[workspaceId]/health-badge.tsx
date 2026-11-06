"use client";

import type { ConnectionHealth } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

export function HealthBadge({ health }: { health: ConnectionHealth }) {
  const t = useT("health.states");
  return (
    <span className={`health-badge ${health}`}>
      <span
        className={`dot ${health === "ok" ? "up" : health === "pending" ? "unknown" : "down"}`}
      />
      {t(health)}
    </span>
  );
}
