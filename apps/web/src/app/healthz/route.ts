// Relative, so the route test runs without the @/ alias.
import { buildInfo } from "../../lib/build-info";

export const dynamic = "force-dynamic";

// Liveness probe for the deployment platform and the release smoke check.
// Intentionally has no dependencies: the API readiness signal lives on
// /status (UI) and /health/ready (API); this route only proves the web
// process serves HTTP and says which build it is, like the API's
// /health/live. Probes check only the status code.
export function GET(): Response {
  return Response.json(
    { status: "ok", ...buildInfo() },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
