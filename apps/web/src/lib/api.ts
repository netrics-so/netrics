import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from "@netrics/contracts";

const apiBaseUrl = process.env.NETRICS_API_URL ?? "http://localhost:3001";

export interface ApiHealth {
  live: HealthLiveResponse | null;
  ready: HealthReadyResponse | null;
  error: string | null;
}

export async function fetchApiHealth(): Promise<ApiHealth> {
  try {
    const [liveResponse, readyResponse] = await Promise.all([
      fetch(`${apiBaseUrl}/health/live`, { cache: "no-store" }),
      fetch(`${apiBaseUrl}/health/ready`, { cache: "no-store" }),
    ]);

    const live = liveResponse.ok
      ? healthLiveResponseSchema.parse(await liveResponse.json())
      : null;
    const readyJson: unknown = await readyResponse.json().catch(() => null);
    const ready = readyJson ? healthReadyResponseSchema.parse(readyJson) : null;

    return { live, ready, error: null };
  } catch (error) {
    return {
      live: null,
      ready: null,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}
