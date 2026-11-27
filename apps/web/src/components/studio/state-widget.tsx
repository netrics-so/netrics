"use client";

import { useEffect, useRef, useState } from "react";

import type {
  DashboardWidget,
  StateWidgetData,
  StateWidgetOptions,
  WidgetFreshness,
} from "@netrics/contracts";
import {
  estimateTextWidth,
  serviceStateCounts,
  serviceStateHiddenTone,
  serviceStateIcon,
  serviceStateRowsShown,
  serviceStateSummary,
  STUDIO_SPACING,
  serviceStateTone,
  stateWidgetLabel,
  statusLayout,
  statusRowLabel,
  type ServiceState,
  type ServiceStateCounts,
  type ServiceStateIcon,
  type ServiceStateSummary,
} from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import { relativeTimeIn } from "@/lib/relative-time";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  u,
  type ScreenPlacement,
} from "@/lib/studio-render";
import { statusAgeText } from "@/lib/studio-status";
import type { StudioEnv } from "@/lib/studio-widgets";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";

import { useNow } from "./clock-widget";
import { useDashboardData } from "./dashboard-data-provider";
import { useRowRise } from "./enter-motion";
import {
  WidgetFooter,
  WidgetLabel,
  WidgetNotice,
  useFooterCandidates,
} from "./widget-parts";

// The state widget (#875, ADR 0019 section 15): whether services, servers,
// deployments or checks are up. A list (not healthy first, "+N more" past
// the rows that fit, the status board's row layout) or one item's state at
// a large size. Every state is a word and an icon of its own shape, its
// colour only a third cue, so nothing is told by colour alone.

export type StateWidget = Extract<DashboardWidget, { type: "state" }>;

/** An item as screens draw it (the server's, or a payload's). */
export interface StateItemView {
  name: string | null;
  state: ServiceState;
  rolledBack: boolean;
  changedAt: string | null;
}

/** The options a screen draws by (the mapping stays on the server). */
export type StateViewOptions = Pick<
  StateWidgetOptions,
  "layout" | "item" | "limit" | "showChanged"
>;

/** The icon's strokes on a 24 × 24 box, drawn in `currentColor`. */
const ICON_PATHS: Record<ServiceStateIcon, string> = {
  check: "M6 12.5l4 4 8-9",
  cross: "M7 7l10 10M17 7L7 17",
  exclamation: "M12 6v8M12 17.5v.5",
  arrows: "M18 8a7 7 0 0 0-12 1M6 16a7 7 0 0 0 12-1M18 4v4h-4M6 20v-4h4",
  moon: "M16 15.5A7 7 0 0 1 9 6a7 7 0 1 0 7 9.5z",
  question: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17.5v.5",
};

