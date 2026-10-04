import type { ReactNode } from "react";

import type { StudioPlacement, StudioTextSpan } from "@netrics/domain";

import { LINE_HEIGHT, u } from "@/lib/studio-render";
import { textWidgetLayout } from "@/lib/studio-widgets";

function Spans({ spans }: { spans: readonly StudioTextSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        let node: ReactNode = span.text;
        if (span.italic) node = <em>{node}</em>;
        if (span.bold) node = <strong>{node}</strong>;
        return <span key={index}>{node}</span>;
      })}
    </>
  );
}

/**
 * The text widget: markdown-lite (paragraphs, line breaks, # and ##
 * headings, **bold**, *italic*) parsed by studioLayout and rendered as
 * React elements. Text is only ever text: HTML in it shows literally.
 */
export function TextWidgetView({
  text,
  options,
  placement,
  showHeader,
  fontScale,
}: {
  text: string;
  options: {
    size: "body" | "heading" | "display";
    align: "start" | "center" | "end";
  };
  placement: StudioPlacement;
  showHeader: boolean;
  fontScale: number;
}) {
  const layout = textWidgetLayout({
    text,
    size: options.size,
    placement,
    fontScale,
    showHeader,
  });
  const { sizes } = layout;
  return (
    <div
      className={`sw sw-text sw-text--${options.align}`}
      data-overflow={layout.overflow ? "true" : undefined}
      style={{ lineHeight: LINE_HEIGHT }}
    >
      {layout.blocks.map((block, index) =>
        block.kind === "heading" ? (
          block.level === 1 ? (
            <h3 key={index} style={{ fontSize: u(sizes.heading1) }}>
              <Spans spans={block.spans} />
            </h3>
          ) : (
            <h4 key={index} style={{ fontSize: u(sizes.heading2) }}>
              <Spans spans={block.spans} />
            </h4>
          )
        ) : (
          <p key={index} style={{ fontSize: u(sizes.paragraph) }}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                <Spans spans={line} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
