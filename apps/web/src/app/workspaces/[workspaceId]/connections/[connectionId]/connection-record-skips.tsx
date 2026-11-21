"use client";

import type { ConnectionRecordSkips as StreamRecordSkips } from "@netrics/contracts";
import { useNow } from "@/components/studio/clock-widget";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";

/**
 * A custom API connection's skipped records (#834 review): per stream, how
 * many records the last sync skipped and which field that may not be empty
 * was empty or unreadable in them (paths only, never values). Nothing
 * before the first sync.
 */
export function ConnectionRecordSkips({
  streams,
  now,
}: {
  streams: readonly StreamRecordSkips[];
  /** Tests: a fixed clock for "… ago". */
  now?: number;
}) {
  const locale = useLocale();
  const t = useT("sources.recordSkips");
  const clock = useNow();
  if (streams.length === 0) return null;
  const at = now ?? clock.getTime();
  const skipping = streams.some((stream) => stream.skipped > 0);
  return (
    <div className="card" id="record-skips">
      <h2>{t("title")}</h2>
      <ul className="freshness-list">
        {streams.map((stream) => (
          <li key={stream.streamKey} data-testid="record-skips-stream">
            <span
              className={stream.skipped > 0 ? "freshness-overdue" : undefined}
              suppressHydrationWarning
            >
              {t(stream.skipped > 0 ? "summary" : "none", {
                count: stream.skipped,
                stream: stream.streamName,
                time: relativeTime(stream.checkedAt, locale, at),
              })}
            </span>
            {stream.skippedFields.length ? (
              <ul>
                {stream.skippedFields.map((field) => (
                  <li key={field.path}>
                    {t("field", { path: field.path, count: field.count })}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {skipping ? <p className="help">{t("help")}</p> : null}
    </div>
  );
}
