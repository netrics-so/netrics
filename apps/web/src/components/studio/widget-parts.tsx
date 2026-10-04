import type { ReactNode } from "react";

import type { Locale } from "@netrics/domain";

import type { WebTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTimeIn } from "@/lib/relative-time";
import {
  u,
  type FittedLabel,
  type WidgetLabelLayout,
} from "@/lib/studio-render";

import { useNow } from "./clock-widget";

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
 */
export function footerCandidates(
  updatedAt: string | null | undefined,
  source: string | null | undefined,
  locale: Locale,
  t: WebTranslator<"screen.widget">,
  now: number = Date.now(),
): string[] {
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
): string[] {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow();
  return footerCandidates(updatedAt, source, locale, t, now.getTime());
}

/** The freshness footer: one muted line at the bottom of the widget. */
export function WidgetFooter({
  size,
  children,
}: {
  size: number;
  children: ReactNode;
}) {
  return (
    <p
      className="sw-muted sw-source sw-footer"
      style={{ fontSize: u(size) }}
      suppressHydrationWarning
    >
      {children}
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
