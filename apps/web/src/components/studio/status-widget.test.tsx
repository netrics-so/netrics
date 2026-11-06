import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceWidget } from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import {
  liveStatusItems,
  statusAgeText,
  statusFooterText,
  statusWidgetLayout,
  type StatusItem,
} from "@/lib/studio-status";
import { ScrollStatusCard } from "@/components/scroll/scroll-widgets";

import { DeviceWidgetView, deviceStatusReading } from "./device-widget";
import { StatusWidgetView } from "./status-widget";

// The status board (ADR 0019 section 7, #338).

const NOW = Date.parse("2026-10-04T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const item = (
  n: number,
  name: string,
  status: StatusItem["status"],
  lastSuccessAt: string | null,
): StatusItem => ({
  connectionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name,
  status,
  lastSuccessAt,
});

// As the server sends them: attention first, then by name.
const items: StatusItem[] = [
  item(1, "Stripe", "auth_failed", "2026-10-04T09:00:00Z"),
  item(2, "App Store Connect", "stale", "2026-10-03T08:00:00Z"),
  item(3, "Plausible", "backfilling", null),
  item(4, "Google Search Console", "ok", "2026-10-04T11:46:00Z"),
  item(5, "Vercel", "ok", "2026-10-04T11:57:00Z"),
  item(6, "YouTube", "ok", "2026-10-04T11:58:00Z"),
  item(7, "Zendesk", "ok", "2026-10-04T11:59:00Z"),
];

const props = {
  label: "Sources",
  options: { showAge: true },
  items,
  placement: { x: 0, y: 0, w: 3, h: 3 },
  showHeader: true,
  fontScale: 1,
};

