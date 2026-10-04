"use client";

import type { DeviceWidget } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { useLocale } from "@/lib/i18n/client";
import type { ScreenPlacement } from "@/lib/studio-render";
import type { StudioImages } from "@/lib/studio-widgets";
import { deviceTileNotice } from "@/lib/tile-status";

import { BarWidgetView, type BarReadingProps } from "./bar-widget";
import { LiveClockWidget } from "./clock-widget";
import { ImageWidgetView } from "./image-widget";
import { LineWidgetView, type LineReadingProps } from "./line-widget";
import { MetricWidgetView, type MetricReadingProps } from "./metric-widget";
import { WidgetFailed } from "./slide-canvas";
import { TextWidgetView } from "./text-widget";

/** What a payload widget needs besides itself. */
export interface DeviceWidgetEnv {
  /** The payload's time zone: chart labels and clocks without their own. */
  timeZone: string;
  fontScale: number;
  showHeader: boolean;
  images: StudioImages;
}

export type DeviceDataWidget = Extract<
  DeviceWidget,
  { type: "metric" | "line" | "bar" }
>;

function metricOf(data: DeviceDataWidget["data"]) {
  return data.kind && data.granularity
    ? { kind: data.kind, granularity: data.granularity, better: data.better }
    : null;
}

/**
 * A payload metric's reading (the numbers the server computed), shared by
 * the slide widget and the kiosk's scroll view card.
 */
export function deviceMetricReading(
  widget: Extract<DeviceWidget, { type: "metric" }>,
  timeZone: string,
  locale: Locale,
): MetricReadingProps {
  const { data } = widget;
  return {
    label: widget.label,
    period: data.period,
    aggregation: data.aggregation,
    metric: metricOf(data),
    reading:
      data.unit === null
        ? null
        : {
            value: data.value,
            unit: data.unit,
            delta: data.change.delta,
            ratio: data.change.ratio,
            series: data.spark.map((value) => ({ value })),
            timeZone,
            approximate: data.conversion !== null,
          },
    notice: deviceTileNotice(data.status, data.updatedAt, locale),
    status: data.status,
    updatedAt: data.updatedAt,
    source: null,
    options: widget.options,
  };
}

/** A payload line widget's reading. */
export function deviceLineReading(
  widget: Extract<DeviceWidget, { type: "line" }>,
  timeZone: string,
  locale: Locale,
): LineReadingProps {
  const { data } = widget;
  const previous =
    data.previous.length > 0
      ? data.buckets.map((bucket, index) => ({
          bucket,
          value: data.previous[index] ?? null,
        }))
      : null;
  return {
    label: widget.label,
    period: data.period,
    reading:
      data.unit === null
        ? null
        : {
            value: data.value,
            unit: data.unit,
            series: data.buckets.map((bucket, index) => ({
              bucket,
              value: data.values[index] ?? null,
            })),
            previous,
            timeZone,
            approximate: data.conversion !== null,
          },
    notice: deviceTileNotice(data.status, data.updatedAt, locale),
    status: data.status,
    updatedAt: data.updatedAt,
    options: widget.options,
  };
}

/** A payload bar widget's reading. */
export function deviceBarReading(
  widget: Extract<DeviceWidget, { type: "bar" }>,
  locale: Locale,
): BarReadingProps {
  const { data } = widget;
  return {
    label: widget.label,
    reading:
      data.unit === null
        ? null
        : {
            unit: data.unit,
            groups: data.bars.map((bar) => ({
              label: bar.label,
              value: bar.value,
            })),
            others: data.others
              ? { label: data.others.label, value: data.others.value }
              : null,
            approximate: data.conversion !== null,
          },
    notice: deviceTileNotice(data.status, data.updatedAt, locale),
    status: data.status,
    updatedAt: data.updatedAt,
  };
}

/**
 * A widget of a device payload (schema 2 or 3, #219, #281) with the data
 * the server computed: the same display components as the signed-in
 * pages, no further requests (images arrive as `blob:` URLs in
 * `env.images`). On a screen view canvas the widget carries its placement
 * in the screen's format.
 */
export function DeviceWidgetView({
  widget,
  env,
}: {
  widget: DeviceWidget & ScreenPlacement;
  env: DeviceWidgetEnv;
}) {
  const locale = useLocale();
  const common = {
    placement: widget,
    showHeader: env.showHeader,
    fontScale: env.fontScale,
  };
  switch (widget.type) {
    case "metric":
      return (
        <MetricWidgetView
          {...common}
          {...deviceMetricReading(widget, env.timeZone, locale)}
        />
      );
    case "line":
      return (
        <LineWidgetView
          {...common}
          {...deviceLineReading(widget, env.timeZone, locale)}
        />
      );
    case "bar":
      return (
        <BarWidgetView {...common} {...deviceBarReading(widget, locale)} />
      );
    case "image":
      return (
        <ImageWidgetView
          widget={{ title: widget.label, options: widget.options }}
          image={env.images.get(widget.imageId) ?? null}
        />
      );
    case "text":
      return (
        <TextWidgetView
          {...common}
          text={widget.text}
          options={widget.options}
        />
      );
    case "clock":
      return (
        <LiveClockWidget
          {...common}
          options={widget.options}
          timeZone={widget.options.timeZone}
          workspaceTimeZone={env.timeZone}
        />
      );
    default:
      // A widget type this build does not know (a newer server).
      return <WidgetFailed />;
  }
}
