export const dynamic = "force-dynamic";

// Liveness probe for the deployment platform. Intentionally has no
// dependencies: the API readiness signal lives on /status (UI) and
// /health/ready (API); this route only proves the web process serves HTTP.
export function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
