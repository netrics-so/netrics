import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeviceCredentials,
  DeviceDashboardResponse,
  DeviceDashboardV2Response,
  DeviceDashboardV3Response,
} from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import {
  CREDENTIALS_KEY,
  DASHBOARD_KEY,
  backoffMs,
  createKioskClient,
  dashboardSchemaOf,
  isFormatsDashboard,
  isSlidesDashboard,
  kioskAppVersion,
  kioskScreen,
  serverDashboardSchemas,
  type KioskBlobUrls,
  type KioskClient,
  type KioskImageCache,
  type KioskSchema,
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
        conversion: null,
        change: { previousValue: 40, delta: value - 40, ratio: 0.05 },
        spark: [1, 2, null, 4],
        kind: "delta",
        granularity: "day",
        better: "higher",
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
    blob: () =>
      Promise.resolve(
        body instanceof Blob ? body : new Blob([JSON.stringify(body)]),
      ),
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
  /** "?schema=2" or "". */
  search: string;
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
        search: url.search,
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

  it("reports the screen with each heartbeat, measured when sent (#276)", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a", 24 * 3600 * 1000)),
    });
    const api = fakeApi({
      "GET /v1/device/dashboard": () =>
        json({ error: "internal" }, { status: 500 }),
      "POST /v1/device/heartbeat": () => reply(204, null),
    });
    let viewport: [number, number] = [1920, 1080];
    client = createKioskClient({
      fetch: api.fetch,
      storage,
      appVersion: "1.2.3",
      screen: () => kioskScreen(viewport[0], viewport[1], 2),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    // The window turned to portrait between two heartbeats.
    viewport = [1080, 1920];
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const beats = api.callsTo("POST /v1/device/heartbeat");
    expect(
      beats.map((beat) => (beat.body as { screen: unknown }).screen),
    ).toEqual([
      { width: 1920, height: 1080, scale: 2, mode: "screen" },
      { width: 1080, height: 1920, scale: 2, mode: "screen" },
    ]);
  });

  it("sends no screen when it cannot be measured", async () => {
    const { storage } = memoryStorage({
      [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a", 24 * 3600 * 1000)),
    });
    const api = fakeApi({
      "GET /v1/device/dashboard": () =>
        json({ error: "internal" }, { status: 500 }),
      "POST /v1/device/heartbeat": () => reply(204, null),
    });
    client = createKioskClient({
      fetch: api.fetch,
      storage,
      appVersion: "1.2.3",
      screen: () => {
        throw new Error("no window");
      },
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const [beat] = api.callsTo("POST /v1/device/heartbeat");
    expect(beat!.body).not.toHaveProperty("screen");
  });
});

describe("kioskScreen", () => {
  it("rounds the viewport and keeps it inside the API's bounds", () => {
    expect(kioskScreen(1366.4, 767.6, 1.25)).toEqual({
      width: 1366,
      height: 768,
      scale: 1.25,
      mode: "screen",
    });
    expect(kioskScreen(40_000, 0.2, 12)).toEqual({
      width: 16_384,
      height: 1,
      scale: 8,
      mode: "screen",
    });
    expect(kioskScreen(800, 600, 0.25)).toMatchObject({ scale: 0.5 });
    expect(kioskScreen(800, 600, Number.NaN)).toMatchObject({ scale: 1 });
  });

  it("is null for a viewport without size", () => {
    expect(kioskScreen(0, 1080, 1)).toBeNull();
    expect(kioskScreen(1920, Number.NaN, 1)).toBeNull();
  });
});

// ── Slides: payload schema 2 (#221) ───────────────────────────────────────

const DASHBOARD_ID = "4c1e2d3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LOGO_ID = "11111111-1111-4111-8111-111111111111";
const BACKGROUND_ID = "22222222-2222-4222-8222-222222222222";
const SHA_LOGO = "a".repeat(64);
const SHA_BACKGROUND = "b".repeat(64);
const SHA_NEW_LOGO = "c".repeat(64);

function image(id: string, sha256: string) {
  return {
    id,
    sha256,
    contentType: "image/png" as const,
    width: 512,
    height: 512,
    bytes: 1024,
    url: `/v1/device/images/${id}?v=${sha256}`,
  };
}

function slidesPayload(
  version: string,
  images = [image(LOGO_ID, SHA_LOGO), image(BACKGROUND_ID, SHA_BACKGROUND)],
): DeviceDashboardV2Response {
  return {
    version,
    schema: 2,
    refreshAfterSec: 60,
    timeZone: "Europe/Berlin",
    dashboard: {
      id: DASHBOARD_ID,
      name: "Wurfel",
      showHeader: true,
      logo: images[0] ? { imageId: images[0].id } : null,
    },
    theme: { name: "netrics Dark", tokens: BUILTIN_THEMES.netrics_dark.tokens },
    rotation: { autoAdvance: true, transition: "fade" },
    grid: { columns: 12, rows: 8 },
    slides: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Sales",
        durationSec: 20,
        background: images[1] ? { imageId: images[1].id, dim: 40 } : null,
        widgets: [],
      },
    ],
    images,
  };
}

