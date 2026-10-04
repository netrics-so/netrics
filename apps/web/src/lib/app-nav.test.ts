import { describe, expect, it } from "vitest";

import {
  ONLINE_WINDOW_MS,
  activeNavKey,
  isScreenOnline,
  shellVariant,
  sourcesNeedingAttention,
  workspaceNav,
} from "./app-nav";

const W = "11111111-2222-3333-4444-555555555555";
const ALL = { viewDevices: true, createConnections: true };

describe("workspaceNav (#302)", () => {
  it("lists only the areas that exist, at their routes", () => {
    expect(workspaceNav(W, ALL).map((item) => [item.key, item.href])).toEqual([
      ["home", `/workspaces/${W}`],
      ["dashboards", `/workspaces/${W}/dashboards`],
      ["themes", `/workspaces/${W}/settings/themes`],
      ["sources", `/workspaces/${W}/sources`],
      ["addSource", `/workspaces/${W}/connections/new`],
      ["screens", `/workspaces/${W}/screens`],
      ["team", `/workspaces/${W}/team`],
      ["settings", `/workspaces/${W}/settings`],
    ]);
  });

  it("leaves out what the role cannot open", () => {
    const keys = workspaceNav(W, {
      viewDevices: false,
      createConnections: false,
    }).map((item) => item.key);
    expect(keys).not.toContain("screens");
    expect(keys).not.toContain("addSource");
    expect(keys).toContain("sources");
  });
});

describe("activeNavKey", () => {
  it.each([
    ["", "home"],
    ["/", "home"],
    ["/dashboards", "dashboards"],
    ["/dashboards/d1", "dashboards"],
    ["/dashboards/d1/studio", "dashboards"],
    ["/settings/themes", "themes"],
    ["/settings/themes/t1", "themes"],
    ["/settings", "settings"],
    ["/sources", "sources"],
    ["/connections/c1", "sources"],
    ["/connections/new", "addSource"],
    ["/screens", "screens"],
    ["/team", "team"],
  ])("%s marks %s", (rest, key) => {
    expect(activeNavKey(`/workspaces/${W}${rest}`, W)).toBe(key);
  });

  it("marks nothing in another workspace or outside", () => {
    expect(activeNavKey(`/workspaces/other/dashboards`, W)).toBeNull();
    expect(activeNavKey(`/workspaces/${W}x`, W)).toBeNull();
    expect(activeNavKey("/settings/account", W)).toBeNull();
  });
});

describe("shellVariant", () => {
  it("frames pages with the sidebar, the Studio with the rail, TV mode not at all", () => {
    expect(shellVariant(`/workspaces/${W}`)).toBe("full");
    expect(shellVariant(`/workspaces/${W}/dashboards/d1`)).toBe("full");
    expect(shellVariant(`/workspaces/${W}/dashboards/d1/studio`)).toBe("rail");
    expect(shellVariant(`/workspaces/${W}/dashboards/d1/tv`)).toBe("none");
    expect(shellVariant(`/workspaces/${W}/dashboards/d1/tv/`)).toBe("none");
  });
});

describe("sourcesNeedingAttention", () => {
  it("counts failing and unfinished connections, not new ones", () => {
    const of = (health: string, setupPending = false) =>
      ({ setupPending, state: { health } }) as never;
    expect(sourcesNeedingAttention([])).toBe(0);
    expect(sourcesNeedingAttention([of("ok"), of("pending")])).toBe(0);
    expect(
      sourcesNeedingAttention([
        of("ok"),
        of("auth_failed"),
        of("needs_reauthorization"),
        of("outage"),
        of("pending", true),
      ]),
    ).toBe(4);
  });
});

describe("isScreenOnline", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const seen = (ms: number) => new Date(now - ms).toISOString();

  it("is online when seen within the window and not revoked", () => {
    expect(
      isScreenOnline({ lastSeenAt: seen(60_000), revokedAt: null }, now),
    ).toBe(true);
    expect(
      isScreenOnline(
        { lastSeenAt: seen(ONLINE_WINDOW_MS + 1), revokedAt: null },
        now,
      ),
    ).toBe(false);
    expect(isScreenOnline({ lastSeenAt: null, revokedAt: null }, now)).toBe(
      false,
    );
    expect(
      isScreenOnline({ lastSeenAt: seen(1), revokedAt: seen(0) }, now),
    ).toBe(false);
  });
});
