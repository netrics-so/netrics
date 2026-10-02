import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeviceCredentials,
  DeviceDashboardResponse,
} from "@netrics/contracts";

import {
  CREDENTIALS_KEY,
  DASHBOARD_KEY,
  backoffMs,
  createKioskClient,
  kioskAppVersion,
  type KioskClient,
  type KioskStorage,
} from "./kiosk-client";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const PAIRING_ID = "0b8f6a52-7c1e-4a8e-9a55-3d6f0e3b2a11";
const POLL_SECRET = "s".repeat(43);

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: KioskStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  return { storage, data };
}

function credentialsFor(
  name: string,
  accessExpiresInMs = 60 * 60 * 1000,
): DeviceCredentials {
  return {
    accessToken: `access-${name}`,
    accessTokenExpiresAt: new Date(
      Date.now() + accessExpiresInMs,
    ).toISOString(),
    refreshToken: `refresh-${name}`,
    refreshTokenExpiresAt: new Date(
      Date.now() + 90 * 24 * 3600 * 1000,
    ).toISOString(),
  };
}

function dashboard(version: string, value = 42): DeviceDashboardResponse {
  return {
    version,
    refreshAfterSec: 60,
    timeZone: "Europe/Berlin",
    dashboard: { id: "4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "Sales" },
    tiles: [
      {
        id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
        label: "Revenue",
        period: "today",
        aggregation: "sum",
        value,
        unit: "count",
        change: { previousValue: 40, delta: value - 40, ratio: 0.05 },
        spark: [1, 2, null, 4],
        status: "ok",
        updatedAt: "2026-09-29T09:55:00.000Z",
      },
    ],
  };
}

/**
 * A minimal Response: real ones read their body through Node streams, whose
 * scheduling the fake timers would hold up.
 */
function reply(status: number, body: unknown, headers = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response;
}

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return reply(init.status ?? 200, body, init.headers);
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  at: number;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A scripted API: one handler per "METHOD /path", recording each call. */
function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://kiosk.test");
      const call: Call = {
        method: init.method ?? "GET",
        path: url.pathname,
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        at: Date.now(),
      };
      calls.push(call);
      const handler = routes[`${call.method} ${call.path}`];
      if (!handler) {
        throw new TypeError(
          `fetch failed: no route ${call.method} ${call.path}`,
        );
      }
      return handler(call);
    },
  );
  const callsTo = (key: string) =>
    calls.filter((call) => `${call.method} ${call.path}` === key);
  return { fetch: fetchMock as unknown as typeof fetch, calls, callsTo };
}

function pairingResponse(code = "ABCD-EFGH") {
  return json({
    pairingId: PAIRING_ID,
    code,
    pollSecret: POLL_SECRET,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    pollIntervalSeconds: 5,
    pairingUrl: "http://kiosk.test/devices/approve",
    approveUrl: `http://kiosk.test/devices/approve?code=${code}`,
  });
}

let client: KioskClient | null = null;

function start(options: {
  fetch: typeof fetch;
  storage: KioskStorage;
}): KioskClient {
  client = createKioskClient({ ...options, appVersion: "1.2.3" });
  client.start();
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  client?.stop();
  client = null;
  vi.useRealTimers();
});

