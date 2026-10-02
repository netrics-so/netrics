import type {
  CreatePairingResponse,
  DeviceCredentials,
  DeviceDashboardResponse,
  PollPairingResponse,
} from "@netrics/contracts";

/**
 * The browser kiosk's side of the device API (#59, ADR 0010, ADR 0011):
 * pairing, credential storage and rotation, the dashboard poll with ETags,
 * heartbeats and backoff. Framework-free so it can be tested with a fake
 * fetch, fake timers and an in-memory storage; the /kiosk page only renders
 * the state it reports.
 *
 * A wall screen must never go blank because the API is away: the last
 * dashboard stays on screen (and in storage, for a reload while the API is
 * down), marked offline, until a request succeeds again.
 */

export const CREDENTIALS_KEY = "netrics.kiosk.credentials";
export const DASHBOARD_KEY = "netrics.kiosk.dashboard";

/** Refresh the access token this long before it expires. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** The first heartbeat, once the kiosk has settled after pairing or load. */
export const FIRST_HEARTBEAT_MS = 10 * 1000;
export const BACKOFF_MIN_MS = 5 * 1000;
export const BACKOFF_MAX_MS = 60 * 1000;
/** A hanging request counts as a failure after this long. */
export const REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_REFRESH_AFTER_SECONDS = 60;
const MAX_ERROR_LENGTH = 500;

export interface KioskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KioskClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface KioskPairing {
  code: string;
  pairingUrl: string;
  approveUrl: string;
  expiresAt: string;
}

export interface KioskState {
  /** starting: reading storage; pairing: showing a code; paired: dashboard. */
  phase: "starting" | "pairing" | "paired";
  pairing: KioskPairing | null;
  /** The last dashboard the API returned; kept through outages. */
  dashboard: DeviceDashboardResponse | null;
  /** When the API last confirmed the dashboard (200 or 304), epoch ms. */
  updatedAt: number | null;
  /** The latest request failed; the screen shows the last known state. */
  offline: boolean;
  lastError: string | null;
}

export interface KioskClientOptions {
  fetch: typeof fetch;
  storage: KioskStorage;
  clock?: KioskClock;
  /** Prefix for API paths; "" for the same-origin /v1 proxy. */
  baseUrl?: string;
  /** The web app's version; reported as "web <version>". */
  appVersion: string;
  onChange?: (state: KioskState) => void;
}

export interface KioskClient {
  start(): void;
  stop(): void;
  getState(): KioskState;
}

interface CachedDashboard {
  etag: string | null;
  payload: DeviceDashboardResponse;
  updatedAt: number;
}

type RefreshOutcome = "ok" | "revoked" | "failed";

const systemClock: KioskClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 5 s, 10 s, 20 s, 40 s, then 60 s for every further failure. */
export function backoffMs(failures: number): number {
  const exponent = Math.max(failures - 1, 0);
  return Math.min(BACKOFF_MIN_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

/** The heartbeat's appVersion field accepts at most this many characters. */
const MAX_APP_VERSION_LENGTH = 50;

/**
 * What a browser kiosk reports as its app version: "web <version>" (#125),
 * so the TV list can tell kiosks from the Apple TV app, which reports its
 * bare marketing version. "web" alone when the build carries no version.
 */
export function kioskAppVersion(webVersion: string): string {
  const version = webVersion.trim();
  return (version ? `web ${version}` : "web").slice(0, MAX_APP_VERSION_LENGTH);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCredentials(raw: string | null): DeviceCredentials | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<DeviceCredentials>;
    if (
      isString(value.accessToken) &&
      isString(value.accessTokenExpiresAt) &&
      isString(value.refreshToken) &&
      isString(value.refreshTokenExpiresAt)
    ) {
      return {
        accessToken: value.accessToken,
        accessTokenExpiresAt: value.accessTokenExpiresAt,
        refreshToken: value.refreshToken,
        refreshTokenExpiresAt: value.refreshTokenExpiresAt,
      };
    }
  } catch {
    // Unreadable: pair again.
  }
  return null;
}

function isDashboard(value: unknown): value is DeviceDashboardResponse {
  const candidate = value as Partial<DeviceDashboardResponse> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    isString(candidate.version) &&
    isString(candidate.timeZone) &&
    Array.isArray(candidate.tiles)
  );
}

