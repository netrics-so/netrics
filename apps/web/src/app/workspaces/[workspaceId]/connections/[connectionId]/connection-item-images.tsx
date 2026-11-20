"use client";

import {
  CUSTOM_API_IMAGE_SKIP_REASONS,
  type ConnectionItemImages as StreamItemImages,
} from "@netrics/contracts";
import { useNow } from "@/components/studio/clock-widget";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTime } from "@/lib/relative-time";

/**
 * A custom API connection's item images (#809): per image stream, how many
 * of its newest items' images are stored, when they were last checked, and
 * how many were skipped, by reason. Nothing for a connection without image
 * streams, or before their first check.
 */
export function ConnectionItemImages({
  streams,
  now,
}: {
  streams: readonly StreamItemImages[];
  /** Tests: a fixed clock for "checked … ago". */
  now?: number;
}) {
  const locale = useLocale();
  const t = useT("sources.itemImages");
  const clock = useNow();
  if (streams.length === 0) return null;
  const at = now ?? clock.getTime();
  return (
    <div className="card" id="item-images">
      <h2>{t("title")}</h2>
      <ul className="freshness-list">
        {streams.map((stream) => (
          <li key={stream.streamKey} data-testid="item-images-stream">
            <span suppressHydrationWarning>
              {t("summary", {
                stored: stream.stored + stream.unchanged,
                stream: stream.streamName,
                time: relativeTime(stream.checkedAt, locale, at),
              })}
            </span>
            {stream.skipped > 0 ? (
              <>
                {" · "}
                <span className="freshness-overdue">
                  {t("skipped", { skipped: stream.skipped })}
                </span>
                <ul>
                  {CUSTOM_API_IMAGE_SKIP_REASONS.flatMap((reason) => {
                    const count = stream.skippedReasons[reason];
                    return count
                      ? [
                          <li key={reason} data-testid="item-images-reason">
                            {count} × {t(`reasons.${reason}`)}
                          </li>,
                        ]
                      : [];
                  })}
                </ul>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
