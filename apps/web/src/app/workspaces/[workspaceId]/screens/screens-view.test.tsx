import { describe, expect, it, vi } from "vitest";

import type { Device } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ScreensView, type ScreenItem } from "./screens-view";
import { renderI18n } from "@/lib/i18n/test-render";
import { screenPreview } from "@/lib/screens";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

function device(overrides: Partial<Device>): Device {
  return {
    id: "d1",
    name: "Lobby",
    dashboardId: "x",
    rotation: 0,
    displayMode: "screen",
    screen: null,
    createdAt: "2026-09-01T10:00:00Z",
    lastSeenAt: "2026-10-04T11:58:00Z",
    revokedAt: null,
    heartbeat: null,
    ...overrides,
  };
}

function item(overrides: Partial<ScreenItem> & { device: Device }): ScreenItem {
  return {
    online: true,
    lastSeen: "2 minutes ago",
    revoked: null,
    dashboardName: "Sales",
    preview: screenPreview(null),
    appleTv: false,
    heartbeat: null,
    screenLine: null,
    paired: "Sep 1, 2026",
    ...overrides,
  };
}

const SCREENS: ScreenItem[] = [
  item({
    device: device({}),
    preview: {
      ...screenPreview(null),
      stubs: [{ left: 0, top: 0, width: 25, height: 37.5, quiet: false }],
    },
    heartbeat: {
      version: "web 0.9.0",
      at: "2 minutes ago",
      lastError: "Fetch failed",
      lastErrorFull: "Fetch failed: 503",
    },
    screenLine: "1920 × 1080 · 16:9 · Screen view",
  }),
  item({
    device: device({ id: "d2", name: "Kitchen", dashboardId: null }),
    online: false,
    lastSeen: "3 hours ago",
    dashboardName: null,
  }),
  item({
    device: device({
      id: "d3",
      name: "Old TV",
      revokedAt: "2026-10-01T10:00:00Z",
    }),
    online: false,
    lastSeen: "4 days ago",
    revoked: "3 days ago",
  }),
];

function render(
  props: Partial<Parameters<typeof ScreensView>[0]> = {},
  locale: Locale = "en",
) {
  return renderI18n(
    <ScreensView
      workspaceId="w"
      screens={SCREENS}
      counts={{ total: 2, online: 1, revoked: 1 }}
      dashboards={[{ id: "x", name: "Sales" }]}
      canManage
      {...props}
    />,
    locale,
  );
}

describe("Screens page", () => {
  it("shows the header, the count and the Connect a TV action", () => {
    const html = render();
    expect(html).toContain("All screens");
    expect(html).toContain("2 screens · 1 online");
    expect(html).toContain('href="/devices/approve"');
    expect(html).toContain("Connect a TV");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Cards</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Table</);
  });

  it("draws a card per screen with status, last seen and dashboard", () => {
    const html = render();
    expect(html.match(/class="screen-card[ "]/g)).toHaveLength(3);
    expect(html).toContain("status-dot--online");
    expect(html).toContain("status-dot--offline");
    expect(html).toContain("2 minutes ago");
    expect(html).toContain('class="screen-card-dashboard">Sales<');
    expect(html).toContain("screen-card-dashboard--none");
    // The widget stub of the first slide, positioned on the grid.
    expect(html).toContain("left:0%;top:0%;width:25%;height:37.5%");
    // Only the offline (not revoked) screen gets the overlay.
    expect(html.match(/screen-thumb-offline/g)).toHaveLength(1);
  });

  it("puts revoked screens dimmed in their own section", () => {
    const html = render();
    expect(html).toContain('class="screens-revoked"');
    expect(html).toContain("1 revoked screen");
    expect(html).toContain("screen-card screen-card--revoked");
    expect(html).toContain("Revoked");
  });

  it("opens the selected screen's details with health and its controls", () => {
    const html = render({ initialSelected: "d1" });
    expect(html).toContain("screens-layout--open");
    expect(html).toContain('aria-label="Screen details"');
    expect(html).toContain("web 0.9.0 · heartbeat 2 minutes ago");
    expect(html).toContain("1920 × 1080 · 16:9 · Screen view");
    expect(html).toContain('title="Fetch failed: 503"');
    expect(html).toContain("Sep 1, 2026");
    // Today's device controls: rename, reassign, rotation, mode, revoke.
    expect(html).toContain('id="device-d1-name"');
    expect(html).toContain('id="device-d1-dashboard"');
    expect(html).toContain('id="device-d1-rotation"');
    expect(html).toContain('id="device-d1-mode"');
    expect(html).toContain(">Revoke<");
    expect(html).toMatch(/class="screen-card"[^>]*aria-pressed="true"/);
  });

  it("shows no controls to viewers or for a revoked screen", () => {
    const viewer = render({ initialSelected: "d1", canManage: false });
    expect(viewer).not.toContain('id="device-d1-name"');
    expect(viewer).not.toContain("Connect a TV");
    expect(viewer).toContain("Only owners and admins");
    const revoked = render({ initialSelected: "d3" });
    expect(revoked).not.toContain('id="device-d3-name"');
    expect(revoked).toContain("Revoked 3 days ago.");
    expect(revoked).toContain('class="screens-revoked" open=""');
  });

  it("lists the same screens as a table", () => {
    const html = render({ initialView: "table" });
    expect(html).toContain('class="table screens-table"');
    expect(html.match(/class="screens-table-name"/g)).toHaveLength(3);
    expect(html).toContain('class="is-revoked"');
    expect(html).toContain("web 0.9.0");
    expect(html).not.toContain("screen-card");
  });

  it("explains how to connect a screen when there is none", () => {
    const html = render({
      screens: [],
      counts: { total: 0, online: 0, revoked: 0 },
    });
    expect(html).toContain("No screens yet");
    expect(html).toContain("shows a short code");
    expect(html).toContain('href="/devices/approve"');
    expect(html).not.toContain("view-switch");
  });

  it("speaks German", () => {
    const html = render({ initialSelected: "d1" }, "de");
    expect(html).toContain("Alle Bildschirme");
    expect(html).toContain("Karten");
    expect(html).toContain("Details zum Bildschirm");
    expect(html).toContain("1 widerrufener Bildschirm");
  });
});
