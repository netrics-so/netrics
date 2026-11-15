/**
 * Where the journeys reach the web app and the API. Defaults to the
 * `pnpm dev` ports; NETRICS_E2E_WEB_PORT and NETRICS_E2E_API_PORT move them,
 * so journeys can run beside another local instance. The servers the
 * journeys start are pointed at these ports, but BETTER_AUTH_URL,
 * WEB_ORIGIN and NETRICS_API_URL set in the environment win over them:
 * unset them (or set them to match) when moving the ports.
 */
export const WEB_PORT = Number(process.env.NETRICS_E2E_WEB_PORT ?? 3000);
export const API_PORT = Number(process.env.NETRICS_E2E_API_PORT ?? 3001);
export const ORIGIN = `http://localhost:${WEB_PORT}`;
export const API = `http://localhost:${API_PORT}`;
