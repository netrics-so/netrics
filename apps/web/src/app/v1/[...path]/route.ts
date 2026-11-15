import { proxyToApi } from "@/lib/api-proxy";

// Proxied to the API at request time (NETRICS_API_URL); see lib/api-proxy.
export const dynamic = "force-dynamic";
// A store install may wait up to 60 s for the global install lock (#660); ignored outside Vercel (hosted web runs on Railway, #161).
export const maxDuration = 90;

export const GET = proxyToApi;
export const POST = proxyToApi;
export const PUT = proxyToApi;
export const PATCH = proxyToApi;
export const DELETE = proxyToApi;
