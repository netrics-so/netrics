/**
 * Deploy skew (#200): a page loaded before a deploy keeps referencing the
 * previous build's /_next/static chunks, which the new build no longer
 * serves. The page notices a new deployment (a failed chunk load, or the
 * commit on /healthz differing from the one baked into its bundle) and
 * reloads once onto the new build.
 *
 * Everything here is free of the DOM so it can be tested; the client
 * component components/deploy-watcher.tsx wires it to the browser. It works
 * without any platform support (self-hosted images included).
 */

/** How often an open page asks /healthz which commit is deployed. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** A tab coming back into view checks at most this often. */
export const MIN_CHECK_GAP_MS = 30 * 1000;

/** The normal app shows the notice this long before reloading. */
export const NOTICE_DELAY_MS = 2_500;

/**
 * After reloading towards a commit, the same tab does not reload towards it
 * again for this long: if the reload still served the old build (a cache, a
 * deploy still rolling out), it must not loop.
 */
export const RELOAD_GUARD_MS = 30 * 60 * 1000;

export const RELOAD_GUARD_KEY = "netrics:deploy-reload";

/** Commits that do not identify a build: local and unconfigured builds. */
export function isRealCommit(commit: string | null | undefined): boolean {
  return typeof commit === "string" && commit !== "" && commit !== "dev";
}

/** The commit in a /healthz body, or null for anything else. */
export function healthCommit(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const commit = (body as { commit?: unknown }).commit;
  return typeof commit === "string" && isRealCommit(commit) ? commit : null;
}

/** Whether a script or stylesheet URL is one of this origin's build assets. */
export function isBuildAssetUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return (
      parsed.origin === origin && parsed.pathname.startsWith("/_next/static/")
    );
  } catch {
    return false;
  }
}

const CHUNK_ERROR_MESSAGE =
  /Failed to load chunk|Loading (CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** Whether an unhandled rejection is a failed chunk load. */
export function isChunkLoadError(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return typeof reason === "string" && CHUNK_ERROR_MESSAGE.test(reason);
  }
  const { name, message } = reason as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") {
    return true;
  }
  return typeof message === "string" && CHUNK_ERROR_MESSAGE.test(message);
}

export interface ReloadGuard {
  /** The commit the tab last reloaded towards. */
  commit: string;
  /** When, in epoch milliseconds. */
  at: number;
}

export function parseReloadGuard(raw: string | null): ReloadGuard | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<ReloadGuard>;
    return typeof value.commit === "string" && typeof value.at === "number"
      ? { commit: value.commit, at: value.at }
      : null;
  } catch {
    return null;
  }
}

export type SkewDecision =
  /** Nothing to do: same build, unknown deployment, or already tried. */
  | { action: "none" }
  /** Reload now (the kiosk) or after a short notice (the app). */
  | { action: "reload"; commit: string; notice: boolean }
  /** Someone is typing: reload on the next navigation instead. */
  | { action: "defer"; commit: string };

export interface SkewInput {
  /** The commit this page's bundle was built from. */
  bundleCommit: string;
  /** The deployed commit per /healthz; null when unreachable or unknown. */
  serverCommit: string | null;
  guard: ReloadGuard | null;
  now: number;
  /** A long-running screen (/kiosk): nobody types, reload right away. */
  kiosk: boolean;
  /** A form holds input that a reload would lose. */
  editing: boolean;
}

export function decideSkew(input: SkewInput): SkewDecision {
  const { bundleCommit, serverCommit, guard } = input;
  if (!isRealCommit(bundleCommit) || !isRealCommit(serverCommit)) {
    return { action: "none" };
  }
  const commit = serverCommit as string;
  if (commit === bundleCommit) {
    return { action: "none" };
  }
  if (
    guard &&
    guard.commit === commit &&
    input.now - guard.at >= 0 &&
    input.now - guard.at < RELOAD_GUARD_MS
  ) {
    return { action: "none" };
  }
  if (input.kiosk) {
    return { action: "reload", commit, notice: false };
  }
  if (input.editing) {
    return { action: "defer", commit };
  }
  return { action: "reload", commit, notice: true };
}

export function isKioskPath(pathname: string): boolean {
  return pathname === "/kiosk" || pathname.startsWith("/kiosk/");
}

export interface GuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DeployWatcherOptions {
  bundleCommit: string;
  /** The deployed commit, or null when /healthz is unreachable or odd. */
  fetchServerCommit: () => Promise<string | null>;
  storage: GuardStorage | null;
  now: () => number;
  isKiosk: () => boolean;
  isEditing: () => boolean;
  /** Reload the page now. */
  reload: () => void;
  /** Show the notice, then reload after NOTICE_DELAY_MS. */
  reloadWithNotice: () => void;
  /** Show the notice and reload on the next navigation. */
  deferToNavigation: () => void;
}

export interface DeployWatcher {
  /** Ask /healthz and act on the answer. Concurrent calls share one check. */
  check(): Promise<SkewDecision>;
  /** A visibility change or timer tick: checks unless one ran recently. */
  maybeCheck(): Promise<SkewDecision | null>;
  /** The next step has been taken (reload pending or deferred). */
  readonly settled: boolean;
}

export function createDeployWatcher(
  options: DeployWatcherOptions,
): DeployWatcher {
  let inFlight: Promise<SkewDecision> | null = null;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let settled = false;

  function readGuard(): ReloadGuard | null {
    try {
      return parseReloadGuard(
        options.storage?.getItem(RELOAD_GUARD_KEY) ?? null,
      );
    } catch {
      return null;
    }
  }

  function writeGuard(commit: string) {
    try {
      options.storage?.setItem(
        RELOAD_GUARD_KEY,
        JSON.stringify({ commit, at: options.now() }),
      );
    } catch {
      // Without storage the guard cannot hold; reloading once per tab
      // session is still bounded by the check interval.
    }
  }

  async function run(): Promise<SkewDecision> {
    lastCheck = options.now();
    let serverCommit: string | null;
    try {
      serverCommit = await options.fetchServerCommit();
    } catch {
      serverCommit = null;
    }
    if (settled) {
      return { action: "none" };
    }
    const decision = decideSkew({
      bundleCommit: options.bundleCommit,
      serverCommit,
      guard: readGuard(),
      now: options.now(),
      kiosk: options.isKiosk(),
      editing: options.isEditing(),
    });
    if (decision.action === "reload") {
      settled = true;
      writeGuard(decision.commit);
      if (decision.notice) {
        options.reloadWithNotice();
      } else {
        options.reload();
      }
    } else if (decision.action === "defer") {
      settled = true;
      writeGuard(decision.commit);
      options.deferToNavigation();
    }
    return decision;
  }

  return {
    check() {
      if (!isRealCommit(options.bundleCommit) || settled) {
        return Promise.resolve({ action: "none" });
      }
      inFlight ??= run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async maybeCheck() {
      if (options.now() - lastCheck < MIN_CHECK_GAP_MS) {
        return null;
      }
      return this.check();
    },
    get settled() {
      return settled;
    },
  };
}
