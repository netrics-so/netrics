import type { ReactNode } from "react";

import {
  u,
  type FittedLabel,
  type WidgetLabelLayout,
} from "@/lib/studio-render";

/**
 * A title or resource line: wrapped to at most two lines at its fitted
 * size. When it needs more even at the minimum, the second line ends in an
 * ellipsis and the full text stays in the tooltip (never cut silently).
 */
function LabelLine({
  fitted,
  className,
  as: Tag,
}: {
  fitted: FittedLabel;
  className: string;
  as: "h3" | "p";
}) {
  return (
    <Tag
      className={className}
      style={{ fontSize: u(fitted.size) }}
      title={fitted.truncated ? fitted.text : undefined}
      data-truncated={fitted.truncated ? "true" : undefined}
    >
      {fitted.text}
    </Tag>
  );
}

/** A data widget's label: the metric (or title), then the resource. */
export function WidgetLabel({ layout }: { layout: WidgetLabelLayout }) {
  return (
    <div className="sw-label">
      <LabelLine fitted={layout.title} className="sw-title" as="h3" />
      {layout.resource ? (
        <LabelLine fitted={layout.resource} className="sw-resource" as="p" />
      ) : null}
    </div>
  );
}

/** A stale or failure notice in the theme's warning colour. */
export function WidgetNotice({
  size,
  children,
  title,
}: {
  size: number;
  children: ReactNode;
  title?: string;
}) {
  return (
    <p className="sw-notice" style={{ fontSize: u(size) }} title={title}>
      <span aria-hidden="true">⚠</span> {children}
    </p>
  );
}
