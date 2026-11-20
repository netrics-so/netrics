"use client";

import type { SyncRun } from "@netrics/contracts";
import { localizedProviderMessage } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";

/**
 * A failed run's error (#781): what went wrong in the viewer's language,
 * then the provider's own words, which are English, unless the catalog
 * knows them (a refused key, #378). A rate limit says all there is in its
 * class: when syncing continues is on the connection.
 */
export function SyncRunError({
  run,
}: {
  run: Pick<SyncRun, "errorClass" | "errorMessage">;
}) {
  const t = useT("connections.detail.errorClass");
  const locale = useLocale();
  if (!run.errorClass) return "—";
  const detail =
    run.errorClass !== "rate_limited" && run.errorMessage
      ? run.errorMessage
      : null;
  const localized = detail ? localizedProviderMessage(detail, locale) : null;
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
