"use client";

import { useRef } from "react";

import type { DeviceTileStatus, DeviceWidget } from "@netrics/contracts";
import {
  RESOURCE_DIMENSION,
  reviewWidgetLabel,
  type Locale,
  type StudioPlacement,
} from "@netrics/domain";

import { useLocale, useT } from "@/lib/i18n/client";
import { u } from "@/lib/studio-render";
import {
  reviewAuthorLine,
  reviewStars,
  reviewWidgetLayout,
  type ReviewReading,
} from "@/lib/studio-review";
import type {
  ReviewWidget,
  StudioEnv,
  StudioImages,
} from "@/lib/studio-widgets";
import { deviceTileNotice } from "@/lib/tile-status";

import { useNow } from "./clock-widget";
import { useRowRise } from "./enter-motion";
import { liveDataState } from "./metric-widget";
import { useLatestReviewData } from "./use-widget-data";
import {
  DataStateWidget,
  WidgetLabel,
  WidgetNotice,
  dataSurfaceOf,
  statusClass,
} from "./widget-parts";

export interface ReviewWidgetViewProps {
  label: string;
  reading: ReviewReading | null;
  /** The app's icon (a workspace image's URL); null: none. */
  icon: string | null;
  notice: string | null;
  /** How far the review can be trusted; default ok. */
  status?: DeviceTileStatus;
  source?: string | null;
  updatedAt?: string | null;
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
  loading?: boolean;
}

/** Five stars, filled up to the rating, in `warning` and `border`. */
export function ReviewStars({
  rating,
  size,
}: {
  rating: number;
  size: number;
}) {
  const t = useT("screen.widget");
  return (
    <span
      className="sw-review-stars"
      role="img"
      aria-label={t("reviewStars", { rating })}
      style={{ fontSize: u(size) }}
    >
      {reviewStars(rating).map((filled, index) => (
        <span
          key={index}
          className={filled ? "sw-review-star filled" : "sw-review-star"}
          aria-hidden="true"
        >
          {"★"}
        </span>
      ))}
    </span>
  );
}

/**
 * The latest-review widget (ADR 0019 section 12, design 4b): the label, a
 * row with the app icon and five stars, the review's title on one line and
 * its body in the lines that fit (data text: both end with an ellipsis),
 * and the author line "Marta P. · Germany · 2 hr. ago" (the age from this
 * device's clock). One review, no rotation; the parts rise on slide enter.
 */
export function ReviewWidgetView(props: ReviewWidgetViewProps) {
  const locale = useLocale();
  const t = useT("screen.widget");
  const now = useNow();
  const ref = useRef<HTMLElement>(null);
  useRowRise(ref);
  const reading = props.reading;
  const layout = reviewWidgetLayout({
    label: props.label,
    reading,
    icon: props.icon !== null,
    notice: props.notice !== null,
    placement: props.placement,
    showHeader: props.showHeader,
    fontScale: props.fontScale,
  });
  const { review } = layout;
  const small = review.sizes.author;
  const surface = dataSurfaceOf(props.status);
  if (surface) {
    return (
      <DataStateWidget
        type="review"
        surface={surface}
        label={layout.label}
        small={small}
        source={props.source}
        updatedAt={props.updatedAt}
        placement={props.placement}
        showHeader={props.showHeader}
        fontScale={props.fontScale}
        reconnectText={t("reviewsPaused")}
        reconnectHint={t("reviewsPausedHint")}
        emptyText={t("noReviews")}
      />
    );
  }
  const textStyle = {
    fontSize: u(review.sizes.review),
    lineHeight: u(review.textLine),
  };
  return (
    <article
      ref={ref}
      className={`sw sw-review${statusClass(props.status)}`}
      aria-busy={props.loading ?? false}
    >
      <WidgetLabel layout={layout.label} />
      {reading ? (
        <>
          <div
            className="sw-review-stars-row"
            data-rise={0}
            style={{ height: u(review.starsRowHeight) }}
          >
            {props.icon ? (
              <img
                className="sw-review-icon"
                src={props.icon}
                alt=""
                style={{ width: u(review.icon), height: u(review.icon) }}
              />
            ) : null}
            <ReviewStars rating={reading.rating} size={review.sizes.stars} />
          </div>
          {review.showTitle && reading.title ? (
            <p
              className="sw-review-title"
              data-rise={1}
              style={textStyle}
              title={review.titleTruncated ? reading.title : undefined}
            >
              {reading.title}
            </p>
          ) : null}
          {review.bodyLines > 0 && reading.body ? (
            <p
              className="sw-review-body"
              data-rise={2}
              data-truncated={review.bodyTruncated ? "true" : undefined}
              style={{
                ...textStyle,
                WebkitLineClamp: review.bodyLines,
                lineClamp: review.bodyLines,
                maxHeight: u(review.textLine * review.bodyLines),
              }}
            >
              {reading.body}
            </p>
          ) : null}
          <p
            className="sw-muted sw-review-author"
            data-rise={3}
            style={{ fontSize: u(small) }}
            suppressHydrationWarning
          >
            {reviewAuthorLine(reading, locale, now.getTime())}
          </p>
        </>
      ) : (
        <p className="sw-value sw-placeholder" style={textStyle}>
          {props.loading ? "…" : "—"}
        </p>
      )}
      {props.notice ? (
        <WidgetNotice size={small} stale={props.status === "stale"}>
          {props.notice}
        </WidgetNotice>
      ) : null}
    </article>
  );
}