/** Schema 2's content with formats, layouts and the device's settings. */
function formatsPayload(
  version: string,
  images?: Parameters<typeof slidesPayload>[1],
): DeviceDashboardV3Response {
  const {
    schema: _s,
    grid: _g,
    slides,
    ...rest
  } = slidesPayload(version, images);
  const format = (columns: number, rows: number, w: number, h: number) => ({
    columns,
    rows,
    reference: [w, h] as [number, number],
  });
  return {
    ...rest,
    schema: 3,
    locale: "en",
    primaryFormat: "16x9",
    formats: {
      "16x9": format(12, 8, 1920, 1080),
      "21x9": format(16, 8, 2520, 1080),
      "4x3": format(9, 8, 1440, 1080),
      "3x4": format(6, 10, 1080, 1440),
      "9x16": format(6, 14, 1080, 1920),
    },
    device: { rotation: 90, displayMode: "screen" },
    slides: slides.map((slide) => ({ ...slide, layouts: [] })),
  };
}

function serverInfo(dashboardSchemas?: number[]) {
  return json({
    product: "netrics",
    deviceApiVersion: 1,
    version: "1.0.0",
    pairingUrl: "http://kiosk.test/devices/approve",
    ...(dashboardSchemas ? { dashboardSchemas } : {}),
  });
}

function memoryImageCache(initial: Record<string, Blob> = {}) {
  const entries = new Map(Object.entries(initial));
  const cache: KioskImageCache = {
    get: (sha) => Promise.resolve(entries.get(sha) ?? null),
    put: (sha, blob) => {
      entries.set(sha, blob);
      return Promise.resolve();
    },
    prune: (keep) => {
      for (const sha of [...entries.keys()]) {
        if (!keep.has(sha)) entries.delete(sha);
      }
      return Promise.resolve();
    },
  };
  return { cache, entries };
}

function fakeBlobUrls() {
  let next = 0;
  const live = new Set<string>();
  const revoked: string[] = [];
  const urls: KioskBlobUrls = {
    create: () => {
      next += 1;
      const url = `blob:kiosk/${next}`;
      live.add(url);
      return url;
    },
    revoke: (url) => {
      live.delete(url);
      revoked.push(url);
    },
  };
  return { urls, live, revoked };
}

function startWith(options: {
  fetch: typeof fetch;
  storage: KioskStorage;
  imageCache?: KioskImageCache;
  blobUrls?: KioskBlobUrls;
  schemas?: readonly KioskSchema[];
}): KioskClient {
  client = createKioskClient({
    ...options,
    blobUrls: options.blobUrls ?? fakeBlobUrls().urls,
    appVersion: "1.2.3",
  });
  client.start();
  return client;
}

function pairedStorage(extra: Record<string, string> = {}) {
  return memoryStorage({
    [CREDENTIALS_KEY]: JSON.stringify(credentialsFor("a", 24 * 3600 * 1000)),
    ...extra,
  });
}

function imageRoute(bytes: Record<string, string>) {
  return (call: Call) => {
    const id = call.path.split("/").at(-1)!;
    const body = bytes[id];
    return body === undefined
      ? json({ error: "not_found" }, { status: 404 })
      : reply(200, new Blob([body], { type: "image/png" }));
  };
}