describe("backoffMs", () => {
  it("doubles from 5 s up to 60 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([
      5000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});

describe("kioskAppVersion", () => {
  it("reports the web version as web <version>", () => {
    expect(kioskAppVersion("0.1.0")).toBe("web 0.1.0");
    expect(kioskAppVersion(" 0.2.0-rc.1 ")).toBe("web 0.2.0-rc.1");
  });

  it("falls back to web without a version and stays within 50 characters", () => {
    expect(kioskAppVersion("")).toBe("web");
    expect(kioskAppVersion("   ")).toBe("web");
    const long = kioskAppVersion("9".repeat(80));
    expect(long).toHaveLength(50);
    expect(long.startsWith("web 999")).toBe(true);
  });
});

describe("kiosk pairing", () => {
  it("shows a code, polls until approved and stores the credentials", async () => {
    const { storage, data } = memoryStorage();
    let approved = false;
    const issued = credentialsFor("paired");
    const api = fakeApi({
      "POST /v1/device/pairings": () => pairingResponse(),
      "POST /v1/device/pairings/poll": () =>
        approved
          ? json({
              status: "approved",
              device: { id: PAIRING_ID, name: "Lobby" },
              credentials: issued,
            })
          : json({ status: "pending", expiresAt: new Date().toISOString() }),
      "GET /v1/device/dashboard": () =>
        json(dashboard("v1"), { headers: { etag: '"v1"' } }),
    });
    const kiosk = start({ fetch: api.fetch, storage });

    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().phase).toBe("pairing");
    expect(kiosk.getState().pairing?.code).toBe("ABCD-EFGH");
    expect(kiosk.getState().pairing?.pairingUrl).toBe(
      "http://kiosk.test/devices/approve",
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(api.callsTo("POST /v1/device/pairings/poll")).toHaveLength(1);
    expect(api.calls.at(-1)?.body).toEqual({
      pairingId: PAIRING_ID,
      pollSecret: POLL_SECRET,
    });
    expect(kiosk.getState().phase).toBe("pairing");

    approved = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(JSON.parse(data.get(CREDENTIALS_KEY)!)).toEqual(issued);
    expect(kiosk.getState().phase).toBe("paired");
    expect(kiosk.getState().dashboard?.version).toBe("v1");
    const [request] = api.callsTo("GET /v1/device/dashboard");
    expect(request!.headers.get("authorization")).toBe("Bearer access-paired");
  });

  it("starts a new pairing when the code expires or is gone", async () => {
    const { storage } = memoryStorage();
    let codes = 0;
    const api = fakeApi({
      "POST /v1/device/pairings": () => {
        codes += 1;
        return pairingResponse(`CODE-000${codes}`);
      },
      "POST /v1/device/pairings/poll": () =>
        json({ error: "pairing_expired" }, { status: 410 }),
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().pairing?.code).toBe("CODE-0001");

    await vi.advanceTimersByTimeAsync(5000);
    expect(kiosk.getState().pairing?.code).toBe("CODE-0002");
  });

  it("retries with backoff while the API cannot be reached", async () => {
    const { storage } = memoryStorage();
    let up = false;
    const api = fakeApi({
      "POST /v1/device/pairings": () => {
        if (!up) {
          throw new TypeError("fetch failed");
        }
        return pairingResponse();
      },
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().offline).toBe(true);
    expect(kiosk.getState().pairing).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    expect(api.callsTo("POST /v1/device/pairings")).toHaveLength(2);
    up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kiosk.getState().offline).toBe(false);
    expect(kiosk.getState().pairing?.code).toBe("ABCD-EFGH");
  });
});

describe("kiosk dashboard loop", () => {
  it("sends the ETag and keeps the payload on 304", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a")),
    });
    const api = fakeApi({
      "GET /v1/device/dashboard": (call) =>
        call.headers.get("if-none-match") === '"v1"'
          ? reply(304, null, { etag: '"v1"' })
          : json(dashboard("v1"), { headers: { etag: '"v1"' } }),
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    const first = kiosk.getState().dashboard;
    expect(first?.version).toBe("v1");
    expect(kiosk.getState().updatedAt).toBe(T0);

    await vi.advanceTimersByTimeAsync(60_000);
    const requests = api.callsTo("GET /v1/device/dashboard");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.get("if-none-match")).toBe('"v1"');
    expect(kiosk.getState().dashboard).toBe(first);
    expect(kiosk.getState().updatedAt).toBe(T0 + 60_000);
    expect(kiosk.getState().offline).toBe(false);
  });

  it("refreshes before the access token expires and persists the new pair first", async () => {
    const { storage, data } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("old", 60_000)),
    });
    const rotated = credentialsFor("new");
    let storedWhenUsed: string | null = null;
    const api = fakeApi({
      "POST /v1/device/token": () => json({ credentials: rotated }),
      "GET /v1/device/dashboard": () => {
        storedWhenUsed = data.get(CREDENTIALS_KEY) ?? null;
        return json(dashboard("v1"));
      },
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);

    const [refresh] = api.callsTo("POST /v1/device/token");
    expect(refresh!.body).toEqual({ refreshToken: "refresh-old" });
    expect(api.callsTo("POST /v1/device/token")).toHaveLength(1);
    const [request] = api.callsTo("GET /v1/device/dashboard");
    expect(request!.headers.get("authorization")).toBe("Bearer access-new");
    expect(JSON.parse(storedWhenUsed!)).toEqual(rotated);
    expect(kiosk.getState().phase).toBe("paired");
  });

  it("adopts a pair another tab already rotated instead of refreshing", async () => {
    const { storage, data } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("old", 5 * 60_000)),
    });
    const api = fakeApi({
      "POST /v1/device/token": () => json({ credentials: credentialsFor("x") }),
      "GET /v1/device/dashboard": () => json(dashboard("v1")),
    });
    start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    data.set(CREDENTIALS_KEY, JSON.stringify(credentialsFor("other-tab")));

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(api.callsTo("POST /v1/device/token")).toHaveLength(0);
    expect(
      api
        .callsTo("GET /v1/device/dashboard")
        .at(-1)!
        .headers.get("authorization"),
    ).toBe("Bearer access-other-tab");
  });

  it("refreshes once on a 401 and retries", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("old")),
    });
    const api = fakeApi({
      "POST /v1/device/token": () =>
        json({ credentials: credentialsFor("new") }),
      "GET /v1/device/dashboard": (call) =>
        call.headers.get("authorization") === "Bearer access-new"
          ? json(dashboard("v1"))
          : json({ error: "unauthorized" }, { status: 401 }),
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.callsTo("POST /v1/device/token")).toHaveLength(1);
    expect(api.callsTo("GET /v1/device/dashboard")).toHaveLength(2);
    expect(kiosk.getState().dashboard?.version).toBe("v1");
  });

  it("clears the credentials and pairs again when the refresh is refused", async () => {
    const { storage, data } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("revoked", 30_000)),
      [DASHBOARD_KEY]: JSON.stringify({
        etag: '"v1"',
        payload: dashboard("v1"),
        updatedAt: T0 - 60_000,
      }),
    });
    const api = fakeApi({
      "POST /v1/device/token": () =>
        json({ error: "unauthorized" }, { status: 401 }),
      "POST /v1/device/pairings": () => pairingResponse(),
    });
    const kiosk = start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(data.has(CREDENTIALS_KEY)).toBe(false);
    expect(data.has(DASHBOARD_KEY)).toBe(false);
    expect(api.callsTo("GET /v1/device/dashboard")).toHaveLength(0);
    expect(kiosk.getState().phase).toBe("pairing");
    expect(kiosk.getState().dashboard).toBeNull();
    expect(kiosk.getState().pairing?.code).toBe("ABCD-EFGH");
  });

  it("keeps the last dashboard through an outage, backs off, and recovers", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a", 24 * 3600 * 1000)),
    });
    let mode: "up" | "down" | "error" = "up";
    const api = fakeApi({
      "GET /v1/device/dashboard": () => {
        if (mode === "down") {
          throw new TypeError("fetch failed");
        }
        if (mode === "error") {
          return json({ error: "api_unreachable" }, { status: 502 });
        }
        return json(dashboard("v2", 50), { headers: { etag: '"v2"' } });
      },
    });
    let seen = 0;
    const kiosk = createKioskClient({
      fetch: api.fetch,
      storage,
      appVersion: "1.2.3",
      onChange: () => {
        seen += 1;
      },
    });
    client = kiosk;
    kiosk.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = kiosk.getState().dashboard;
    expect(before?.version).toBe("v2");

    mode = "down";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kiosk.getState().offline).toBe(true);
    expect(kiosk.getState().dashboard).toBe(before);
    expect(kiosk.getState().updatedAt).toBe(T0);
    expect(kiosk.getState().lastError).toMatch(/fetch failed/);

    mode = "error";
    const failuresAt = () =>
      api.callsTo("GET /v1/device/dashboard").map((call) => call.at - T0);
    await vi.advanceTimersByTimeAsync(5000 + 10_000 + 20_000);
    // 60 s (down), then 5 s, 10 s and 20 s later (502s).
    expect(failuresAt()).toEqual([0, 60_000, 65_000, 75_000, 95_000]);
    expect(kiosk.getState().offline).toBe(true);
    expect(kiosk.getState().dashboard).toBe(before);

    mode = "up";
    await vi.advanceTimersByTimeAsync(40_000);
    expect(kiosk.getState().offline).toBe(false);
    expect(kiosk.getState().lastError).toBeNull();
    expect(kiosk.getState().updatedAt).toBe(T0 + 135_000);
    expect(seen).toBeGreaterThan(0);
  });

  it("shows the cached dashboard after a reload while the API is down", async () => {
    const cachedAt = T0 - 5 * 60_000;
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a")),
      [DASHBOARD_KEY]: JSON.stringify({
        etag: '"v1"',
        payload: dashboard("v1"),
        updatedAt: cachedAt,
      }),
    });
    const api = fakeApi({});
    const kiosk = start({ fetch: api.fetch, storage });
    expect(kiosk.getState().dashboard?.version).toBe("v1");

    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().phase).toBe("paired");
    expect(kiosk.getState().offline).toBe(true);
    expect(kiosk.getState().dashboard?.version).toBe("v1");
    expect(kiosk.getState().updatedAt).toBe(cachedAt);
    const [request] = api.callsTo("GET /v1/device/dashboard");
    expect(request!.headers.get("if-none-match")).toBe('"v1"');
  });

  it("sends heartbeats with version, uptime and the last error", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a", 24 * 3600 * 1000)),
    });
    const api = fakeApi({
      "GET /v1/device/dashboard": () =>
        json({ error: "internal" }, { status: 500 }),
      "POST /v1/device/heartbeat": () => reply(204, null),
    });
    start({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(10_000);
    const [first] = api.callsTo("POST /v1/device/heartbeat");
    expect(first!.headers.get("authorization")).toBe("Bearer access-a");
    expect(first!.body).toEqual({
      appVersion: "web 1.2.3",
      uptimeSeconds: 10,
      lastError: "HttpError: HTTP 500",
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(api.callsTo("POST /v1/device/heartbeat")).toHaveLength(2);
  });
});
