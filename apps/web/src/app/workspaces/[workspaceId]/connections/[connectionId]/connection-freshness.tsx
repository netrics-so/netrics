"use client";

import type {
  ConnectionAuthState,
  ConnectionFreshnessStream,
} from "@netrics/contracts";
import { useNow } from "@/components/studio/clock-widget";
import {
  entryFreshness,
  freshnessParts,
  type FreshnessClock,
} from "@/lib/freshness";
import { webTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

export interface FreshnessLine {
  key: string;
  /** The resource's name for a per-resource entry; null: the connection. */
  resource: string | null;
  /** "Sales up to Nov 15 · next ~9:00 PM". */
  text: string;
  /** Late by a day or more: the warning style. */
  overdue: boolean;
}

/**
 * A connection's streams as the page lists them (ADR 0025 section 8): one
 * line per entry, the stream's name first ("Sales up to Nov 15 · next
 * ~9:00 PM", "Reviews checked 10 min. ago · next check ~2:30 PM"), the
 * connection's entry before its resources'; "not checked yet" before any
 * run reported the stream. In the viewer's time zone (#749).
 */
export function freshnessLines(
  streams: readonly ConnectionFreshnessStream[],
  nextCheckAt: string | null,
  resourceNames: Readonly<Record<string, string>>,
  clock: FreshnessClock,
  /**
   * The connection's auth state: while it needs new credentials or a
   * reconnect, the scheduler skips it, so no line promises a next check.
   */
  authState: ConnectionAuthState = "ok",
): FreshnessLine[] {
  const paused =
    authState === "auth_failed" || authState === "needs_reauthorization";
  const t = webTranslator(clock.locale, "screen.freshness");
  return streams.flatMap((stream) => {
    if (stream.entries.length === 0) {
      return [
        {
          key: stream.key,
          resource: null,
          text: t("notChecked", { stream: stream.name }),
          overdue: false,
        },
      ];
    }
    const entries = [...stream.entries].sort(
      (a, b) =>
        Number(a.resource !== null) - Number(b.resource !== null) ||
        (resourceNames[a.resource ?? ""] ?? a.resource ?? "").localeCompare(
          resourceNames[b.resource ?? ""] ?? b.resource ?? "",
        ),
    );
    return entries.map((entry) => {
      const line = entryFreshness(stream, entry, nextCheckAt);
      return {
        key: `${stream.key}:${entry.resource ?? ""}`,
        resource:
          entry.resource === null
            ? null
            : (resourceNames[entry.resource] ?? entry.resource),
        text: freshnessParts(line.freshness, clock, {
          stream: true,
          fetched: false,
          warning: line.overdue,
          paused,
        }).join(" · "),
        overdue: line.overdue,
      };
    });
  });
}

/** The connection page's "Data freshness" card; nothing without streams. */
export function ConnectionFreshness({
  streams,
  nextCheckAt,
  resourceNames,
  authState,
}: {
  streams: readonly ConnectionFreshnessStream[];
  nextCheckAt: string | null;
  resourceNames: Readonly<Record<string, string>>;
  authState: ConnectionAuthState;
}) {
  const locale = useLocale();
  const t = useT("connections.detail");
  const now = useNow();
  const timeZone = useViewerTimeZone();
  if (streams.length === 0) return null;
  const lines = freshnessLines(
    streams,
    nextCheckAt,
    resourceNames,
    { locale, now: now.getTime(), timeZone },
    authState,
  );
  return (
    <div className="card" id="freshness">
      <h2>{t("freshnessTitle")}</h2>
      <p className="muted">{t("freshnessHelp")}</p>
      <ul className="freshness-list">
        {lines.map((line) => (
          <li
            key={line.key}
            className={line.overdue ? "freshness-overdue" : undefined}
            data-testid="freshness-line"
            suppressHydrationWarning
          >
            {line.resource ? (
              <span className="muted">{line.resource}: </span>
            ) : null}
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