/** A review widget's props apart from its placement on a slide. */
export type ReviewReadingProps = Omit<
  ReviewWidgetViewProps,
  "placement" | "showHeader" | "fontScale"
>;

/** A payload review widget's reading (no further requests). */
export function deviceReviewReading(
  widget: Extract<DeviceWidget, { type: "review" }>,
  images: StudioImages,
  locale: Locale,
): ReviewReadingProps {
  const { data } = widget;
  return {
    label: widget.label,
    reading: data.review,
    icon: widget.imageId ? (images.get(widget.imageId)?.url ?? null) : null,
    // A missing review is the no-data surface, not a notice.
    notice:
      data.status === "auth_failed" || data.status === "no_data"
        ? null
        : deviceTileNotice(data.status, data.updatedAt, locale),
    status: data.status,
    updatedAt: data.updatedAt,
  };
}

/** The label of a Studio review widget, as screens show it. */
export function reviewLabel(widget: ReviewWidget, locale: Locale): string {
  return reviewWidgetLabel(
    {
      title: widget.title,
      resourceName: widget.dimensions[RESOURCE_DIMENSION]
        ? widget.resourceName
        : null,
    },
    locale,
  );
}

/** A review widget's live review (signed-in pages), and its id. */
export function useLiveReview(
  widget: ReviewWidget,
  env: StudioEnv,
): ReviewReadingProps & { reviewId: string | null } {
  const { data, error, loading } = useLatestReviewData(env.workspaceId, widget);
  const locale = useLocale();
  const connection = env.connections[widget.connectionId];
  const live = liveDataState(
    { error, loading, loaded: data !== null, hasData: data?.review != null },
    connection,
    locale,
  );
  // The server's status knows the reviews key; a failed query or a
  // removed connection keeps the client's outage notice.
  const status = data && live.status !== "outage" ? data.status : live.status;
  const { id: reviewId = null, ...reading } = data?.review ?? {};
  return {
    label: reviewLabel(widget, locale),
    reading: data?.review ? (reading as ReviewReading) : null,
    reviewId,
    icon: widget.imageId ? (env.images.get(widget.imageId)?.url ?? null) : null,
    notice:
      status === "auth_failed" || status === "no_data" ? null : live.notice,
    status,
    source: connection?.name ?? null,
    updatedAt: connection?.state.lastSuccessAt ?? null,
    loading,
  };
}

/** A review widget that loads its own review (signed-in pages). */
export function LiveReviewWidget({
  widget,
  env,
}: {
  widget: ReviewWidget;
  env: StudioEnv;
}) {
  const { reviewId: _id, ...props } = useLiveReview(widget, env);
  return (
    <ReviewWidgetView
      {...props}
      placement={widget}
      showHeader={env.showHeader}
      fontScale={env.fontScale}
    />
  );
}
