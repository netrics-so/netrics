"use client";

import { useEffect, useState } from "react";

import { clockLayout, type ClockDateStyle } from "@netrics/domain";

import { useLocale } from "@/lib/i18n/client";
import { clockText, msUntilNextMinute } from "@/lib/studio-clock";
import { contentBox, u, type ScreenPlacement } from "@/lib/studio-render";

/**
 * The current time, re-rendered when the minute changes. Before hydration
 * it is the server's time; the clock corrects itself on mount.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, msUntilNextMinute(Date.now()) + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

export interface ClockWidgetViewProps {
  now: Date;
  timeZone: string;
  options: {
    showDate: boolean;
    hour12: boolean;
    /** Absent from older payloads: the short date. */
    dateStyle?: ClockDateStyle;
    showZone?: boolean;
  };
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
}

/**
 * The clock widget: the time in the accent colour, as large as the widget
 * allows (at least 56 units), the date below it and the zone line (ADR
 * 0019, section 9). Lines that do not fit are left out, the zone line
 * first (`clockLayout`; the Studio says so with `clock_parts_hidden`).
 */
export function ClockWidgetView(props: ClockWidgetViewProps) {
  const locale = useLocale();
  const dateStyle = props.options.dateStyle ?? "short";
  const showZone = props.options.showZone ?? false;
  const text = clockText(props.now, {
    locale,
    timeZone: props.timeZone,
    hour12: props.options.hour12,
    showDate: props.options.showDate,
    dateStyle,
    showZone,
  });
  const layout = clockLayout({
    placement: props.placement,
    box: contentBox(props.placement, props.showHeader),
    fontScale: props.fontScale,
    showHeader: props.showHeader,
    time: text.time,
    showDate: props.options.showDate,
    dateStyle,
    zone: showZone ? props.timeZone : null,
  });
  return (
    <div className="sw sw-clock">
      <time
        className="sw-clock-time"
        style={{ fontSize: u(layout.time) }}
        suppressHydrationWarning
      >
        {text.time}
      </time>
      {text.date !== null && layout.date !== null ? (
        <span
          className="sw-clock-date"
          style={{ fontSize: u(layout.date) }}
          suppressHydrationWarning
        >
          {text.date}
        </span>
      ) : null}
      {text.zone !== null && layout.zone !== null ? (
        <span
          className="sw-clock-zone"
          style={{ fontSize: u(layout.zone) }}
          suppressHydrationWarning
        >
          {text.zone}
        </span>
      ) : null}
    </div>
  );
}

/** A clock that ticks on its own, in its zone or the workspace's. */
export function LiveClockWidget(
  props: Omit<ClockWidgetViewProps, "now" | "timeZone"> & {
    timeZone: string | null;
    workspaceTimeZone: string;
  },
) {
  const now = useNow();
  return (
    <ClockWidgetView
      {...props}
      now={now}
      timeZone={props.timeZone ?? props.workspaceTimeZone}
    />
  );
}
