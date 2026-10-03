import type { ConnectionAuthState, ConnectionHealth } from "@netrics/contracts";

const LABELS: Record<ConnectionHealth, string> = {
  ok: "Healthy",
  auth_failed: "Auth failed",
  needs_reauthorization: "Needs reconnect",
  outage: "Outage",
  pending: "Pending",
};

export function HealthBadge({ health }: { health: ConnectionHealth }) {
  return (
    <span className={`health-badge ${health}`}>
      <span
        className={`dot ${health === "ok" ? "up" : health === "pending" ? "unknown" : "down"}`}
      />
      {LABELS[health]}
    </span>
  );
}

/** The auth state in words, matching the health badge. */
export const AUTH_STATE_LABELS: Record<ConnectionAuthState, string> = {
  ok: "OK",
  auth_failed: "Auth failed",
  needs_reauthorization: "Needs reconnect",
  outage: "Outage",
};
