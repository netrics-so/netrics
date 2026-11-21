"use client";

import { ApiError, apiErrorMessage } from "@/lib/api";
import type { CustomApiTestResponse } from "@netrics/contracts";

import { useLocale, useT } from "@/lib/i18n/client";

import { RequestLog } from "./request-log";

/**
 * The test panel (steps 3–6): how the last test request went, whether the
 * answer was shortened, and its request log.
 */
export function TestPanel({
  test,
  error,
  pending,
}: {
  test: CustomApiTestResponse | null;
  /** A refused test request (rate limit, host change, expired draft). */
  error: string | null;
  pending: boolean;
}) {
  const t = useT("customApi.test");
  const response = useT("customApi.response");
  const locale = useLocale();
  return (
    <aside className="custom-api-panel card" aria-live="polite">
      <h2>{t("title")}</h2>
      {pending ? <p className="muted">{t("running")}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {test && !error ? (
        test.ok ? (
          <p className="custom-api-ok">
            {t("ok")}
            {test.response
              ? ` · ${t("status", { status: test.response.status })}`
              : ""}
          </p>
        ) : (
          <p className="error" role="alert">
            {test.error
              ? apiErrorMessage(new ApiError(200, test.error.code), locale)
              : null}
          </p>
        )
      ) : null}
      {test?.truncated ? <p className="help">{response("truncated")}</p> : null}
      {test?.window ? (
        <p className="help">
          {t("window", { start: test.window.start, end: test.window.end })}
        </p>
      ) : null}
      {test ? <RequestLog log={test.log} /> : null}
    </aside>
  );
}
