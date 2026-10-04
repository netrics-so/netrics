"use client";

import { countdownLabel } from "@netrics/domain";

import { useLocale } from "@/lib/i18n/client";
import { countdownTargetAt, countdownView } from "@/lib/studio-countdown";
import {
  contentBox,
  labelLayout,
  typeScaleFor,
  u,
  type ScreenPlacement,
} from "@/lib/studio-render";

import { useNow } from "./clock-widget";
import { WidgetLabel } from "./widget-parts";

export interface CountdownWidgetViewProps {
  now: Date;
  /** The title, else the localised "Countdown". */
  label: string;
  /** The target as an instant; null when it does not resolve. */
  targetAt: Date | null;
  /** The target's zone, for the target line. */
  timeZone: string;
  options: { showTarget: boolean; doneText: string | null };
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
}

/**
 * The countdown widget (ADR 0019 section 8): the label, the time left as
 * numbers with unit letters ("2 d 14 h 05 m"), as large as fits, and the
 * target line ("Tue 7 Oct · 10:00"). At and after the target it shows the
 * text when reached at heading size in the accent colour. It counts down
 * from the viewer's clock each minute; it has no data states and no enter
 * motion beyond the slide's fade.
 */
export function CountdownWidgetView(props: CountdownWidgetViewProps) {
  const locale = useLocale();
  const view = countdownView({ ...props, locale });
  const { layout } = view;
  const box = contentBox(props.placement, props.showHeader);
  const sizes = typeScaleFor(
    "countdown",
    props.placement,
    props.fontScale,
    props.showHeader,
  );
  const label = labelLayout(props.label, box.width, sizes);
  return (
    <div
      className={`sw sw-countdown${view.done ? " sw-countdown--done" : ""}`}
      suppressHydrationWarning
    >
      <WidgetLabel layout={label} />
      {view.done ? (
        <p
          className="sw-countdown-done"
          style={{ fontSize: u(layout.sizes.done) }}
          suppressHydrationWarning
        >
          {view.doneText}
        </p>
      ) : (
        <p
          className="sw-countdown-time"
          style={{ fontSize: u(layout.sizes.value) }}
          aria-label={view.text}
          suppressHydrationWarning
        >
          {view.groups.map((group, index) => (
            <span
              key={`${index}:${group.unit}`}
              className="sw-countdown-group"
              aria-hidden="true"
              style={index > 0 ? { marginLeft: u(layout.groupGap) } : undefined}
            >
              <span className="sw-countdown-number">{group.value}</span>
              <span
                className="sw-countdown-unit"
                style={{
                  fontSize: u(layout.sizes.unit),
                  marginLeft: u(layout.unitGap),
                }}
              >
                {group.unit}
              </span>
            </span>
          ))}
        </p>
      )}
      {layout.showTarget && view.target ? (
        <p
          className="sw-muted sw-countdown-target"
          style={{ fontSize: u(layout.sizes.target) }}
          suppressHydrationWarning
        >
          {view.target}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A countdown on a slide: ticking each minute from the viewer's clock. The
 * payload brings `targetAt`; the Studio resolves it from the options in
 * the widget's zone, else the workspace's.
 */
export function LiveCountdownWidget(props: {
  title: string | null;
  /** A payload's resolved label; else the title or "Countdown". */
  label?: string;
  options: {
    target: string;
    timeZone: string | null;
    showTarget: boolean;
    doneText: string | null;
    targetAt?: string;
  };
  workspaceTimeZone: string;
  placement: ScreenPlacement;
  showHeader: boolean;
  fontScale: number;
}) {
  const now = useNow();
  const locale = useLocale();
  const timeZone = props.options.timeZone ?? props.workspaceTimeZone;
  return (
    <CountdownWidgetView
      now={now}
      label={props.label ?? countdownLabel(props.title, locale)}
      targetAt={countdownTargetAt({
        targetAt: props.options.targetAt ?? null,
        target: props.options.target,
        timeZone,
      })}
      timeZone={timeZone}
      options={props.options}
      placement={props.placement}
      showHeader={props.showHeader}
      fontScale={props.fontScale}
    />
  );
}
