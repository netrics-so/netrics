"use client";

import { useMemo, useRef } from "react";

import type { StudioPlacement } from "@netrics/domain";
import { sourcesLabel } from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import { u } from "@/lib/studio-render";
import {
  liveStatusItems,
  statusWidgetLayout,
  type StatusItem,
} from "@/lib/studio-status";
import type { StudioEnv, StudioWidget } from "@/lib/studio-widgets";

import { useNow } from "./clock-widget";
import { useRowRise } from "./enter-motion";
import { WidgetFooter, WidgetLabel } from "./widget-parts";

export type StatusWidget = Extract<StudioWidget, { type: "status" }>;

export interface StatusReadingProps {
  label: string;
  options: { showAge: boolean };
  /** Attention first, then by name (the server's or `liveStatusItems`). */
  items: readonly StatusItem[];
}

export interface StatusWidgetViewProps extends StatusReadingProps {
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
}

/**
 * The status board (ADR 0019 section 7, design 4a "Sources"): one row per
 * source with a health dot (`up`, `warning`, `muted`, `down`), its name
 * (shrunk to 24 units, then an ellipsis) and the age of its last
 * successful sync, `warning` when stale; "+N more" when they do not fit,
 * and the footer "4 connected · 1 delayed". A status display: no data
 * states of its own. Rows rise into place on slide enter.
 */
export function StatusWidgetView(props: StatusWidgetViewProps) {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow();
  const rowsRef = useRef<HTMLOListElement>(null);
  useRowRise(rowsRef);
  const layout = statusWidgetLayout({
    label: props.label,
    items: props.items,
    showAge: props.options.showAge,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
    now: now.getTime(),
    locale,
  });
  const { status } = layout;
  const row = {
    height: u(status.rowPitch),
    paddingTop: u(status.rowPitch - status.sizes.cell * 1.15),
    lineHeight: u(status.sizes.cell * 1.15),
    columnGap: u(status.columns.gap),
  };
  const dot = { width: u(status.columns.dot), height: u(status.columns.dot) };

  return (
    <article className="sw sw-status">
      <WidgetLabel layout={layout.label} />
      {props.items.length === 0 ? (
        <p
          className="sw-muted sw-status-empty"
          style={{ fontSize: u(status.sizes.cell) }}
        >
          {t("statusEmpty")}
        </p>
      ) : (
        <ol
          ref={rowsRef}
          className="sw-status-rows"
          style={{ fontSize: u(status.sizes.cell) }}
        >
          {layout.rows.map((item, index) => (
            <li
              key={item.connectionId}
              className={`sw-status-row ${item.tone}`}
              data-rise={index}
              style={row}
              aria-label={t("statusItem", {
                name: item.name,
                status: item.status,
              })}
            >
              <span className="sw-status-dot" style={dot} aria-hidden="true" />
              <span
                className="sw-status-name"
                style={{ fontSize: u(item.nameSize) }}
                title={item.truncated ? item.name : undefined}
                data-truncated={item.truncated ? "true" : undefined}
                aria-hidden="true"
              >
                {item.name}
              </span>
              {item.age !== null ? (
                <span
                  className={
                    item.status === "stale"
                      ? "sw-status-age stale"
                      : "sw-status-age"
                  }
                  style={{ fontSize: u(status.sizes.age) }}
                  aria-hidden="true"
                  suppressHydrationWarning
                >
                  {item.age}
                </span>
              ) : null}
            </li>
          ))}
          {layout.more ? (
            <li
              className={`sw-status-row sw-status-more ${layout.more.tone}`}
              data-rise={layout.rows.length}
              style={row}
            >
              <span
                className="sw-status-dot"
                style={{ ...dot, visibility: "hidden" }}
                aria-hidden="true"
              />
              <span
                className="sw-status-name"
                style={{ fontSize: u(status.sizes.cell) }}
              >
                {t("statusMore", { count: layout.more.count })}
              </span>
            </li>
          ) : null}
        </ol>
      )}
      {props.items.length > 0 ? (
        <WidgetFooter size={status.sizes.footer}>{layout.footer}</WidgetFooter>
      ) : null}
    </article>
  );
}

/** A status board's live items (signed-in pages): the workspace's connections. */
export function useLiveStatus(
  widget: StatusWidget,
  env: StudioEnv,
): StatusReadingProps {
  const locale = useLocale();
  const now = useNow();
  const minute = Math.floor(now.getTime() / 60_000);
  const items = useMemo(
    () =>
      liveStatusItems(
        env.connections,
        widget.options.connectionIds,
        minute * 60_000,
      ),
    [env.connections, widget.options.connectionIds, minute],
  );
  return {
    label: widget.title ?? sourcesLabel(locale),
    options: widget.options,
    items,
  };
}

/** A status board from the workspace's connections (signed-in pages). */
export function LiveStatusWidget({
  widget,
  env,
}: {
  widget: StatusWidget;
  env: StudioEnv;
}) {
  return (
    <StatusWidgetView
      {...useLiveStatus(widget, env)}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
