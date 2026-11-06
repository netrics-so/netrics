import { describe, expect, it, vi } from "vitest";

import {
  MIN_CHECK_GAP_MS,
  RELOAD_GUARD_KEY,
  RELOAD_GUARD_MS,
  createDeployWatcher,
  decideSkew,
  healthCommit,
  isBuildAssetUrl,
  isChunkLoadError,
  isKioskPath,
  parseReloadGuard,
  type DeployWatcherOptions,
  type SkewInput,
} from "./deploy-skew";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const T0 = Date.parse("2026-10-03T10:00:00.000Z");

const base: SkewInput = {
  bundleCommit: OLD,
  serverCommit: NEW,
  guard: null,
  now: T0,
  kiosk: false,
  editing: false,
};

describe("decideSkew", () => {
  it("reloads with a notice when the deployed commit differs", () => {
    expect(decideSkew(base)).toEqual({
      action: "reload",
      commit: NEW,
      notice: true,
    });
  });

  it("does nothing when the page runs the deployed build", () => {
    expect(decideSkew({ ...base, serverCommit: OLD })).toEqual({
      action: "none",
    });
  });

  it("does nothing when /healthz is unreachable", () => {
    expect(decideSkew({ ...base, serverCommit: null })).toEqual({
      action: "none",
    });
  });

  it.each(["dev", ""])(
    "is disabled for a bundle without a real commit (%j)",
    (bundleCommit) => {
      expect(decideSkew({ ...base, bundleCommit })).toEqual({
        action: "none",
      });
    },
  );

  it("ignores a server that reports the dev placeholder", () => {
    expect(decideSkew({ ...base, serverCommit: "dev" })).toEqual({
      action: "none",
    });
  });

  it("reloads the kiosk at once, without a notice, even with focus", () => {
    expect(decideSkew({ ...base, kiosk: true, editing: true })).toEqual({
      action: "reload",
      commit: NEW,
      notice: false,
    });
  });

  it("defers to the next navigation while someone is typing", () => {
    expect(decideSkew({ ...base, editing: true })).toEqual({
      action: "defer",
      commit: NEW,
    });
  });

  it("does not reload twice towards the same commit (no loop)", () => {
    const guard = { commit: NEW, at: T0 - 1000 };
    expect(decideSkew({ ...base, guard })).toEqual({ action: "none" });
    expect(decideSkew({ ...base, guard, kiosk: true })).toEqual({
      action: "none",
    });
  });

  it("tries again once the guard has expired", () => {
    const guard = { commit: NEW, at: T0 - RELOAD_GUARD_MS };
    expect(decideSkew({ ...base, guard }).action).toBe("reload");
  });

  it("reloads towards a newer commit despite a guard for an older one", () => {
    const guard = { commit: "3".repeat(40), at: T0 - 1000 };
    expect(decideSkew({ ...base, guard }).action).toBe("reload");
  });

  it("does not trust a guard from the future (clock change)", () => {
    const guard = { commit: NEW, at: T0 + 60_000 };
    expect(decideSkew({ ...base, guard }).action).toBe("reload");
  });
});

