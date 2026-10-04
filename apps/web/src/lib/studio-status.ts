import type {
  DeviceStatusData,
  DeviceStatusItemStatus,
} from "@netrics/contracts";
import {
  sortSourceItems,
  sourceItemStatus,
  statusAge,
  statusCounts,
  statusLayout,
  statusRowLabel,
  statusRowsShown,
  wrappedLineCount,
  type Locale,
  type StatusLayout,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import type { StudioConnection } from "./studio-widgets";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  type ScreenPlacement,
  type WidgetLabelLayout,
} from "./studio-render";

// How the web lays out a status board (ADR 0019 section 7): the domain's
// `statusLayout` (shared with tvOS through the studio-layout vectors) for
// the rows that fit and the name sizes; the ages computed here from
// `lastSuccessAt`, so they stay current between payloads.

export type StatusItem = DeviceStatusData["items"][number];

/** A dot's colour: theme tokens only (ADR 0018 section 5). */
export type StatusTone = "up" | "warning" | "muted" | "down";

export function statusTone(
  status: DeviceStatusItemStatus | string,
): StatusTone {
  switch (status) {
    case "ok":
      return "up";
    case "stale":
      return "warning";
    case "auth_failed":
    case "outage":
      return "down";
    default:
      return "muted";
  }
}

/** "14 m", "3 h", "2 d" ("14 min", "3 h", "2 T"); "never" without one. */
export function statusAgeText(
  lastSuccessAt: string | null,
  now: number,
  locale: Locale,
): string {
  const t = webTranslator(locale, "screen.widget");
  const age = statusAge(lastSuccessAt, now);
  return age
    ? t("statusAge", { unit: age.unit, count: age.amount })
    : t("statusNever");
}

/**
 * The footer: "4 connected · 1 failing · 1 delayed", dropping the counts
 * from the end (the delayed ones first) until it fits one line of `width`
 * units at `size`.
 */
export function statusFooterText(
  items: readonly { status: string }[],
  locale: Locale,
  fit?: { width: number; size: number },
): string {
  const t = webTranslator(locale, "screen.widget");
  const counts = statusCounts(items);
  const parts = [t("statusConnected", { count: counts.connected })];
  if (counts.failing > 0) {
    parts.push(t("statusFailing", { count: counts.failing }));
  }
  if (counts.delayed > 0) {
    parts.push(t("statusDelayed", { count: counts.delayed }));
  }
  while (
    fit &&
    parts.length > 1 &&
    wrappedLineCount(parts.join(" · "), fit.width, fit.size) > 1
  ) {
    parts.pop();
  }
  return parts.join(" · ");
}

/**
 * A signed-in browser's status items from the workspace's connections, by
 * the rules the server applies to screen payloads (the server also knows
 * later backfills, from its jobs): the chosen ones, or all, attention
 * first.
 */
export function liveStatusItems(
  connections: Readonly<Record<string, StudioConnection>>,
  connectionIds: readonly string[] | null,
  now: number,
): StatusItem[] {
  const chosen = connectionIds ? new Set(connectionIds) : null;
  return sortSourceItems(
    Object.entries(connections)
      .filter(([id]) => !chosen || chosen.has(id))
      .map(([id, connection]) => ({
        connectionId: id,
        name: connection.name,
        status: sourceItemStatus(
          {
            health: connection.state.health,
            lastSuccessAt: connection.state.lastSuccessAt,
            pollIntervalSeconds: connection.state.pollIntervalSeconds,
            setupPending: connection.setupPending ?? false,
          },
          now,
        ),
        lastSuccessAt: connection.state.lastSuccessAt,
      })),
  );
}

export interface StatusRowView {
  connectionId: string;
  name: string;
  status: StatusItem["status"];
  tone: StatusTone;
  /** "14 m"; null without the age column. */
  age: string | null;
  /** The name's size in units, and whether it ends with an ellipsis. */
  nameSize: number;
  truncated: boolean;
}

export interface StatusWidgetLayout {
  label: WidgetLabelLayout;
  status: StatusLayout;
  rows: StatusRowView[];
  /** The last row, "+N more", when items do not fit; its tone is the worst hidden one's. */
  more: { count: number; tone: StatusTone } | null;
  footer: string;
}

const TONE_RANK: Readonly<Record<StatusTone, number>> = {
  down: 0,
  warning: 1,
  muted: 2,
  up: 3,
};

/**
 * A status board at its size: the label, as many rows as fit, the last one
 * "+N more" when the items do not (problems sort first, so they are never
 * the hidden ones while there is a row for each), and the footer.
 */
export function statusWidgetLayout(input: {
  label: string;
  items: readonly StatusItem[];
  showAge: boolean;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  now: number;
  locale: Locale;
}): StatusWidgetLayout {
  const box = contentBox(input.placement, input.showHeader);
  const status = statusLayout({
    label: input.label,
    width: box.width,
    height: box.height,
    fontScale: input.fontScale,
    showAge: input.showAge,
  });
  const { shown, more } = statusRowsShown(
    input.items.length,
    status.rowCapacity,
  );
  const rows = input.items.slice(0, shown).map((item) => {
    const fitted = statusRowLabel(item.name, status.columns.name, status.sizes);
    return {
      connectionId: item.connectionId,
      name: item.name,
      status: item.status,
      tone: statusTone(item.status),
      age: input.showAge
        ? statusAgeText(item.lastSuccessAt, input.now, input.locale)
        : null,
      nameSize: fitted.size,
      truncated: fitted.truncated,
    };
  });
  const hidden = input.items.slice(shown);
  const worst = hidden
    .map((item) => statusTone(item.status))
    .sort((a, b) => TONE_RANK[a] - TONE_RANK[b])[0];
  const sizes = typeScaleFor(
    "status",
    input.placement,
    input.fontScale,
    input.showHeader,
  );
  return {
    label: labelLayout(input.label, box.width, sizes),
    status,
    rows,
    more:
      more > 0
        ? {
            count: more,
            tone: worst === "down" || worst === "warning" ? worst : "muted",
          }
        : null,
    footer: statusFooterText(input.items, input.locale, {
      width: box.width,
      size: status.sizes.footer,
    }),
  };
}