describe("serverDashboardSchemas", () => {
  it("reads the listed schemas and treats a missing list as none", () => {
    expect(serverDashboardSchemas({ dashboardSchemas: [1, 2] })).toEqual([
      1, 2,
    ]);
    expect(serverDashboardSchemas({ product: "netrics" })).toEqual([]);
    expect(serverDashboardSchemas(null)).toEqual([]);
  });
});

describe("kiosk payload schema", () => {
  it("asks for schema 2 when the server lists it", async () => {
    const { storage } = pairedStorage();
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () =>
        json(slidesPayload("s2"), { headers: { etag: '"s2"' } }),
      "GET /v1/device/images/11111111-1111-4111-8111-111111111111": () =>
        reply(200, new Blob(["logo"], { type: "image/png" })),
      "GET /v1/device/images/22222222-2222-4222-8222-222222222222": () =>
        reply(200, new Blob(["bg"], { type: "image/png" })),
    });
    const kiosk = startWith({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);

    const [request] = api.callsTo("GET /v1/device/dashboard");
    const url = (api.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => String(input))
      .find((input) => input.startsWith("/v1/device/dashboard"));
    expect(url).toBe("/v1/device/dashboard?schema=2");
    expect(request!.headers.get("authorization")).toBe("Bearer access-a");
    const state = kiosk.getState().dashboard!;
    expect(isSlidesDashboard(state)).toBe(true);

    // The answer is kept: the next poll does not ask the server again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo("GET /v1/server")).toHaveLength(1);
    expect(api.callsTo("GET /v1/device/dashboard")).toHaveLength(2);
  });

  it("keeps schema 1 against a server without dashboardSchemas", async () => {
    const { storage } = pairedStorage();
    const urls: string[] = [];
    const api = fakeApi({
      "GET /v1/server": () => serverInfo(),
      "GET /v1/device/dashboard": () => json(dashboard("v1")),
    });
    const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return api.fetch(input, init);
    }) as typeof fetch;
    const kiosk = startWith({ fetch: fetchSpy, storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(urls).toContain("/v1/device/dashboard");
    expect(urls.some((url) => url.includes("schema="))).toBe(false);
    const state = kiosk.getState().dashboard!;
    expect(isSlidesDashboard(state)).toBe(false);
    expect(kiosk.getState().images.size).toBe(0);
  });

  it("keeps the cached slides schema while the server info cannot be read", async () => {
    const { storage } = pairedStorage({
      [DASHBOARD_KEY]: JSON.stringify({
        etag: '"s2"',
        payload: slidesPayload("s2", []),
        updatedAt: T0 - 60_000,
      }),
    });
    let infoUp = false;
    const urls: string[] = [];
    const api = fakeApi({
      "GET /v1/server": () => {
        if (!infoUp) throw new TypeError("fetch failed");
        return serverInfo([1, 2]);
      },
      "GET /v1/device/dashboard": (call) =>
        call.headers.get("if-none-match") === '"s2"'
          ? reply(304, null, { etag: '"s2"' })
          : json(slidesPayload("s2", [])),
    });
    const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return api.fetch(input, init);
    }) as typeof fetch;
    const kiosk = startWith({ fetch: fetchSpy, storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      urls.filter((url) => url.startsWith("/v1/device/dashboard")),
    ).toEqual(["/v1/device/dashboard?schema=2"]);
    // Same schema: the ETag is offered and the screen keeps its slides.
    expect(
      api.callsTo("GET /v1/device/dashboard")[0]!.headers.get("if-none-match"),
    ).toBe('"s2"');
    expect(isSlidesDashboard(kiosk.getState().dashboard!)).toBe(true);

    // The server info is asked again until it answers.
    infoUp = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo("GET /v1/server")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo("GET /v1/server")).toHaveLength(2);
  });

  it("does not offer a schema 1 ETag when asking for schema 2", async () => {
    const { storage } = pairedStorage({
      [DASHBOARD_KEY]: JSON.stringify({
        etag: '"v1"',
        payload: dashboard("v1"),
        updatedAt: T0 - 60_000,
      }),
    });
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () =>
        json(slidesPayload("s2", []), { headers: { etag: '"s2"' } }),
    });
    const kiosk = startWith({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);

    const [request] = api.callsTo("GET /v1/device/dashboard");
    expect(request!.headers.get("if-none-match")).toBeNull();
    expect(isSlidesDashboard(kiosk.getState().dashboard!)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      api.callsTo("GET /v1/device/dashboard")[1]!.headers.get("if-none-match"),
    ).toBe('"s2"');
  });
});

