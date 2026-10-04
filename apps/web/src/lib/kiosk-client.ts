import type {
  CreatePairingResponse,
  DeviceCredentials,
  DeviceDashboardResponse,
  DeviceDashboardV2Response,
  DeviceImage,
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
 *
 * Slides (#221, ADR 0015 section 7): the kiosk asks for payload schema 2
 * when the server lists it in `/v1/server` (`dashboardSchemas`), else it
 * keeps schema 1. A schema 2 payload references images; they are fetched
 * with the device token, kept in Cache Storage by sha256 (only missing
 * hashes are downloaded) and handed to the page as `blob:` URLs, which are
 * revoked when no payload references them any more.
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
/** The payload schema with slides; 1 is the tile list. */
export const SLIDES_SCHEMA = 2;
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

/** Either payload schema: tiles (1) or slides (2). */
export type KioskDashboard =
  DeviceDashboardResponse | DeviceDashboardV2Response;

/** An image of the payload, ready to show: `url` is a `blob:` URL. */
export interface KioskImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Where image bytes are kept between page loads, by sha256: Cache Storage
 * in the browser (see `browserImageCache`), memory in tests.
 */
export interface KioskImageCache {
  get(sha256: string): Promise<Blob | null>;
  put(sha256: string, blob: Blob): Promise<void>;
  /** Drops every entry whose hash is not in `keep`. */
  prune(keep: ReadonlySet<string>): Promise<void>;
}

export interface KioskBlobUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export interface KioskState {
  /** starting: reading storage; pairing: showing a code; paired: dashboard. */
  phase: "starting" | "pairing" | "paired";
  pairing: KioskPairing | null;
  /** The last dashboard the API returned; kept through outages. */
  dashboard: KioskDashboard | null;
  /** The payload's images that are loaded, by image id (schema 2). */
  images: ReadonlyMap<string, KioskImage>;
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
  /** Keeps image bytes across reloads; memory only without it. */
  imageCache?: KioskImageCache | null;
  /** Defaults to URL.createObjectURL / revokeObjectURL. */
  blobUrls?: KioskBlobUrls;
}

export interface KioskClient {
  start(): void;
  stop(): void;
  getState(): KioskState;
}

interface CachedDashboard {
  etag: string | null;
  payload: KioskDashboard;
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
 * so the TV list can tell kiosks from the Apple TV app, which reports
 * "tvos <version>". "web" alone when the build carries no version.
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

/** Whether a payload is schema 2 (slides) rather than schema 1 (tiles). */
export function isSlidesDashboard(
  dashboard: KioskDashboard,
): dashboard is DeviceDashboardV2Response {
  return (dashboard as { schema?: unknown }).schema === SLIDES_SCHEMA;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A light shape check, not the contract's full parse: a newer server may
 * add widget types, which the canvas shows as a notice in their box.
 */
function isDashboard(value: unknown): value is KioskDashboard {
  if (!isRecord(value) || !isString(value.version)) {
    return false;
  }
  if (!isString(value.timeZone)) {
    return false;
  }
  if (value.schema === SLIDES_SCHEMA) {
    return (
      Array.isArray(value.slides) &&
      Array.isArray(value.images) &&
      isRecord(value.theme) &&
      isRecord(value.theme.tokens) &&
      isRecord(value.rotation)
    );
  }
  return Array.isArray(value.tiles);
}

/** The only image URLs the kiosk sends its token to: the device API's. */
const DEVICE_IMAGE_URL =
  /^\/v1\/device\/images\/[0-9a-f-]{36}\?v=[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function usableImage(image: DeviceImage): boolean {
  return (
    isRecord(image) &&
    isString(image.id) &&
    typeof image.sha256 === "string" &&
    SHA256.test(image.sha256) &&
    typeof image.url === "string" &&
    DEVICE_IMAGE_URL.test(image.url)
  );
}

/** The schemas a `/v1/server` body lists; [] when it lists none. */
export function serverDashboardSchemas(body: unknown): number[] {
  if (!isRecord(body) || !Array.isArray(body.dashboardSchemas)) {
    return [];
  }
  return body.dashboardSchemas.filter(
    (schema): schema is number => typeof schema === "number",
  );
}

const defaultBlobUrls: KioskBlobUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

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

  const imageCache = options.imageCache ?? null;
  const blobUrls = options.blobUrls ?? defaultBlobUrls;

  let state: KioskState = {
    phase: "starting",
    pairing: null,
    dashboard: null,
    images: new Map(),
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
  /** The schema to ask for; null until `/v1/server` has answered. */
  let schema: 1 | 2 | null = null;
  /** Blob URLs of loaded images, by sha256. */
  const loaded = new Map<string, string>();
  /** Image syncs run one after another; a newer payload ends an older one. */
  let imageQueue: Promise<void> = Promise.resolve();

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
    releaseImages();
    void imageCache?.prune(new Set()).catch(() => undefined);
    update({
      phase: "pairing",
      pairing: null,
      dashboard: null,
      images: new Map(),
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
      images: new Map(),
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
      const wanted = await dashboardSchema();
      if (at !== epoch) {
        return;
      }
      let response = await getDashboard(wanted);
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
        response = await getDashboard(wanted);
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
        // Images that could not be loaded before are tried again.
        if (missingImages(state.dashboard)) {
          syncImages(state.dashboard, { download: true, prune: false });
        }
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
      syncImages(payload, { download: true, prune: true });
    } catch (cause) {
      if (at !== epoch) {
        return;
      }
      failures += 1;
      update({ offline: true, lastError: errorMessage(cause) });
      schedule(backoffMs(failures), fetchDashboard);
    }
  }

  /**
   * The payload schema to ask for: 2 when `/v1/server` lists it, else 1
   * (a server from before slides). The answer is kept for this page load
   * (a deploy reloads the kiosk). When the server info cannot be read, the
   * schema of the payload on screen is kept, so an outage never switches a
   * slide screen back to tiles.
   */
  async function dashboardSchema(): Promise<1 | 2> {
    if (schema !== null) {
      return schema;
    }
    try {
      const response = await request("/v1/server", {});
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const body: unknown = await response.json();
      schema = serverDashboardSchemas(body).includes(SLIDES_SCHEMA) ? 2 : 1;
      return schema;
    } catch {
      return state.dashboard && isSlidesDashboard(state.dashboard) ? 2 : 1;
    }
  }

  function getDashboard(wanted: 1 | 2): Promise<Response> {
    // ETags are per schema: only offer one for the schema asked for.
    const current = state.dashboard;
    const sameSchema =
      current !== null && isSlidesDashboard(current) === (wanted === 2);
    return request(
      wanted === 2
        ? `/v1/device/dashboard?schema=${SLIDES_SCHEMA}`
        : "/v1/device/dashboard",
      {
        headers: {
          authorization: `Bearer ${credentials?.accessToken ?? ""}`,
          ...(etag && sameSchema ? { "if-none-match": etag } : {}),
        },
      },
    );
  }

  // ── Images (schema 2) ──────────────────────────────────────────────────

  function payloadImages(dashboard: KioskDashboard | null): DeviceImage[] {
    return dashboard && isSlidesDashboard(dashboard)
      ? dashboard.images.filter(usableImage)
      : [];
  }

  function missingImages(dashboard: KioskDashboard): boolean {
    return payloadImages(dashboard).some((image) => !loaded.has(image.sha256));
  }

  function releaseImages(keep: ReadonlySet<string> = new Set()) {
    for (const [sha256, url] of loaded) {
      if (!keep.has(sha256)) {
        blobUrls.revoke(url);
        loaded.delete(sha256);
      }
    }
  }

  function publishImages(images: readonly DeviceImage[]) {
    const ready = new Map<string, KioskImage>();
    for (const image of images) {
      const url = loaded.get(image.sha256);
      if (url) {
        ready.set(image.id, {
          id: image.id,
          url,
          width: image.width,
          height: image.height,
        });
      }
    }
    update({ images: ready });
  }

  async function downloadImage(image: DeviceImage): Promise<Blob | null> {
    if (!credentials) {
      return null;
    }
    try {
      const response = await request(image.url, {
        headers: {
          accept: image.contentType,
          authorization: `Bearer ${credentials.accessToken}`,
        },
      });
      // A refused or missing image stays missing until the next poll.
      return response.ok ? await response.blob() : null;
    } catch {
      return null;
    }
  }

  /**
   * Makes the payload's images showable: blob URLs already made are kept,
   * then Cache Storage, then (when `download`) the device API, one image
   * at a time. URLs of images the payload no longer references are
   * revoked; with `prune`, so are their cache entries.
   */
  function syncImages(
    dashboard: KioskDashboard,
    mode: { download: boolean; prune: boolean },
  ) {
    const at = epoch;
    const current = () => at === epoch && state.dashboard === dashboard;
    imageQueue = imageQueue.then(async () => {
      if (!current()) {
        return;
      }
      const images = payloadImages(dashboard);
      const hashes = new Set(images.map((image) => image.sha256));
      releaseImages(hashes);
      publishImages(images);
      for (const image of images) {
        if (loaded.has(image.sha256)) {
          continue;
        }
        let blob = await imageCache?.get(image.sha256).catch(() => null);
        let fresh = false;
        if (!blob && mode.download) {
          blob = await downloadImage(image);
          fresh = blob !== null;
        }
        if (!current()) {
          return;
        }
        if (!blob || loaded.has(image.sha256)) {
          continue;
        }
        if (fresh) {
          await imageCache?.put(image.sha256, blob).catch(() => undefined);
        }
        loaded.set(image.sha256, blobUrls.create(blob));
        publishImages(images);
      }
      if (mode.prune && current()) {
        await imageCache?.prune(hashes).catch(() => undefined);
      }
    });
  }

  function refreshAfterMs(dashboard: KioskDashboard): number {
    const seconds =
      dashboard.refreshAfterSec > 0
        ? dashboard.refreshAfterSec
        : DEFAULT_REFRESH_AFTER_SECONDS;
    return seconds * 1000;
  }

  function cache(payload: KioskDashboard, updatedAt: number) {
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
        images: new Map(),
        updatedAt: cached?.updatedAt ?? null,
        offline: false,
        lastError: null,
      });
      // Offline start: the cached payload with its cached images. The
      // first poll downloads whatever is missing.
      if (cached) {
        syncImages(cached.payload, { download: false, prune: false });
      }
      startPairedLoops();
    },
    stop() {
      running = false;
      epoch += 1;
      stopTimers();
      releaseImages();
    },
    getState() {
      return state;
    },
  };
}
