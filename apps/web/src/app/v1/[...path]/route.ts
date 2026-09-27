import { proxyToApi } from "@/lib/api-proxy";

// Proxied to the API at request time (NETRICS_API_URL); see lib/api-proxy.
export const dynamic = "force-dynamic";

export const GET = proxyToApi;
export const POST = proxyToApi;
export const PUT = proxyToApi;
export const PATCH = proxyToApi;
export const DELETE = proxyToApi;
