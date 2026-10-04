"use client";

import { useEffect, useState } from "react";

import { fitTextSize, type StudioPlacement } from "@netrics/domain";

import { useLocale } from "@/lib/i18n/client";
import { clockText, msUntilNextMinute } from "@/lib/studio-clock";
import {
  LINE_HEIGHT,
  VALUE_LINE_HEIGHT,
  contentBox,
  typeScaleFor,
  u,
} from "@/lib/studio-render";

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
  options: { showDate: boolean; hour12: boolean };
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
}

/**
 * The clock widget: the time in the accent colour, as large as the widget
 * allows (at least 56 units), and the date below it.
 */
export function ClockWidgetView(props: ClockWidgetViewProps) {
  const locale = useLocale();
  const text = clockText(props.now, {
    locale,
    timeZone: props.timeZone,
    hour12: props.options.hour12,
    showDate: props.options.showDate,
  });
  const sizes = typeScaleFor(
    "clock",
    props.placement,
    props.fontScale,
    props.showHeader,
  );
  const box = contentBox(props.placement, props.showHeader);
  const dateSize = sizes.date ?? 30;
  const dateHeight = text.date ? dateSize * LINE_HEIGHT : 0;
  const min = sizes.clockMin ?? 56;
  const max = Math.max(
    min,
    Math.min(
      sizes.clockMax ?? min,
      (box.height - dateHeight) / VALUE_LINE_HEIGHT,
    ),
  );
  // Widest digits, so the size does not change from minute to minute.
  const sample = text.time.replace(/\d/g, "0");
  const size =
    fitTextSize(sample, box.width, { min, max, weight: "semibold" }) ?? min;
  return (
    <div className="sw sw-clock">
      <time
        className="sw-clock-time"
        style={{ fontSize: u(size) }}
        suppressHydrationWarning
      >
        {text.time}
      </time>
      {text.date ? (
        <span
          className="sw-clock-date"
          style={{ fontSize: u(dateSize) }}
          suppressHydrationWarning
        >
          {text.date}
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
