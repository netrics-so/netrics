import { useRef, type ReactNode } from "react";

import type { DeviceTileStatus, WidgetFreshness } from "@netrics/contracts";
import type { StudioPlacement } from "@netrics/domain";

import {
  freshnessCandidates,
  freshnessNotice,
  isWarningStatus,
  plainTwin,
  type FreshnessClock,
} from "@/lib/freshness";
import type { WebTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTimeIn } from "@/lib/relative-time";
import {
  footerLine,
  u,
  type FittedLabel,
  type WidgetLabelLayout,
} from "@/lib/studio-render";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

import { useNow } from "./clock-widget";
import { useDrawnCut } from "./drawn-fit";

/**
 * A title or resource line: wrapped to at most two lines at its fitted
 * size. When it needs more even at the minimum, the second line ends in an
 * ellipsis and the full text stays in the tooltip (never cut silently).
 */
function LabelLine({
  fitted,
  className,
  as: Tag,
}: {
  fitted: FittedLabel;
  className: string;
  as: "h3" | "p";
}) {
  return (
    <Tag
      className={className}
      style={{ fontSize: u(fitted.size) }}
      title={fitted.truncated ? fitted.text : undefined}
      data-truncated={fitted.truncated ? "true" : undefined}
    >
      {fitted.text}
    </Tag>
  );
}

/** A data widget's label: the metric (or title), then the resource. */
export function WidgetLabel({ layout }: { layout: WidgetLabelLayout }) {
  return (
    <div className="sw-label">
      <LabelLine fitted={layout.title} className="sw-title" as="h3" />
      {layout.resource ? (
        <LabelLine fitted={layout.resource} className="sw-resource" as="p" />
      ) : null}
    </div>
  );
}

/**
 * The footer's candidates, longest first: "updated 2 min. ago · Stripe",
 * "updated 2 min. ago", "Stripe" (ADR 0018 section 5). The time is the
 * data's last successful sync, worded by Intl in the viewer's language.
 *
 * With `freshness` (ADR 0025 section 8) the freshness line replaces them:
 * "Up to Nov 15 · fetched 10 min. ago · next ~9:00 PM", dropping parts
 * from the end; under a warning status only the covered day. Times are in
 * the viewer's time zone (`clock.timeZone`, #749).
 */
export function footerCandidates(
  updatedAt: string | null | undefined,
  source: string | null | undefined,
  clock: FreshnessClock,
  t: WebTranslator<"screen.widget">,
  freshness?: WidgetFreshness | null,
  status?: DeviceTileStatus,
): string[] {
  const { locale, now } = clock;
  // Backfilling and no data stay as today (precedence 2).
  if (freshness && status !== "backfilling" && status !== "no_data") {
    const fresh = freshnessCandidates(freshness, clock, {
      warning: isWarningStatus(status),
    });
    if (fresh.length > 0) return fresh;
  }
  const time = relativeTimeIn(updatedAt ?? null, locale, now, "short");
  const name = source?.trim() || null;
  const candidates: string[] = [];
  if (time && name) candidates.push(t("updatedFrom", { time, source: name }));
  if (time) candidates.push(t("updated", { time }));
  if (name) candidates.push(name);
  return candidates;
}

/** `footerCandidates` for the viewer, worded anew every minute. */
export function useFooterCandidates(
  updatedAt: string | null | undefined,
  source: string | null | undefined,
  freshness?: WidgetFreshness | null,
  status?: DeviceTileStatus,
): string[] {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow();
  const timeZone = useViewerTimeZone();
  return footerCandidates(
    updatedAt,
    source,
    { locale, now: now.getTime(), timeZone },
    t,
    freshness,
    status,
  );
}

/**
 * A data widget's props with its warning notice worded with its freshness
 * (ADR 0025 section 8, precedence 1): an overdue provider in the late
 * wording, any other warning with the covered day. Unchanged without
 * freshness.
 */
export function useFreshnessNotice<
  P extends {
    notice: string | null;
    status?: DeviceTileStatus;
    freshness?: WidgetFreshness | null;
  },
>(props: P): P {
  const locale = useLocale();
  const now = useNow();
  const timeZone = useViewerTimeZone();
  if (!props.freshness) return props;
  return {
    ...props,
    notice: freshnessNotice(props.notice, props.status, props.freshness, {
      locale,
      now: now.getTime(),
      timeZone,
    }),
  };
}

/**
 * The freshness footer: one muted line at the bottom of the widget.
 *
 * With `candidates` (the list the footer was picked from) a footer that
 * names the last reporting day (#791) is checked as drawn: the layout
 * picked it by estimated widths, and where the browser cuts it with an
 * ellipsis the widget shows the plain line of the same parts instead, as
 * before. Scroll cards wrap and pass none.
 */
export function WidgetFooter({
  size,
  children,
  candidates,
}: {
  size: number;
  children: ReactNode;
  candidates?: readonly (string | null)[];
}) {
  const locale = useLocale();
  const line = useRef<HTMLParagraphElement>(null);
  const text = typeof children === "string" ? children : null;
  const plain = candidates ? plainTwin(candidates, text, locale) : null;
  const cut = useDrawnCut(plain === null ? null : text, () => [line.current]);
  return (
    <p
      ref={line}
      className="sw-muted sw-source sw-footer"
      style={{ fontSize: u(size) }}
      suppressHydrationWarning
    >
      {cut ? plain : children}
    </p>
  );
}

