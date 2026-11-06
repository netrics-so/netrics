import { useMemo } from "react";

import { encodeQr, qrPath } from "@/lib/qr-code";

/** The light margin a scanner needs around the code, in modules. */
const QUIET_ZONE = 4;

/**
 * A QR code of `text` as crisp inline SVG (#307): dark modules in the text
 * colour on white, with the standard four-module quiet zone. `label` is its
 * accessible name. Draws nothing for text too long to encode.
 */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const qr = useMemo(() => {
    try {
      return encodeQr(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!qr) return null;
  const side = qr.size + QUIET_ZONE * 2;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-version={qr.version}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrPath(qr, QUIET_ZONE)} fill="currentColor" />
    </svg>
  );
}
