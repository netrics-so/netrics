"use client";

import type { OAuthCallbackOutcome } from "@netrics/contracts";

import { useLocale } from "@/lib/i18n/client";
import { oauthOutcomeMessage } from "@/lib/oauth-connection";

/**
 * The message after returning from the provider (`?oauth=<outcome>`), so a
 * refused or failed authorization never ends on a blank page.
 */
export function OAuthOutcomeBanner({
  outcome,
  provider,
}: {
  outcome: OAuthCallbackOutcome | null;
  provider?: string;
}) {
  const locale = useLocale();
  const message = oauthOutcomeMessage(outcome, locale, provider);
  if (!message) {
    return null;
  }
  return (
    <div
      className={`${message.tone} page-alert`}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.text}
    </div>
  );
}
