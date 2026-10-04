"use client";

import type { DeviceWidget } from "@netrics/contracts";

import { useNow } from "@/components/studio/clock-widget";
import {
  deviceBarReading,
  deviceLineReading,
  deviceMetricReading,
  deviceStatusReading,
  deviceTableReading,
  type DeviceWidgetEnv,
} from "@/components/studio/device-widget";
import { WidgetFailed } from "@/components/studio/slide-canvas";
import { useLocale } from "@/lib/i18n/client";

import {
  ScrollBarCard,
  ScrollClockCard,
  ScrollImageCard,
  ScrollLineCard,
  ScrollMetricCard,
  ScrollStatusCard,
  ScrollTableCard,
  ScrollTextCard,
  type ScrollCardSize,
} from "./scroll-widgets";

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
    case "table":
      return (
        <ScrollTableCard {...deviceTableReading(widget, locale)} {...size} />
      );
    case "status":
      return <ScrollStatusCard {...deviceStatusReading(widget)} {...size} />;
    case "clock":
      return <DeviceScrollClock widget={widget} env={env} size={size} />;
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
