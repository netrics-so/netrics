"use client";
import { MeasureWidgetView } from "@/components/studio/measure-widget";

import type { DeviceWidget } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { useNow } from "@/components/studio/clock-widget";
import {
  deviceBarReading,
  deviceGaugeReading,
  deviceLineReading,
  deviceMetricReading,
  deviceStatusReading,
  deviceTableReading,
  deviceCompareReading,
  type DeviceWidgetEnv,
} from "@/components/studio/device-widget";
import { deviceReviewReading } from "@/components/studio/review-widget";
import { WidgetFailed } from "@/components/studio/slide-canvas";
import { useLocale } from "@/lib/i18n/client";
import { useExpired } from "@/lib/use-expired";

import {
  ScrollBarCard,
  ScrollClockCard,
  ScrollCountdownCard,
  ScrollGaugeCard,
  ScrollImageCard,
  ScrollLineCard,
  ScrollMetricCard,
  ScrollReviewCard,
  ScrollStatusCard,
  ScrollTableCard,
  ScrollCompareCard,
  ScrollTextCard,
  type ScrollCardSize,
} from "./scroll-widgets";

/** A payload compare card, hidden at its retention deadline (#539). */
function DeviceScrollCompare({
  widget,
  locale,
  size,
}: {
  widget: Extract<DeviceWidget, { type: "compare" }>;
  locale: Locale;
  size: ScrollCardSize;
}) {
  const expired = useExpired(widget.data.expiresAt);
  return (
    <ScrollCompareCard
      {...deviceCompareReading(widget, locale, expired)}
      {...size}
    />
  );
}

function DeviceScrollClock({
  widget,
  env,
  size,
}: {
  widget: Extract<DeviceWidget, { type: "clock" }>;
  env: DeviceWidgetEnv;
  size: ScrollCardSize;
}) {
  const now = useNow();
  return (
    <ScrollClockCard
      now={now}
      timeZone={widget.options.timeZone ?? env.timeZone}
      options={widget.options}
      {...size}
    />
  );
}

function DeviceScrollCountdown({
  widget,
  size,
}: {
  widget: Extract<DeviceWidget, { type: "countdown" }>;
  size: ScrollCardSize;
}) {
  const now = useNow();
  return (
    <ScrollCountdownCard
      now={now}
      label={widget.label}
      options={widget.options}
      {...size}
    />
  );
}

/**
 * A payload widget's scroll view card (a kiosk set to scroll view, ADR 0017
 * section 7): the payload's numbers in the cards of the signed-in scroll
 * view, no further requests.
 */
export function DeviceScrollWidget({
  widget,
  env,
  size,
}: {
  widget: DeviceWidget;
  env: DeviceWidgetEnv;
  size: ScrollCardSize;
}) {
  const locale = useLocale();
  switch (widget.type) {
    case "measure":
      return (
        <MeasureWidgetView
          widget={{
            title: widget.label,
            binding: { measureIds: widget.measureIds, groupBy: widget.groupBy },
            options: widget.options,
          }}
          data={widget.data}
        />
      );
    case "metric":
      return (
        <ScrollMetricCard
          {...deviceMetricReading(widget, env.timeZone, locale)}
          {...size}
        />
      );
    case "line":
      return (
        <ScrollLineCard
          {...deviceLineReading(widget, env.timeZone, locale)}
          {...size}
        />
      );
    case "bar":
      return <ScrollBarCard {...deviceBarReading(widget, locale)} {...size} />;
    case "review":
      return (
        <ScrollReviewCard
          {...deviceReviewReading(widget, env.images, locale)}
          {...size}
        />
      );
    case "table":
      return (
        <ScrollTableCard {...deviceTableReading(widget, locale)} {...size} />
      );
    case "status":
      return <ScrollStatusCard {...deviceStatusReading(widget)} {...size} />;
    case "compare":
      return (
        <DeviceScrollCompare widget={widget} locale={locale} size={size} />
      );
    case "gauge":
      return (
        <ScrollGaugeCard
          {...deviceGaugeReading(widget, env.timeZone, locale)}
          {...size}
        />
      );
    case "clock":
      return <DeviceScrollClock widget={widget} env={env} size={size} />;
    case "countdown":
      return <DeviceScrollCountdown widget={widget} size={size} />;
    case "text":
      return <ScrollTextCard text={widget.text} options={widget.options} />;
    case "image":
      return (
        <ScrollImageCard
          widget={{ title: widget.label, options: widget.options }}
          image={env.images.get(widget.imageId) ?? null}
        />
      );
    default:
      // A widget type this build does not know (a newer server).
      return <WidgetFailed />;
  }
}
