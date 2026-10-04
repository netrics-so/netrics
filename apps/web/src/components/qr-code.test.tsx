import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { encodeQr, qrPath } from "@/lib/qr-code";

import { QrCode } from "./qr-code";

describe("QrCode", () => {
  it("draws the modules on white with a four-module quiet zone", () => {
    const text = "https://netrics.tv/ABCD-EFGH";
    const qr = encodeQr(text);
    const side = qr.size + 8;
    const html = renderToStaticMarkup(
      <QrCode text={text} label="Pairing QR code" className="qr" />,
    );
    expect(html).toBe(
      `<svg class="qr" viewBox="0 0 ${side} ${side}" role="img" aria-label="Pairing QR code" shape-rendering="crispEdges" data-version="3">` +
        `<rect width="${side}" height="${side}" fill="#ffffff"></rect>` +
        `<path d="${qrPath(qr, 4)}" fill="currentColor"></path></svg>`,
    );
  });

  it("draws nothing for text a version 10 code cannot hold", () => {
    expect(
      renderToStaticMarkup(<QrCode text={"x".repeat(300)} label="QR" />),
    ).toBe("");
  });
});