/**
 * A stale or failure notice in the theme's warning colour. A stale one
 * (the data's last sync is too long ago) starts with a dot that blinks on
 * player slides (ADR 0018 sections 5 and 6); the others with a sign.
 */
export function WidgetNotice({
  size,
  children,
  title,
  stale = false,
}: {
  size: number;
  children: ReactNode;
  title?: string;
  stale?: boolean;
}) {
  return (
    <p
      className={stale ? "sw-notice sw-notice--stale" : "sw-notice"}
      style={{ fontSize: u(size) }}
      title={title}
    >
      {stale ? (
        <span className="sw-stale-dot" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">⚠</span>
      )}{" "}
      {children}
    </p>
  );
}

/** The data states with a surface of their own (ADR 0018 section 5). */
export type DataSurface = "auth_failed" | "no_data" | "backfilling";

/**
 * Which surface a widget's data status takes: auth failed, no data and
 * backfilling replace the numbers; null keeps the widget (ok, outage with
 * its notice, stale with its warning border and dimmed value).
 */
export function dataSurfaceOf(
  status: DeviceTileStatus | undefined,
): DataSurface | null {
  return status === "auth_failed" ||
    status === "no_data" ||
    status === "backfilling"
    ? status
    : null;
}

/** The class a data widget's box adds for its status. */
export function statusClass(status: DeviceTileStatus | undefined): string {
  switch (status) {
    case "stale":
      return " sw--stale";
    case "auth_failed":
      return " sw--auth";
    case "no_data":
    case "backfilling":
      return " sw--empty";
    default:
      return "";
  }
}

/** "Reconnect …" in units: the design's 19 px at 2/3 scale. */
const RECONNECT_SIZE = 28.5;
/** The skeleton block's height in units (the design's 40 px). */
const SKELETON_HEIGHT = 60;

/**
 * A data widget whose numbers cannot be shown (design 4b): its label, then
 * for auth failed "Reconnect {source}" with a hint and the last good
 * sync in the footer; for no data and backfilling a skeleton block (with
 * the sweep while the history loads) and what is going on. No value, no
 * chart. The label and the sizes are the widget's own layout's, so the
 * shared layout math is unchanged.
 */
export function DataStateWidget({
  type,
  surface,
  label,
  small,
  source,
  updatedAt,
  freshness,
  placement,
  showHeader,
  fontScale,
  reconnectText,
  reconnectHint,
  emptyText,
}: {
  type: "metric" | "line" | "bar" | "table" | "compare" | "gauge" | "review";
  surface: DataSurface;
  label: WidgetLabelLayout;
  /** The layout's smallest text size (at least 24 units). */
  small: number;
  source: string | null | undefined;
  updatedAt: string | null | undefined;
  /** Auth failed: the footer keeps the covered day (ADR 0025). */
  freshness?: WidgetFreshness | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  /** Auth failed: instead of "Reconnect {source}" and its hint. */
  reconnectText?: string;
  reconnectHint?: string;
  /** No data: instead of "No data yet". */
  emptyText?: string;
}) {
  const t = useT("screen.widget");
  // The source is in "Reconnect …": the footer says when it last worked.
  const candidates = useFooterCandidates(
    updatedAt,
    null,
    freshness,
    surface === "auth_failed" ? "auth_failed" : undefined,
  );
  const name = source?.trim() || null;
  if (surface === "auth_failed") {
    const footer = footerLine(candidates, {
      type,
      placement,
      showHeader,
      fontScale,
    });
    return (
      <article className={`sw sw-${type} sw--auth`}>
        <WidgetLabel layout={label} />
        <div className="sw-state">
          <p
            className="sw-reconnect"
            style={{ fontSize: u(Math.max(RECONNECT_SIZE, small * 1.1875)) }}
          >
            {reconnectText ??
              (name ? t("reconnect", { source: name }) : t("reconnectSource"))}
          </p>
          <p className="sw-muted sw-state-hint" style={{ fontSize: u(small) }}>
            {reconnectHint ?? t("reconnectHint")}
          </p>
        </div>
        {footer ? (
          <WidgetFooter size={small} candidates={candidates}>
            {footer}
          </WidgetFooter>
        ) : null}
      </article>
    );
  }
  const backfilling = surface === "backfilling";
  return (
    <article
      className={`sw sw-${type} sw--empty`}
      aria-busy={backfilling ? true : undefined}
    >
      <WidgetLabel layout={label} />
      <div className="sw-state">
        <span
          className="sw-skeleton"
          style={{ height: u(SKELETON_HEIGHT) }}
          aria-hidden="true"
        >
          {backfilling ? <span className="sw-skeleton-sweep" /> : null}
        </span>
        <p className="sw-muted sw-state-hint" style={{ fontSize: u(small) }}>
          {backfilling ? t("loadingHistory") : (emptyText ?? t("noDataShort"))}
        </p>
      </div>
    </article>
  );
}
