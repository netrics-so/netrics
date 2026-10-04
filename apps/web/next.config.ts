import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Next.js inlines its bootstrap scripts and styles, hence 'unsafe-inline';
// everything else is same-origin only, and no page may be framed. Dev mode
// additionally needs eval for fast refresh.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  // blob: shows images the kiosk fetched with its device token (#217).
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const IMAGE_CONTENT_POLICY = "default-src 'none'; sandbox";

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // OAuth callbacks carry single-use codes in the URL (ADR 0012): no
      // Referer may repeat them and no cache may keep them. Later entries
      // override earlier ones for the same header.
      {
        source: "/oauth/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // Image bytes proxied from the API keep the API's sandboxing policy
      // (ADR 0015, section 5), not the policy for pages.
      ...[
        "/v1/workspaces/:workspaceId/images/:imageId/content",
        "/v1/device/images/:imageId",
      ].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: IMAGE_CONTENT_POLICY },
        ],
      })),
    ];
  },
  outputFileTracingRoot: path.join(appDir, "../.."),
};

export default nextConfig;
