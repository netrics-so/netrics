import { describe, expect, it } from "vitest";

import type { Dashboard } from "@netrics/contracts";
import { BUILTIN_THEMES } from "@netrics/domain";

import {
  assignedDashboardIds,
  countScreens,
  firstSlide,
  screenPreview,
} from "./screens";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

function widget(
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Dashboard["slides"][number]["widgets"][number] {
  return { id: `${type}-${x}-${y}`, type, x, y, w, h } as never;
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    settings: {
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: null,
    },
    primaryFormat: "16x9",
    slides: [
      {
        id: "s2",
        position: 1,
        enabled: true,
        widgets: [widget("metric", 0, 0, 12, 8)],
      },
      {
        id: "s1",
        position: 0,
        enabled: true,
        widgets: [widget("metric", 0, 0, 3, 3), widget("text", 6, 4, 6, 4)],
      },
    ],
    ...overrides,
  } as Dashboard;
}

describe("firstSlide", () => {
  it("is the first enabled slide by position", () => {
    expect(firstSlide(dashboard())?.id).toBe("s1");
    const slides = dashboard().slides.map((slide) =>
      slide.id === "s1" ? { ...slide, enabled: false } : slide,
    );
    expect(firstSlide({ slides })?.id).toBe("s2");
  });

  it("falls back to the first slide when none is enabled", () => {
    const slides = dashboard().slides.map((slide) => ({
      ...slide,
      enabled: false,
    }));
    expect(firstSlide({ slides })?.id).toBe("s1");
    expect(firstSlide({ slides: [] })).toBeNull();
  });
});

describe("screenPreview", () => {
  it("places the first slide's widgets on the 12×8 grid in percent", () => {
    const preview = screenPreview(dashboard());
    expect(preview.stubs).toEqual([
      { left: 0, top: 0, width: 25, height: 37.5, quiet: false },
      { left: 50, top: 50, width: 50, height: 50, quiet: true },
    ]);
    expect(preview.aspectRatio).toBe("1920 / 1080");
    expect(preview.tall).toBe(false);
  });

  it("takes the dashboard's theme background, else netrics Dark", () => {
    const light = screenPreview(
      dashboard({
        settings: {
          ...dashboard().settings,
          themeBuiltin: "light",
        },
      }),
    );
    expect(light.background).toBe(BUILTIN_THEMES.light.tokens.background);
    const none = screenPreview(null);
    expect(none.background).toBe(BUILTIN_THEMES.netrics_dark.tokens.background);
    expect(none.stubs).toEqual([]);
  });

  it("uses a custom theme when the dashboard has one", () => {
    const tokens = {
      ...BUILTIN_THEMES.netrics_dark.tokens,
      background: "#123456",
    };
    const preview = screenPreview(
      dashboard({
        settings: {
          ...dashboard().settings,
          themeBuiltin: null,
          themeId: "00000000-0000-4000-8000-000000000001",
        },
      }),
      { name: "Brand", tokens },
    );
    expect(preview.background).toBe("#123456");
  });

  it("uses the primary format's grid and shape", () => {
    const preview = screenPreview(dashboard({ primaryFormat: "9x16" }));
    expect(preview.tall).toBe(true);
    expect(preview.aspectRatio).toBe("1080 / 1920");
  });
});

describe("assignedDashboardIds", () => {
  it("lists each shown dashboard once, ignoring revoked screens", () => {
    expect(
      assignedDashboardIds([
        { dashboardId: "a", revokedAt: null },
        { dashboardId: "a", revokedAt: null },
        { dashboardId: null, revokedAt: null },
        { dashboardId: "b", revokedAt: minutesAgo(5) },
        { dashboardId: "c", revokedAt: null },
      ]),
    ).toEqual(["a", "c"]);
  });
});

describe("countScreens", () => {
  it("counts active screens and the ones seen within 15 minutes", () => {
    expect(
      countScreens(
        [
          { lastSeenAt: minutesAgo(1), revokedAt: null },
          { lastSeenAt: minutesAgo(14), revokedAt: null },
          { lastSeenAt: minutesAgo(16), revokedAt: null },
          { lastSeenAt: null, revokedAt: null },
          { lastSeenAt: minutesAgo(1), revokedAt: minutesAgo(1) },
        ],
        NOW,
      ),
    ).toEqual({ total: 4, online: 2, revoked: 1 });
  });
});