function parseCachedDashboard(raw: string | null): CachedDashboard | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<CachedDashboard>;
    if (isDashboard(value.payload) && typeof value.updatedAt === "number") {
      return {
        etag: typeof value.etag === "string" ? value.etag : null,
        payload: value.payload,
        updatedAt: value.updatedAt,
      };
    }
  } catch {
    // Ignore a damaged cache; the next fetch replaces it.
  }
  return null;
}

function errorMessage(cause: unknown): string {
  const text =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return text.slice(0, MAX_ERROR_LENGTH);
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

export function createKioskClient(options: KioskClientOptions): KioskClient {
  const clock = options.clock ?? systemClock;
  const baseUrl = options.baseUrl ?? "";
  const { storage } = options;

  let state: KioskState = {
    phase: "starting",
    pairing: null,
    dashboard: null,
    updatedAt: null,
    offline: false,
    lastError: null,
  };
  let credentials: DeviceCredentials | null = null;
  let etag: string | null = null;
  let pairingSecret: { pairingId: string; pollSecret: string } | null = null;
  let pollIntervalMs = 5000;
  let failures = 0;
  let startedAt = 0;
  let running = false;
  // Bumped on stop and on every phase change: late responses of an earlier
  // phase are dropped instead of acting on the new one.
  let epoch = 0;
  let loopTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let refreshing: Promise<RefreshOutcome> | null = null;

  function update(patch: Partial<KioskState>) {
    state = { ...state, ...patch };
    options.onChange?.(state);
  }

  // Storage can throw (private mode, quota); the kiosk keeps running on
  // what it holds in memory.
  function read(key: string): string | null {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }
  function write(key: string, value: string) {
    try {
      storage.setItem(key, value);
    } catch {
      // See above.
    }
  }
  function remove(key: string) {
    try {
      storage.removeItem(key);
    } catch {
      // See above.
    }
  }

  function schedule(ms: number, step: () => Promise<void>) {
    clock.clearTimeout(loopTimer);
    const scheduledIn = epoch;
    loopTimer = clock.setTimeout(() => {
      if (running && scheduledIn === epoch) {
        void step();
      }
    }, ms);
  }

  function stopTimers() {
    clock.clearTimeout(loopTimer);
    clock.clearTimeout(heartbeatTimer);
    loopTimer = null;
    heartbeatTimer = null;
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = clock.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      return await options.fetch(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
    } finally {
      clock.clearTimeout(timer);
    }
  }

  // ── Pairing ────────────────────────────────────────────────────────────

  function enterPairing() {
    epoch += 1;
    stopTimers();
    credentials = null;
    etag = null;
    pairingSecret = null;
    remove(CREDENTIALS_KEY);
    remove(DASHBOARD_KEY);
    failures = 0;
    update({
      phase: "pairing",
      pairing: null,
      dashboard: null,
      updatedAt: null,
      offline: false,
    });
    void startPairing();
  }

  async function startPairing(): Promise<void> {
    const at = epoch;
    try {
      const response = await request("/v1/device/pairings", {
        method: "POST",
      });
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const pairing = (await response.json()) as CreatePairingResponse;
      if (at !== epoch) {
        return;
      }
      failures = 0;
      pairingSecret = {
        pairingId: pairing.pairingId,
        pollSecret: pairing.pollSecret,
      };
      pollIntervalMs = Math.max(pairing.pollIntervalSeconds, 1) * 1000;
      update({
        pairing: {
          code: pairing.code,
          pairingUrl: pairing.pairingUrl,
          approveUrl: pairing.approveUrl,
          expiresAt: pairing.expiresAt,
        },
        offline: false,
        lastError: null,
      });
      schedule(pollIntervalMs, pollPairing);
    } catch (cause) {
      if (at !== epoch) {
        return;
      }
      failures += 1;
      update({ offline: true, lastError: errorMessage(cause) });
      schedule(backoffMs(failures), startPairing);
    }
  }

  async function pollPairing(): Promise<void> {
    const at = epoch;
    const pairing = state.pairing;
    if (!pairingSecret || !pairing) {
      return startPairing();
    }
    if (clock.now() >= Date.parse(pairing.expiresAt)) {
      // Expired unclaimed: show a fresh code.
      update({ pairing: null });
      return startPairing();
    }
    try {
      const response = await request("/v1/device/pairings/poll", {
        method: "POST",
        body: pairingSecret,
      });
      if (at !== epoch) {
        return;
      }
      if (response.status === 404 || response.status === 410) {
        update({ pairing: null });
        return startPairing();
      }
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const result = (await response.json()) as PollPairingResponse;
      if (at !== epoch) {
        return;
      }
      failures = 0;
      if (result.status === "approved") {
        return enterPaired(result.credentials);
      }
      update({ offline: false, lastError: null });
      schedule(pollIntervalMs, pollPairing);
    } catch (cause) {
      if (at !== epoch) {
        return;
      }
      failures += 1;
      update({ offline: true, lastError: errorMessage(cause) });
      schedule(Math.max(backoffMs(failures), pollIntervalMs), pollPairing);
    }
  }

  // ── Paired: credentials, dashboard, heartbeat ───────────────────────────

  function persistCredentials(next: DeviceCredentials) {
    // Stored before first use: a crash after the server rotated the pair
    // must not leave only the retired refresh token behind.
    write(CREDENTIALS_KEY, JSON.stringify(next));
    credentials = next;
  }

  function enterPaired(next: DeviceCredentials) {
    epoch += 1;
    stopTimers();
    persistCredentials(next);
    remove(DASHBOARD_KEY);
    etag = null;
    pairingSecret = null;
    failures = 0;
    update({
      phase: "paired",
      pairing: null,
      dashboard: null,
      updatedAt: null,
      offline: false,
      lastError: null,
    });
    startPairedLoops();
  }

  function startPairedLoops() {
    void fetchDashboard();
    scheduleHeartbeat(FIRST_HEARTBEAT_MS);
  }

  /** One refresh at a time; concurrent callers share its outcome. */
  function refresh(): Promise<RefreshOutcome> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function doRefresh(): Promise<RefreshOutcome> {
    const at = epoch;
    // Another tab may have rotated the pair already: use its tokens rather
    // than presenting a retired refresh token.
    const stored = parseCredentials(read(CREDENTIALS_KEY));
    if (
      stored &&
      credentials &&
      stored.refreshToken !== credentials.refreshToken &&
      Date.parse(stored.accessTokenExpiresAt) - clock.now() > REFRESH_MARGIN_MS
    ) {
      credentials = stored;
      return "ok";
    }
    if (!credentials) {
      return "revoked";
    }
    const response = await request("/v1/device/token", {
      method: "POST",
      body: { refreshToken: credentials.refreshToken },
    });
    if (at !== epoch) {
      return "failed";
    }
    if (response.status === 401) {
      return "revoked";
    }
    if (!response.ok) {
      throw new HttpError(response.status);
    }
    const body = (await response.json()) as {
      credentials: DeviceCredentials;
    };
    if (at !== epoch) {
      return "failed";
    }
    persistCredentials(body.credentials);
    return "ok";
  }

  function needsRefresh(): boolean {
    return (
      credentials !== null &&
      Date.parse(credentials.accessTokenExpiresAt) - clock.now() <=
        REFRESH_MARGIN_MS
    );
  }

  async function fetchDashboard(): Promise<void> {
    const at = epoch;
    try {
      if (needsRefresh()) {
        const outcome = await refresh();
        if (at !== epoch) {
          return;
        }
        if (outcome === "revoked") {
          return enterPairing();
        }
      }
      let response = await getDashboard();
      if (at !== epoch) {
        return;
      }
      if (response.status === 401) {
        // Expired early or rotated elsewhere: one refresh, one retry.
        const outcome = await refresh();
        if (at !== epoch) {
          return;
        }
        if (outcome === "revoked") {
          return enterPairing();
        }
        response = await getDashboard();
        if (at !== epoch) {
          return;
        }
        if (response.status === 401) {
          // A fresh token refused: the device was revoked.
          return enterPairing();
        }
      }
      const now = clock.now();
      if (response.status === 304 && state.dashboard) {
        failures = 0;
        update({ updatedAt: now, offline: false, lastError: null });
        cache(state.dashboard, now);
        schedule(refreshAfterMs(state.dashboard), fetchDashboard);
        return;
      }
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const payload: unknown = await response.json();
      if (at !== epoch) {
        return;
      }
      if (!isDashboard(payload)) {
        throw new Error("Unexpected dashboard response");
      }
      failures = 0;
      etag = response.headers.get("etag") ?? `"${payload.version}"`;
      cache(payload, now);
      update({
        dashboard: payload,
        updatedAt: now,
        offline: false,
        lastError: null,
      });
      schedule(refreshAfterMs(payload), fetchDashboard);
    } catch (cause) {
      if (at !== epoch) {
        return;
      }
      failures += 1;
      update({ offline: true, lastError: errorMessage(cause) });
      schedule(backoffMs(failures), fetchDashboard);
    }
  }

  function getDashboard(): Promise<Response> {
    return request("/v1/device/dashboard", {
      headers: {
        authorization: `Bearer ${credentials?.accessToken ?? ""}`,
        ...(etag && state.dashboard ? { "if-none-match": etag } : {}),
      },
    });
  }

  function refreshAfterMs(dashboard: DeviceDashboardResponse): number {
    const seconds =
      dashboard.refreshAfterSec > 0
        ? dashboard.refreshAfterSec
        : DEFAULT_REFRESH_AFTER_SECONDS;
    return seconds * 1000;
  }

  function cache(payload: DeviceDashboardResponse, updatedAt: number) {
    const entry: CachedDashboard = { etag, payload, updatedAt };
    write(DASHBOARD_KEY, JSON.stringify(entry));
  }

  function scheduleHeartbeat(ms: number) {
    clock.clearTimeout(heartbeatTimer);
    const scheduledIn = epoch;
    heartbeatTimer = clock.setTimeout(() => {
      if (running && scheduledIn === epoch) {
        void sendHeartbeat().finally(() => {
          if (running && scheduledIn === epoch) {
            scheduleHeartbeat(HEARTBEAT_INTERVAL_MS);
          }
        });
      }
    }, ms);
  }

  async function sendHeartbeat(): Promise<void> {
    if (!credentials) {
      return;
    }
    try {
      await request("/v1/device/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.accessToken}` },
        body: {
          appVersion: kioskAppVersion(options.appVersion),
          uptimeSeconds: Math.max(
            Math.floor((clock.now() - startedAt) / 1000),
            0,
          ),
          lastError: state.lastError,
        },
      });
    } catch {
      // Best effort: the dashboard loop reports outages.
    }
  }

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      epoch += 1;
      startedAt = clock.now();
      credentials = parseCredentials(read(CREDENTIALS_KEY));
      if (!credentials) {
        enterPairing();
        return;
      }
      const cached = parseCachedDashboard(read(DASHBOARD_KEY));
      etag = cached?.etag ?? null;
      failures = 0;
      update({
        phase: "paired",
        pairing: null,
        dashboard: cached?.payload ?? null,
        updatedAt: cached?.updatedAt ?? null,
        offline: false,
        lastError: null,
      });
      startPairedLoops();
    },
    stop() {
      running = false;
      epoch += 1;
      stopTimers();
    },
    getState() {
      return state;
    },
  };
}