describe("helpers", () => {
  it("reads the commit from a /healthz body", () => {
    expect(healthCommit({ status: "ok", version: "1", commit: NEW })).toBe(NEW);
    expect(healthCommit({ status: "ok", commit: "dev" })).toBeNull();
    expect(healthCommit({ status: "ok" })).toBeNull();
    expect(healthCommit("<html>")).toBeNull();
    expect(healthCommit(null)).toBeNull();
  });

  it("recognises this origin's build assets", () => {
    const origin = "https://app.example.test";
    expect(
      isBuildAssetUrl(`${origin}/_next/static/chunks/0a1b.js`, origin),
    ).toBe(true);
    expect(isBuildAssetUrl("/_next/static/css/app.css", origin)).toBe(true);
    expect(isBuildAssetUrl(`${origin}/favicon.ico`, origin)).toBe(false);
    expect(
      isBuildAssetUrl("https://cdn.example.test/_next/static/x.js", origin),
    ).toBe(false);
  });

  it("recognises failed chunk loads", () => {
    const named = Object.assign(new Error("boom"), { name: "ChunkLoadError" });
    expect(isChunkLoadError(named)).toBe(true);
    expect(
      isChunkLoadError(
        new Error(
          "Failed to load chunk /_next/static/chunks/0a1b.js from module 123",
        ),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 42 failed."))).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("Failed to fetch dynamically imported module: x.js"),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("tells the kiosk from the app", () => {
    expect(isKioskPath("/kiosk")).toBe(true);
    expect(isKioskPath("/kiosk/x")).toBe(true);
    expect(isKioskPath("/kiosks")).toBe(false);
    expect(isKioskPath("/workspaces/1")).toBe(false);
  });

  it("parses only well-formed guards", () => {
    expect(parseReloadGuard(JSON.stringify({ commit: NEW, at: T0 }))).toEqual({
      commit: NEW,
      at: T0,
    });
    expect(parseReloadGuard("{")).toBeNull();
    expect(parseReloadGuard(JSON.stringify({ commit: NEW }))).toBeNull();
    expect(parseReloadGuard(null)).toBeNull();
  });
});

function setup(overrides: Partial<DeployWatcherOptions> = {}) {
  const data = new Map<string, string>();
  let now = T0;
  let serverCommit: string | null = OLD;
  const options = {
    bundleCommit: OLD,
    fetchServerCommit: vi.fn(async () => serverCommit),
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
    now: () => now,
    isKiosk: () => false,
    isEditing: () => false,
    reload: vi.fn(),
    reloadWithNotice: vi.fn(),
    deferToNavigation: vi.fn(),
    ...overrides,
  };
  return {
    options,
    data,
    watcher: createDeployWatcher(options),
    deploy: (commit: string | null) => {
      serverCommit = commit;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createDeployWatcher", () => {
  it("reloads once after a deploy and records the guard", async () => {
    const { watcher, options, data, deploy } = setup();
    await watcher.check();
    expect(options.reloadWithNotice).not.toHaveBeenCalled();

    deploy(NEW);
    await watcher.check();
    await watcher.check();
    expect(options.reloadWithNotice).toHaveBeenCalledTimes(1);
    expect(options.reload).not.toHaveBeenCalled();
    expect(parseReloadGuard(data.get(RELOAD_GUARD_KEY) ?? null)).toEqual({
      commit: NEW,
      at: T0,
    });
    expect(watcher.settled).toBe(true);
  });

  it("does not reload again after a reload that kept the old build", async () => {
    const first = setup();
    first.deploy(NEW);
    await first.watcher.check();
    expect(first.options.reloadWithNotice).toHaveBeenCalledTimes(1);

    // The "reloaded" page still runs OLD (a cache served the old HTML):
    // the same tab session must not loop.
    const second = setup({
      storage: {
        getItem: (key) => first.data.get(key) ?? null,
        setItem: (key, value) => void first.data.set(key, value),
      },
    });
    second.deploy(NEW);
    expect(await second.watcher.check()).toEqual({ action: "none" });
    expect(second.options.reloadWithNotice).not.toHaveBeenCalled();
  });

  it("reloads the kiosk directly", async () => {
    const { watcher, options, deploy } = setup({ isKiosk: () => true });
    deploy(NEW);
    await watcher.check();
    expect(options.reload).toHaveBeenCalledTimes(1);
    expect(options.reloadWithNotice).not.toHaveBeenCalled();
  });

  it("defers while editing", async () => {
    const { watcher, options, deploy } = setup({ isEditing: () => true });
    deploy(NEW);
    await watcher.check();
    expect(options.deferToNavigation).toHaveBeenCalledTimes(1);
    expect(options.reload).not.toHaveBeenCalled();
    expect(options.reloadWithNotice).not.toHaveBeenCalled();
  });

  it("stays put when /healthz fails or throws", async () => {
    const unreachable = setup();
    unreachable.deploy(null);
    await unreachable.watcher.check();
    expect(unreachable.options.reloadWithNotice).not.toHaveBeenCalled();

    const throwing = setup({
      fetchServerCommit: () => Promise.reject(new Error("offline")),
    });
    expect(await throwing.watcher.check()).toEqual({ action: "none" });
    expect(throwing.options.reload).not.toHaveBeenCalled();
    expect(throwing.options.reloadWithNotice).not.toHaveBeenCalled();
  });

  it("never asks /healthz for a dev bundle", async () => {
    const { watcher, options } = setup({ bundleCommit: "dev" });
    await watcher.check();
    await watcher.maybeCheck();
    expect(options.fetchServerCommit).not.toHaveBeenCalled();
  });

  it("shares one request between concurrent checks", async () => {
    const { watcher, options } = setup();
    await Promise.all([watcher.check(), watcher.check(), watcher.check()]);
    expect(options.fetchServerCommit).toHaveBeenCalledTimes(1);
  });

  it("throttles visibility checks but not error-driven ones", async () => {
    const { watcher, options, advance } = setup();
    await watcher.maybeCheck();
    expect(await watcher.maybeCheck()).toBeNull();
    expect(options.fetchServerCommit).toHaveBeenCalledTimes(1);
    await watcher.check();
    expect(options.fetchServerCommit).toHaveBeenCalledTimes(2);
    advance(MIN_CHECK_GAP_MS);
    await watcher.maybeCheck();
    expect(options.fetchServerCommit).toHaveBeenCalledTimes(3);
  });

  it("works without sessionStorage", async () => {
    const { watcher, options, deploy } = setup({
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    deploy(NEW);
    await watcher.check();
    expect(options.reloadWithNotice).toHaveBeenCalledTimes(1);
  });
});