describe("kiosk payload schema 3 (#277)", () => {
  function dashboardUrls(api: ReturnType<typeof fakeApi>): string[] {
    return (api.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => String(input))
      .filter((input) => input.startsWith("/v1/device/dashboard"));
  }

  function formatsApi(listed: number[]) {
    return fakeApi({
      "GET /v1/server": () => serverInfo(listed),
      "GET /v1/device/dashboard": (call) => {
        const v3 = call.search === "?schema=3";
        const etag = v3 ? '"s3"' : '"s2"';
        if (call.headers.get("if-none-match") === etag) {
          return reply(304, null, { etag });
        }
        return json(v3 ? formatsPayload("s3") : slidesPayload("s2"), {
          headers: { etag },
        });
      },
      "GET /v1/device/images/11111111-1111-4111-8111-111111111111": () =>
        reply(200, new Blob(["logo"], { type: "image/png" })),
      "GET /v1/device/images/22222222-2222-4222-8222-222222222222": () =>
        reply(200, new Blob(["bg"], { type: "image/png" })),
    });
  }

  it("stays on schema 2 until the page renders schema 3", async () => {
    const { storage } = pairedStorage();
    const api = formatsApi([1, 2, 3]);
    const kiosk = startWith({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(dashboardUrls(api)).toEqual(["/v1/device/dashboard?schema=2"]);
    expect(isSlidesDashboard(kiosk.getState().dashboard!)).toBe(true);
  });

  it("asks for schema 3 when the page renders it and the server lists it", async () => {
    const { storage, data } = pairedStorage();
    const api = formatsApi([1, 2, 3]);
    const kiosk = startWith({
      fetch: api.fetch,
      storage,
      schemas: [1, 2, 3],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dashboardUrls(api)).toEqual(["/v1/device/dashboard?schema=3"]);
    const payload = kiosk.getState().dashboard!;
    expect(isFormatsDashboard(payload)).toBe(true);
    expect(dashboardSchemaOf(payload)).toBe(3);
    expect(isFormatsDashboard(payload) && payload.device.rotation).toBe(90);
    // Its images are loaded like schema 2's.
    expect([...kiosk.getState().images.keys()].sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    // Kept for a reload, and polled with its own ETag.
    expect(JSON.parse(data.get(DASHBOARD_KEY)!).payload.schema).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      api.callsTo("GET /v1/device/dashboard")[1]!.headers.get("if-none-match"),
    ).toBe('"s3"');
  });

  it("asks for schema 2 from a server that does not list 3", async () => {
    const { storage } = pairedStorage();
    const api = formatsApi([1, 2]);
    const kiosk = startWith({
      fetch: api.fetch,
      storage,
      schemas: [1, 2, 3],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dashboardUrls(api)).toEqual(["/v1/device/dashboard?schema=2"]);
    expect(isSlidesDashboard(kiosk.getState().dashboard!)).toBe(true);
  });

  it("does not show a cached schema 3 payload on a page without it", async () => {
    const cached = JSON.stringify({
      etag: '"s3"',
      payload: formatsPayload("s3", []),
      updatedAt: T0 - 60_000,
    });
    const { storage } = pairedStorage({ [DASHBOARD_KEY]: cached });
    const api = fakeApi({
      "GET /v1/server": () => {
        throw new TypeError("fetch failed");
      },
      "GET /v1/device/dashboard": () => {
        throw new TypeError("fetch failed");
      },
    });
    const kiosk = startWith({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().dashboard).toBeNull();
    // Nor is its ETag offered for another schema.
    expect(dashboardUrls(api)).toEqual(["/v1/device/dashboard"]);
    expect(
      api
        .callsTo("GET /v1/device/dashboard")[0]
        ?.headers.get("if-none-match") ?? null,
    ).toBeNull();

    kiosk.stop();
    const { storage: modern } = pairedStorage({ [DASHBOARD_KEY]: cached });
    const restored = startWith({
      fetch: api.fetch,
      storage: modern,
      schemas: [1, 2, 3],
    });
    expect(isFormatsDashboard(restored.getState().dashboard!)).toBe(true);
  });
});

describe("kiosk images", () => {
  it("downloads missing images with the device token, caches them by sha256 and shows blob URLs", async () => {
    const { storage } = pairedStorage();
    const { cache, entries } = memoryImageCache();
    const blobs = fakeBlobUrls();
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () =>
        json(slidesPayload("s2"), { headers: { etag: '"s2"' } }),
      [`GET /v1/device/images/${LOGO_ID}`]: imageRoute({ [LOGO_ID]: "logo" }),
      [`GET /v1/device/images/${BACKGROUND_ID}`]: imageRoute({
        [BACKGROUND_ID]: "bg",
      }),
    });
    const kiosk = startWith({
      fetch: api.fetch,
      storage,
      imageCache: cache,
      blobUrls: blobs.urls,
    });
    await vi.advanceTimersByTimeAsync(0);

    const [logoRequest] = api.callsTo(`GET /v1/device/images/${LOGO_ID}`);
    expect(logoRequest!.headers.get("authorization")).toBe("Bearer access-a");
    expect([...entries.keys()].sort()).toEqual([SHA_LOGO, SHA_BACKGROUND]);
    const images = kiosk.getState().images;
    expect(images.get(LOGO_ID)).toEqual({
      id: LOGO_ID,
      url: expect.stringMatching(/^blob:/),
      width: 512,
      height: 512,
    });
    expect(images.get(BACKGROUND_ID)?.url).toMatch(/^blob:/);
    expect(blobs.live.size).toBe(2);
  });

  it("uses cached images without downloading them", async () => {
    const { storage } = pairedStorage();
    const { cache } = memoryImageCache({
      [SHA_LOGO]: new Blob(["logo"], { type: "image/png" }),
      [SHA_BACKGROUND]: new Blob(["bg"], { type: "image/png" }),
    });
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () => json(slidesPayload("s2")),
    });
    const kiosk = startWith({ fetch: api.fetch, storage, imageCache: cache });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      api.calls.some((call) => call.path.startsWith("/v1/device/images")),
    ).toBe(false);
    expect(kiosk.getState().images.size).toBe(2);
  });

  it("downloads only the new hash, revokes the old URL and prunes its cache entry", async () => {
    const { storage } = pairedStorage();
    const { cache, entries } = memoryImageCache();
    const blobs = fakeBlobUrls();
    let payload = slidesPayload("s2");
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () => json(payload),
      [`GET /v1/device/images/${LOGO_ID}`]: imageRoute({ [LOGO_ID]: "logo" }),
      [`GET /v1/device/images/${BACKGROUND_ID}`]: imageRoute({
        [BACKGROUND_ID]: "bg",
      }),
    });
    const kiosk = startWith({
      fetch: api.fetch,
      storage,
      imageCache: cache,
      blobUrls: blobs.urls,
    });
    await vi.advanceTimersByTimeAsync(0);
    const oldLogo = kiosk.getState().images.get(LOGO_ID)!.url;
    const background = kiosk.getState().images.get(BACKGROUND_ID)!.url;

    // The logo is replaced (same id, new bytes): a new hash.
    payload = slidesPayload("s3", [
      image(LOGO_ID, SHA_NEW_LOGO),
      image(BACKGROUND_ID, SHA_BACKGROUND),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api.callsTo(`GET /v1/device/images/${LOGO_ID}`)).toHaveLength(2);
    expect(api.callsTo(`GET /v1/device/images/${BACKGROUND_ID}`)).toHaveLength(
      1,
    );
    expect(blobs.revoked).toEqual([oldLogo]);
    expect(kiosk.getState().images.get(BACKGROUND_ID)!.url).toBe(background);
    expect(kiosk.getState().images.get(LOGO_ID)!.url).not.toBe(oldLogo);
    expect([...entries.keys()].sort()).toEqual([SHA_BACKGROUND, SHA_NEW_LOGO]);
  });

  it("retries an image that failed on the next poll", async () => {
    const { storage } = pairedStorage();
    let imagesUp = false;
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": (call) =>
        call.headers.get("if-none-match")
          ? reply(304, null)
          : json(slidesPayload("s2"), { headers: { etag: '"s2"' } }),
      [`GET /v1/device/images/${LOGO_ID}`]: () => {
        if (!imagesUp) throw new TypeError("fetch failed");
        return reply(200, new Blob(["logo"], { type: "image/png" }));
      },
      [`GET /v1/device/images/${BACKGROUND_ID}`]: imageRoute({
        [BACKGROUND_ID]: "bg",
      }),
    });
    const kiosk = startWith({ fetch: api.fetch, storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(kiosk.getState().images.has(LOGO_ID)).toBe(false);
    expect(kiosk.getState().images.has(BACKGROUND_ID)).toBe(true);
    expect(kiosk.getState().offline).toBe(false);

    imagesUp = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kiosk.getState().images.has(LOGO_ID)).toBe(true);
    expect(api.callsTo(`GET /v1/device/images/${BACKGROUND_ID}`)).toHaveLength(
      1,
    );
  });

  it("never sends the token to an image URL outside the device API", async () => {
    const { storage } = pairedStorage();
    const evil = {
      ...image(LOGO_ID, SHA_LOGO),
      url: "https://elsewhere.example/steal",
    };
    const urls: string[] = [];
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () => json(slidesPayload("s2", [evil])),
    });
    const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return api.fetch(input, init);
    }) as typeof fetch;
    const kiosk = startWith({ fetch: fetchSpy, storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(urls.some((url) => url.includes("elsewhere"))).toBe(false);
    expect(kiosk.getState().images.size).toBe(0);
  });

  it("starts offline with the cached payload and its cached images", async () => {
    const { storage } = pairedStorage({
      [DASHBOARD_KEY]: JSON.stringify({
        etag: '"s2"',
        payload: slidesPayload("s2"),
        updatedAt: T0 - 3600_000,
      }),
    });
    const { cache } = memoryImageCache({
      [SHA_LOGO]: new Blob(["logo"], { type: "image/png" }),
      [SHA_BACKGROUND]: new Blob(["bg"], { type: "image/png" }),
    });
    const api = fakeApi({});
    const kiosk = startWith({ fetch: api.fetch, storage, imageCache: cache });
    await vi.advanceTimersByTimeAsync(0);

    const state = kiosk.getState();
    expect(state.phase).toBe("paired");
    expect(state.offline).toBe(true);
    expect(state.dashboard?.version).toBe("s2");
    expect(isSlidesDashboard(state.dashboard!)).toBe(true);
    expect(state.images.size).toBe(2);
    expect(state.updatedAt).toBe(T0 - 3600_000);
  });

  it("revokes every image URL and empties the cache when the device is revoked", async () => {
    const { storage } = pairedStorage();
    const { cache, entries } = memoryImageCache();
    const blobs = fakeBlobUrls();
    let revoked = false;
    const api = fakeApi({
      "GET /v1/server": () => serverInfo([1, 2]),
      "GET /v1/device/dashboard": () =>
        revoked
          ? json({ error: "unauthorized" }, { status: 401 })
          : json(slidesPayload("s2")),
      "POST /v1/device/token": () =>
        json({ error: "unauthorized" }, { status: 401 }),
      "POST /v1/device/pairings": () => pairingResponse(),
      [`GET /v1/device/images/${LOGO_ID}`]: imageRoute({ [LOGO_ID]: "logo" }),
      [`GET /v1/device/images/${BACKGROUND_ID}`]: imageRoute({
        [BACKGROUND_ID]: "bg",
      }),
    });
    const kiosk = startWith({
      fetch: api.fetch,
      storage,
      imageCache: cache,
      blobUrls: blobs.urls,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(blobs.live.size).toBe(2);

    revoked = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kiosk.getState().phase).toBe("pairing");
    expect(kiosk.getState().images.size).toBe(0);
    expect(blobs.live.size).toBe(0);
    expect(entries.size).toBe(0);
  });
});
