"use client";

import { STUDIO_TEXT_MINIMUMS } from "@netrics/domain";

import { useT } from "@/lib/i18n/client";
import { u } from "@/lib/studio-render";
import type { ImageWidget, StudioImage } from "@/lib/studio-widgets";

import { WidgetNotice } from "./widget-parts";

const POSITION = { start: "0%", center: "50%", end: "100%" } as const;

/**
 * The image widget (ADR 0015, sections 2 and 8): an uploaded image or app
 * icon, keeping its aspect ratio (`contain` shows all of it, `cover` fills
 * the widget). The browser decodes it at the widget's size; its intrinsic
 * size is given so the layout never jumps. An image that is gone shows a
 * notice instead of a broken picture.
 */
export function ImageWidgetView({
  widget,
  image,
}: {
  widget: Pick<ImageWidget, "title" | "options">;
  image: StudioImage | null;
}) {
  const t = useT("screen.widget");
  if (!image) {
    return (
      <div className="sw sw-image sw-image--missing">
        <WidgetNotice size={STUDIO_TEXT_MINIMUMS.any}>
          {t("imageMissing")}
        </WidgetNotice>
      </div>
    );
  }
  const position = POSITION[widget.options.align] ?? POSITION.center;
  return (
    <div className="sw sw-image">
      <img
        src={image.url}
        alt={widget.title ?? ""}
        width={image.width}
        height={image.height}
        decoding="async"
        style={{
          objectFit: widget.options.fit === "cover" ? "cover" : "contain",
          objectPosition: `${position} 50%`,
          borderRadius: widget.options.fit === "cover" ? u(12) : undefined,
        }}
      />
    </div>
  );
}
