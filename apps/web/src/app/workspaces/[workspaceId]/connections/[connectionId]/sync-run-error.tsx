"use client";

import type { SyncRun } from "@netrics/contracts";
import { localizedProviderFailure } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";

/**
 * A failed run's error (#781): what went wrong in the viewer's language,
 * then the provider's own words, which are English, unless the run has a
 * reason code the catalog knows (a refused key, #795; runs recorded before
 * codes are found by their exact text, #378). A rate limit says all there is in its
 * class: when syncing continues is on the connection.
 */
export function SyncRunError({
  run,
}: {
  run: Pick<SyncRun, "errorClass" | "errorMessage"> &
    Partial<Pick<SyncRun, "errorCode">>;
}) {
  const t = useT("connections.detail.errorClass");
  const locale = useLocale();
  if (!run.errorClass) return "—";
  const detail =
    run.errorClass !== "rate_limited" && run.errorMessage
      ? run.errorMessage
      : null;
  const localized = detail
    ? localizedProviderFailure({ code: run.errorCode, message: detail }, locale)
    : null;
  return (
    <>
      {t(run.errorClass)}
      {localized ? (
        <>
          {": "}
          {localized}
        </>
      ) : detail ? (
        <>
          {": "}
          <span lang="en">{detail}</span>
        </>
      ) : null}
    </>
  );
}