/** A state's icon: a distinct shape per state, inside a ring. */
export function StateIcon({
  state,
  size,
}: {
  state: ServiceState;
  size: string;
}) {
  const icon = serviceStateIcon(state);
  return (
    <svg
      className={`sw-svc-icon sw-svc-icon--${icon}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      data-icon={icon}
    >
      <circle cx="12" cy="12" r="10.5" />
      <path d={ICON_PATHS[icon]} />
    </svg>
  );
}

/** "Up", "Up · rolled back", "Failed" in the viewer's language. */
export function useStateWords() {
  const t = useT("screen.state");
  return (item: Pick<StateItemView, "state" | "rolledBack">) =>
    item.state === "up" && item.rolledBack
      ? `${t("up")} · ${t("rolledBack")}`
      : t(item.state);
}

export interface StateWidgetViewProps {
  label: string;
  items: readonly StateItemView[];
  /** Every matching item, also those the server left out. */
  total: number;
  /** Every matching item per state: the summary and "+N more"'s tone. */
  counts: ServiceStateCounts;
  options: StateViewOptions;
  /** "stale": a last valid snapshot or an overdue source (ADR 0025 §8). */
  status: "ok" | "no_data" | "stale";
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
  audience?: "editor" | "viewer";
  freshness?: WidgetFreshness | null;
  /** The query's error code (editor surfaces name it). */
  error?: string | null;
  loading?: boolean;
  /** Scroll view: as tall as the rows it lists, nothing cut (ADR 0019 §15). */
  grow?: boolean;
}

/**
 * The box a growing state card is laid out in (scroll view, #875 review):
 * half a slide wide and exactly tall enough for `rows` list rows under
 * `label`, the card's own title as it wraps (#900).
 */
export function scrollStatePlacement(
  rows: number,
  fontScale: number,
  label: string,
): {
  placement: ScreenPlacement & { unitBox: { width: number; height: number } };
  rowCapacity: number;
} {
  const base = { x: 0, y: 0, w: 6, h: 6 };
  const width = contentBox(base, false).width;
  const probe = statusLayout({
    label,
    width,
    height: 10_000,
    fontScale,
  });
  const height =
    probe.headHeight +
    probe.footerHeight +
    Math.max(1, rows) * probe.rowPitch +
    2 * STUDIO_SPACING.widgetPadding +
    1;
  const placement = {
    ...base,
    unitBox: { width: width + 2 * STUDIO_SPACING.widgetPadding, height },
  };
  const box = contentBox(placement, false);
  return {
    placement,
    rowCapacity: statusLayout({
      label,
      width: box.width,
      height: box.height,
      fontScale,
    }).rowCapacity,
  };
}

const LOWER = {
  up: "lowerUp",
  down: "lowerDown",
  failed: "lowerFailed",
  building: "lowerBuilding",
  sleeping: "lowerSleeping",
  unknown: "lowerUnknown",
} as const;

export function StateWidgetView(input: StateWidgetViewProps) {
  const t = useT("screen.state");
  const words = useStateWords();
  const locale = useLocale();
  const now = useNow().getTime();
  const rowsRef = useRef<HTMLOListElement>(null);
  useRowRise(rowsRef);
  const listRows =
    input.options.layout === "single"
      ? 1
      : Math.min(input.total, input.options.limit) +
        (input.total > input.options.limit ? 1 : 0);
  const grown = input.grow
    ? scrollStatePlacement(listRows, input.fontScale, input.label).placement
    : null;
  const props = grown ? { ...input, placement: grown } : input;
  const stale = props.status === "stale";
  const box = contentBox(props.placement, props.showHeader);
  const scale = typeScaleFor(
    "state",
    props.placement,
    props.fontScale,
    props.showHeader,
  );
  const label = labelLayout(props.label, box.width, scale);
  const layout = statusLayout({
    label: props.label,
    width: box.width,
    height: box.height,
    fontScale: props.fontScale,
    showAge: props.options.showChanged,
  });
  const footer = useFooterCandidates(
    null,
    null,
    props.freshness ?? null,
    props.status,
  )[0];
  // An old "Up" never reads as current (ADR 0025 §8, review).
  const notice = stale ? (
    <WidgetNotice size={layout.sizes.age} stale>
      {t("stale")}
    </WidgetNotice>
  ) : props.error && props.audience !== "viewer" ? (
    <WidgetNotice size={layout.sizes.cell}>{t("unavailable")}</WidgetNotice>
  ) : null;
  const staleClass = stale ? " sw-stale" : "";
  /** "All 5 up", "2 of 5 down" ("Alle 5 online", "2 von 5 offline"). */
  const summarize = (summary: ServiceStateSummary) =>
    summary.kind === "all_up"
      ? t("summaryAllUp", { count: summary.total })
      : t("summaryWorst", {
          count: summary.count,
          total: summary.total,
          state: summary.rolledBack
            ? t("lowerRolledBack")
            : t(LOWER[summary.state]),
        });
  const empty = (
    <p
      className="sw-placeholder sw-svc-empty"
      style={{ fontSize: u(layout.sizes.cell) }}
    >
      {props.loading ? "…" : t("empty")}
    </p>
  );

  const style = grown ? { height: u(grown.unitBox.height) } : undefined;

  // One item not chosen: a summary of every item (owner decision on #875).
  const summary =
    props.options.layout === "single" && props.options.item === null
      ? serviceStateSummary(props.counts)
      : null;
  if (props.options.layout === "single" && props.options.item === null) {
    const text = summary ? summarize(summary) : "";
    const state = summary?.kind === "worst" ? summary.state : "up";
    const rolledBack = summary?.kind === "worst" && summary.rolledBack;
    const room = Math.max(
      layout.sizes.cell,
      Math.min(
        (box.height - label.height) * 0.4,
        (box.width * 0.8) / Math.max(4, [...text].length * 0.6 + 1.4),
      ),
    );
    return (
      <article
        className={`sw sw-svc sw-svc--single${summary ? ` ${serviceStateTone(state, rolledBack)}` : ""}${staleClass}`}
        aria-busy={props.loading ?? false}
        style={style}
      >
        <WidgetLabel layout={label} />
        {summary ? (
          <div className="sw-svc-single" role="group" aria-label={text}>
            <p
              className="sw-svc-word"
              style={{ fontSize: u(room) }}
              aria-hidden="true"
            >
              <StateIcon state={state} size={u(room * 0.9)} />
              <span>{text}</span>
            </p>
          </div>
        ) : (
          empty
        )}
        {notice}
        {footer && summary ? (
          <WidgetFooter size={layout.sizes.footer}>{footer}</WidgetFooter>
        ) : null}
      </article>
    );
  }

  if (props.options.layout === "single") {
    const item = props.items[0];
    const changed =
      item && props.options.showChanged
        ? relativeTimeIn(item.changedAt, locale, now, "short")
        : null;
    const sub = [
      item?.state === "up" && item.rolledBack ? t("rolledBackLine") : null,
      changed ? t("changed", { time: changed }) : null,
    ].filter((part): part is string => part !== null);
    // The state word as large as the box allows: at least a cell, at most
    // the value size, sized on the word's length (#875).
    const word = item ? t(item.state) : "";
    const room = Math.max(
      layout.sizes.cell,
      Math.min(
        (box.height - label.height) * 0.45,
        (box.width * 0.8) / Math.max(4, [...word].length * 0.6 + 1.4),
      ),
    );
    return (
      <article
        className={`sw sw-svc sw-svc--single${item ? ` ${serviceStateTone(item.state, item.rolledBack)}` : ""}${staleClass}`}
        aria-busy={props.loading ?? false}
        style={style}
      >
        <WidgetLabel layout={label} />
        {item ? (
          <div
            className="sw-svc-single"
            role="group"
            aria-label={t("item", {
              name: item.name ?? "",
              state: words(item),
            })}
          >
            {item.name ? (
              <p
                className="sw-svc-name"
                style={{ fontSize: u(scale.resource ?? layout.sizes.cell) }}
                title={item.name}
                aria-hidden="true"
              >
                {item.name}
              </p>
            ) : null}
            <p
              className="sw-svc-word"
              style={{ fontSize: u(room) }}
              aria-hidden="true"
            >
              <StateIcon state={item.state} size={u(room * 0.9)} />
              <span>{word}</span>
            </p>
            {sub.length ? (
              <p
                className="sw-muted sw-svc-sub"
                style={{ fontSize: u(scale.change ?? layout.sizes.cell) }}
                suppressHydrationWarning
              >
                {sub.join(" · ")}
              </p>
            ) : null}
          </div>
        ) : (
          empty
        )}
        {notice}
        {footer && item ? (
          <WidgetFooter size={layout.sizes.footer}>{footer}</WidgetFooter>
        ) : null}
      </article>
    );
  }

  const { rows, more } = serviceStateRowsShown(
    props.items.length,
    props.total,
    layout.rowCapacity,
  );
  const shown = props.items.slice(0, rows);
  // The most urgent hidden item, also one the server left out (review).
  const hidden = serviceStateHiddenTone(props.counts, shown);
  const hiddenTone =
    hidden === "down" || hidden === "warning" ? hidden : undefined;
  const row = {
    height: u(layout.rowPitch),
    paddingTop: u(layout.rowPitch - layout.sizes.cell * 1.15),
    lineHeight: u(layout.sizes.cell * 1.15),
    columnGap: u(layout.columns.gap),
  };
  const icon = u(layout.sizes.cell);
  return (
    <article
      className={`sw sw-svc sw-svc--list${staleClass}`}
      aria-busy={props.loading ?? false}
      style={style}
    >
      <WidgetLabel layout={label} />
      {shown.length || more > 0 ? (
        <ol
          ref={rowsRef}
          className="sw-status-rows sw-svc-rows"
          style={{ fontSize: u(layout.sizes.cell) }}
        >
          {shown.map((item, index) => {
            // The name takes what the icon, the state word and the age
            // leave (statusLayout reserves the age only).
            const fitted = statusRowLabel(
              item.name ?? "",
              Math.max(
                0,
                layout.columns.name -
                  estimateTextWidth(words(item), layout.sizes.age) -
                  layout.columns.gap,
              ),
              layout.sizes,
            );
            const age =
              props.options.showChanged && item.changedAt
                ? statusAgeText(item.changedAt, now, locale)
                : null;
            return (
              <li
                key={`${item.name ?? ""}:${index}`}
                className={`sw-status-row sw-svc-row ${serviceStateTone(item.state, item.rolledBack)}`}
                data-rise={index}
                data-state={item.state}
                style={row}
                aria-label={t("item", {
                  name: item.name ?? "",
                  state: words(item),
                })}
              >
                <StateIcon state={item.state} size={icon} />
                <span
                  className="sw-status-name"
                  style={{ fontSize: u(fitted.size) }}
                  title={fitted.truncated ? (item.name ?? "") : undefined}
                  aria-hidden="true"
                >
                  {item.name}
                </span>
                <span
                  className="sw-svc-text"
                  style={{ fontSize: u(layout.sizes.age) }}
                  aria-hidden="true"
                >
                  {words(item)}
                </span>
                {age ? (
                  <span
                    className="sw-status-age"
                    style={{ fontSize: u(layout.sizes.age) }}
                    aria-hidden="true"
                    suppressHydrationWarning
                  >
                    {age}
                  </span>
                ) : null}
              </li>
            );
          })}
          {more > 0 ? (
            <li
              className={`sw-status-row sw-status-more ${hiddenTone ?? "muted"}`}
              data-rise={shown.length}
              style={row}
            >
              <span
                className="sw-status-name"
                style={{ fontSize: u(layout.sizes.cell) }}
              >
                {t("more", { count: more })}
              </span>
            </li>
          ) : null}
        </ol>
      ) : (
        empty
      )}
      {notice}
      {footer && (shown.length || more > 0) ? (
        <WidgetFooter size={layout.sizes.footer}>{footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** A state widget's data for signed-in pages: the dashboard's batch, or
 * its own preview where there is none (the Studio's single widget). */
export function useStateData(
  widget: StateWidget,
  env: StudioEnv,
): { data: StateWidgetData | null; loading: boolean } {
  const batch = useDashboardData();
  const [data, setData] = useState<StateWidgetData | null>(null),
    [loading, setLoading] = useState(true);
  const key = JSON.stringify({
    id: widget.id,
    binding: widget.binding,
    options: widget.options,
    filters: env.dataFilters ?? [],
    values: env.filterValues ?? {},
  });
  const batched = batch?.states !== undefined;
  useEffect(() => {
    if (batched) return;
    let alive = true;
    const input = JSON.parse(key) as {
      id: string;
      binding: StateWidget["binding"];
      options: StateWidget["options"];
      filters: NonNullable<StudioEnv["dataFilters"]>;
      values: NonNullable<StudioEnv["filterValues"]>;
    };
    async function refresh() {
      setLoading(true);
      try {
        const response = await previewDashboardMeasures(
          env.workspaceId,
          input.filters,
          input.values,
          [],
          [],
          [{ id: input.id, binding: input.binding, options: input.options }],
        );
        if (alive) setData(response.states[0] ?? null);
      } catch {
        if (alive)
          setData({
            widgetId: input.id,
            status: "no_data",
            items: [],
            total: 0,
            counts: serviceStateCounts([]),
            sourceValues: [],
            error: "data_storage_failed",
            exclusions: input.binding.exclusions,
          });
      } finally {
        if (alive) setLoading(false);
      }
    }
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [env.workspaceId, key, batched]);
  return batched
    ? {
        data: batch!.states!.get(widget.id) ?? null,
        loading: batch!.loading,
      }
    : { data, loading };
}

/** A state widget with its own data, for signed-in pages. */
export function LiveStateWidget({
  widget,
  env,
  grow = false,
}: {
  widget: StateWidget &
    Partial<Pick<ScreenPlacement, "unitBox" | "unitPx" | "format">>;
  env: StudioEnv;
  /** Scroll view: as tall as its rows. */
  grow?: boolean;
}) {
  const locale = useLocale();
  const { data, loading } = useStateData(widget, env);
  return (
    <StateWidgetView
      label={stateWidgetLabel(widget.title, locale)}
      items={data?.items ?? []}
      total={data?.total ?? 0}
      counts={data?.counts ?? serviceStateCounts([])}
      grow={grow}
      options={widget.options}
      status={data?.status ?? "no_data"}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
      audience={env.audience ?? "editor"}
      freshness={data?.freshness ?? null}
      error={data?.error ?? null}
      loading={loading}
    />
  );
}
