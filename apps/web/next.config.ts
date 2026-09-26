import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));

const apiUrl = process.env.NETRICS_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(appDir, "../.."),
  // The browser only ever talks to this Next server; /api/auth/* and /v1/*
  // are proxied to the API so session cookies stay same-origin.
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
};

export default nextConfig;