const names = (html: string) =>
  [...html.matchAll(/class="sw-status-name"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );

describe("status board", () => {
  it("lists problems first, then '+N more' on a 3 × 3 board", () => {
    const html = renderI18n(<StatusWidgetView {...props} />);
    // Five rows fit at font scale 1: four sources and "+3 more".
    expect(names(html)).toEqual([
      "Stripe",
      "App Store Connect",
      "Plausible",
      "Google Search Console",
      "+3 more",
    ]);
    expect(html).toContain('class="sw-status-row down"');
    expect(html).toContain('class="sw-status-row warning"');
    expect(html).toContain('class="sw-status-row muted"');
    expect(html).toContain('class="sw-status-row up"');
    // Ages from lastSuccessAt; stale ones in the warning colour.
    expect(html).toContain('class="sw-status-age stale"');
    expect(html).toMatch(/sw-status-age stale"[^>]*>1 d</);
    expect(html).toContain(">3 h<");
    expect(html).toContain(">14 m<");
    expect(html).toContain(">never<");
    expect(html).toContain("7 connected · 1 failing<");
    expect(html).toContain('aria-label="Stripe: needs attention"');
  });

  it("never hides a problem at font scale 1.3", () => {
    const html = renderI18n(<StatusWidgetView {...props} fontScale={1.3} />);
    // Three rows: two problems and "+5 more" (the backfilling source and
    // the healthy ones are the hidden ones).
    expect(names(html)).toEqual(["Stripe", "App Store Connect", "+5 more"]);
    // "+N more" takes the worst hidden tone: muted (backfilling, ok).
    expect(html).toContain('class="sw-status-row sw-status-more muted"');
  });

  it("colours +N more when it hides a problem", () => {
    const many = [
      item(1, "A", "auth_failed", null),
      item(2, "B", "outage", null),
      item(3, "C", "stale", null),
      item(4, "D", "stale", null),
    ];
    const layout = statusWidgetLayout({
      label: "Sources",
      items: many,
      showAge: true,
      placement: { x: 0, y: 0, w: 3, h: 3 },
      showHeader: true,
      fontScale: 1.3,
      now: NOW,
      locale: "en",
    });
    expect(layout.rows.map((row) => row.name)).toEqual(["A", "B"]);
    expect(layout.more).toEqual({ count: 2, tone: "warning" });
  });

  it("shows every source that fits and no age without showAge", () => {
    const html = renderI18n(
      <StatusWidgetView
        {...props}
        items={items.slice(0, 3)}
        options={{ showAge: false }}
      />,
    );
    expect(names(html)).toEqual(["Stripe", "App Store Connect", "Plausible"]);
    expect(html).not.toContain("sw-status-age");
    expect(html).not.toContain("more");
  });

  it("says when no sources are connected", () => {
    const html = renderI18n(<StatusWidgetView {...props} items={[]} />);
    expect(html).toContain("No sources connected");
    expect(html).not.toContain("connected ·");
    expect(
      renderI18n(<StatusWidgetView {...props} items={[]} />, "de"),
    ).toContain("Keine Quellen verbunden");
  });

  it("speaks German", () => {
    const html = renderI18n(<StatusWidgetView {...props} />, "de");
    expect(html).toContain("+3 weitere");
    expect(html).toContain(">14 min<");
    expect(html).toContain(">1 T<");
    expect(html).toContain("7 verbunden · 1 gestört<");
  });

  it("shrinks a long name, then ends it with an ellipsis", () => {
    const long = item(
      9,
      "A very long connection name that cannot fit the board",
      "ok",
      "2026-10-04T11:59:00Z",
    );
    const html = renderI18n(<StatusWidgetView {...props} items={[long]} />);
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain(`title="${long.name}"`);
  });

  it("renders a payload board, and an unknown type safely", () => {
    const widget = {
      type: "status",
      id: "00000000-0000-4000-8000-000000000001",
      x: 0,
      y: 0,
      w: 3,
      h: 3,
      label: "Sources",
      options: { connectionIds: null, showAge: true },
      data: { status: "ok", items: items.slice(0, 2) },
    } as const satisfies DeviceWidget;
    expect(deviceStatusReading(widget).items).toHaveLength(2);
    const env = {
      timeZone: "UTC",
      fontScale: 1,
      showHeader: true,
      images: new Map(),
    };
    const html = renderI18n(<DeviceWidgetView widget={widget} env={env} />);
    expect(names(html)).toEqual(["Stripe", "App Store Connect"]);
    expect(html).toContain("data-rise=");
  });
});

describe("status board helpers", () => {
  it("words ages and drops footer counts that do not fit", () => {
    expect(statusAgeText("2026-10-04T11:46:00Z", NOW, "en")).toBe("14 m");
    expect(statusAgeText(null, NOW, "de")).toBe("nie");
    expect(statusFooterText(items, "en")).toBe(
      "7 connected · 1 failing · 1 delayed",
    );
    expect(statusFooterText(items, "en", { width: 200, size: 24 })).toBe(
      "7 connected",
    );
  });

  it("derives live items from the workspace's connections", () => {
    const state = (patch: object) => ({
      health: "ok" as const,
      authState: "ok" as const,
      authReason: null,
      lastSuccessAt: "2026-10-04T11:58:00Z",
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 300,
      ...patch,
    });
    const connections = {
      a: { name: "Vercel", state: state({}) },
      b: {
        name: "Search Console",
        state: state({ health: "pending", lastSuccessAt: null }),
        setupPending: true,
      },
      c: {
        name: "Old",
        state: state({ lastSuccessAt: "2026-10-04T10:00:00Z" }),
      },
    };
    expect(
      liveStatusItems(connections, null, NOW).map((entry) => [
        entry.connectionId,
        entry.status,
      ]),
    ).toEqual([
      ["b", "auth_failed"],
      ["c", "stale"],
      ["a", "ok"],
    ]);
    expect(
      liveStatusItems(connections, ["a", "gone"], NOW).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Vercel"]);
  });
});

describe("status card in scroll view", () => {
  it("lists every source with its age", () => {
    const html = renderI18n(
      <ScrollStatusCard
        label="Sources"
        options={{ showAge: true }}
        items={items}
        width={358}
        rootPx={16}
      />,
    );
    expect(
      [...html.matchAll(/class="scroll-status-name"[^>]*>([^<]*)</g)].map(
        (match) => match[1],
      ),
    ).toEqual(items.map((entry) => entry.name));
    expect(html).not.toContain("more");
  });
});
