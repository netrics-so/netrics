/**
 * Container HEALTHCHECK for the server image. The api role serves HTTP, so
 * it is checked through /health/live; worker and scheduler have no HTTP
 * surface and report liveness through worker_heartbeats instead, so the
 * container check only confirms the process can start node.
 */
const role = process.env.NETRICS_ROLE ?? "api";
if (role !== "api") {
  process.exit(0);
}
const port = process.env.PORT ?? "3001";
try {
  const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(3000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
