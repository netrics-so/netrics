"use client";

import type { OAuthCallbackOutcome } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

/**
 * The builder's message after the OAuth sign-in of its draft (C-G4 returns
 * with `?oauth=<outcome>&draft=<id>`): every outcome, success included.
 */
export function BuilderOAuthOutcome({
  outcome,
}: {
  outcome: OAuthCallbackOutcome | null;
}) {
  const t = useT("customApi.oauth");
  if (outcome === null) return null;
  const ok = outcome === "connected" || outcome === "reauthorized";
  return (
    <div
      className={`${ok ? "notice" : "error"} page-alert`}
      role={ok ? "status" : "alert"}
    >
      {t(outcome)}
    </div>
  );
}
