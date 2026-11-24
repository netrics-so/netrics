import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceWidget } from "@netrics/contracts";
import {
  SERVICE_STATES,
  serviceStateCounts,
  type ServiceStateCounts,
} from "@netrics/domain";

import { renderI18n } from "@/lib/i18n/test-render";

import { failedStates } from "./dashboard-data-provider";
import { DeviceWidgetView } from "./device-widget";
import {
  StateWidgetView,
  type StateItemView,
  type StateViewOptions,
} from "./state-widget";

// The state widget on the web (#875): Studio canvas, kiosk and scroll view
// draw the same view. Every state is a word and an icon of its own shape.

const NOW = Date.parse("2026-11-10T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const ITEMS: StateItemView[] = [
  {
    name: "api",
    state: "failed",
    rolledBack: false,
    changedAt: "2026-11-10T09:00:00.000Z",
  },
  { name: "db", state: "down", rolledBack: false, changedAt: null },
  { name: "worker", state: "building", rolledBack: false, changedAt: null },
  {
    name: "site",
    state: "up",
    rolledBack: true,
    changedAt: "2026-11-08T12:00:00.000Z",
  },
  { name: "web", state: "up", rolledBack: false, changedAt: null },
];

const options = (patch: Partial<StateViewOptions> = {}): StateViewOptions => ({
  layout: "list",
  item: null,
  limit: 8,
  showChanged: true,
  ...patch,
});

const render = (
  input: {
    options?: Partial<StateViewOptions>;
    items?: StateItemView[];
    total?: number;
    placement?: { x: number; y: number; w: number; h: number };
    fontScale?: number;
    counts?: ServiceStateCounts;
    status?: "ok" | "no_data" | "stale";
  } = {},
  locale: "en" | "de" = "en",
) => {
  const items = input.items ?? ITEMS;
  return renderI18n(
    <StateWidgetView
      label="Services"
      items={items}
      total={input.total ?? items.length}
      counts={input.counts ?? serviceStateCounts(items)}
      options={options(input.options)}
      status={input.status ?? (items.length ? "ok" : "no_data")}
      placement={input.placement ?? { x: 0, y: 0, w: 6, h: 6 }}
      showHeader
      fontScale={input.fontScale ?? 1}
      audience="viewer"
    />,
    locale,
  );
};

const rows = (html: string) =>
  [
    ...html.matchAll(
      /<li class="sw-status-row sw-svc-row ([a-z]+)"[^>]*data-state="([a-z]+)"[^>]*aria-label="([^"]*)"/g,
    ),
  ].map((match) => ({ tone: match[1], state: match[2], label: match[3] }));

describe("the state list (#875)", () => {
  it("draws every item with its word, its icon and its tone", () => {
    const html = render();
    expect(rows(html)).toEqual([
      { tone: "down", state: "failed", label: "api: Failed" },
      { tone: "down", state: "down", label: "db: Down" },
      { tone: "muted", state: "building", label: "worker: Building" },
      { tone: "warning", state: "up", label: "site: Up · rolled back" },
      { tone: "up", state: "up", label: "web: Up" },
    ]);
    // Failed and down share a colour, never a word or a shape.
    expect(html).toContain('data-icon="exclamation"');
    expect(html).toContain('data-icon="cross"');
    expect(html).toContain('data-icon="arrows"');
    expect(html).toContain('data-icon="check"');
    expect(html).toContain(">Up · rolled back<");
    // The changed time as an age, where the binding names one.
    expect(html).toMatch(/sw-status-age[^>]*>3 h</);
  });

  it("leaves the age out when asked", () => {
    expect(render({ options: { showChanged: false } })).not.toContain(
      "sw-status-age",
    );
  });

  it("speaks German", () => {
    const html = render({}, "de");
    expect(rows(html).map((row) => row.label)).toEqual([
      "api: Fehlgeschlagen",
      "db: Offline",
      "worker: Wird gebaut",
      "site: Online · zurückgesetzt",
      "web: Online",
    ]);
  });

  it("turns the last row into +N more, counting items beyond the limit", () => {
    // A 3 × 2 widget fits two rows: one item and "+N more".
    const small = render({ placement: { x: 0, y: 0, w: 3, h: 2 } });
    expect(rows(small)).toHaveLength(1);
    expect(small).toContain(">+4 more<");
    // Everything fits, but the server left two items out.
    const cut = render({ total: 7 });
    expect(rows(cut)).toHaveLength(5);
    expect(cut).toContain(">+2 more<");
    expect(render({ total: 7 }, "de")).toContain(">+2 weitere<");
  });

  it("says when there is nothing to show", () => {
    expect(render({ items: [] })).toContain("No items yet");
  });
});

describe("the single form (#875)", () => {
  it("shows one item's state large, with the rollback and the change", () => {
    const html = render({
      options: { layout: "single", item: "site" },
      items: [ITEMS[3]!],
    });
    expect(html).toContain('class="sw sw-svc sw-svc--single warning"');
    expect(html).toContain('aria-label="site: Up · rolled back"');
    expect(html).toMatch(
      /sw-svc-word[^>]*>.*data-icon="check".*<span>Up<\/span>/,
    );
    expect(html).toContain("Rolled back · Changed 2 days ago");
    const de = renderI18n(
      <StateWidgetView
        label="Status"
        items={[ITEMS[0]!]}
        total={1}
        counts={serviceStateCounts([ITEMS[0]!])}
        options={options({ layout: "single", item: "api" })}
        status="ok"
        placement={{ x: 0, y: 0, w: 3, h: 2 }}
        showHeader
        fontScale={1.3}
        audience="viewer"
      />,
      "de",
    );
    expect(de).toContain("<span>Fehlgeschlagen</span>");
    expect(de).toContain("Geändert vor 3 Std.");
  });

  it("gives every state its own icon", () => {
    const icons = SERVICE_STATES.map((state) => {
      const html = render({
        options: { layout: "single", item: "x" },
        items: [{ name: "x", state, rolledBack: false, changedAt: null }],
      });
      return /data-icon="([a-z]+)"/.exec(html)![1];
    });
    expect(new Set(icons).size).toBe(SERVICE_STATES.length);
  });
});

describe("review fixes (#875)", () => {
  const summary = (html: string) =>
    /class="sw-svc-word"[^>]*>.*?<span>([^<]*)<\/span>/.exec(html)?.[1];

  it("sums up the items when no item is chosen", () => {
    const single = { options: { layout: "single" as const } };
    expect(summary(render(single))).toBe("1 of 5 down");
    expect(summary(render(single, "de"))).toBe("1 von 5 offline");
    const ups = ITEMS.filter((item) => item.state === "up" && !item.rolledBack);
    const allUp = [
      ...ups,
      { ...ups[0]!, name: "b" },
      { ...ups[0]!, name: "c" },
    ];
    expect(summary(render({ ...single, items: allUp }))).toBe("All 3 up");
    expect(summary(render({ ...single, items: allUp }, "de"))).toBe(
      "Alle 3 online",
    );
    const html = render({ ...single, items: allUp });
    expect(html).toContain('data-icon="check"');
    expect(html).toContain('class="sw sw-svc sw-svc--single up"');
  });

  it("shows +N more, not 'No items yet', when only that row fits", () => {
    const html = render({
      placement: { x: 0, y: 0, w: 3, h: 2 },
      fontScale: 1.3,
    });
    expect(html).not.toContain("No items yet");
    expect(html).toMatch(/>\+\d+ more</);
  });

  it("tones +N more by a hidden outage the server left out", () => {
    const shown = ITEMS.filter((item) => item.state === "up");
    const counts = { ...serviceStateCounts(shown), down: 1 };
    const html = render({ items: shown, total: 3, counts });
    expect(html).toMatch(/sw-status-more down"/);
  });

  it("warns when the states are not current", () => {
    const html = render({ status: "stale" });
    expect(html).toContain("sw-stale");
    expect(html).toContain("Last known state, may be out of date");
    expect(render({ status: "stale" }, "de")).toContain(
      "Letzter bekannter Status, evtl. veraltet",
    );
  });
});

describe("a failed refresh (final review)", () => {
  it("keeps a wall screen's last states, marked stale", () => {
    const widget = {
      id: "00000000-0000-4000-8000-000000000001",
      binding: {
        modelId: "00000000-0000-4000-8000-000000000002",
        nameDimensionId: "n",
        stateDimensionId: "s",
        exclusions: [],
      },
    };
    const last = {
      widgetId: widget.id,
      status: "ok" as const,
      items: ITEMS.map((item) => ({ ...item, value: null })),
      total: 5,
      counts: serviceStateCounts(ITEMS),
      sourceValues: [],
      error: null,
      exclusions: [],
    };
    const kept = failedStates([widget], new Map([[widget.id, last]]), true);
    expect(kept.get(widget.id)).toMatchObject({
      status: "stale",
      items: ITEMS,
    });
    const editor = failedStates([widget], new Map([[widget.id, last]]), false);
    expect(editor.get(widget.id)).toMatchObject({
      status: "no_data",
      error: "data_storage_failed",
    });
  });
});

describe("a payload state widget (#875)", () => {
  it("draws on a paired screen as on the canvas", () => {
    const widget: DeviceWidget = {
      type: "state",
      id: "00000000-0000-4000-8000-000000000875",
      x: 0,
      y: 0,
      w: 6,
      h: 6,
      label: "Services",
      options: { layout: "list", item: null, limit: 8, showChanged: true },
      data: {
        status: "ok",
        items: ITEMS,
        total: 5,
        counts: serviceStateCounts(ITEMS),
      },
    } as DeviceWidget;
    const html = renderI18n(
      <DeviceWidgetView
        widget={
          widget as DeviceWidget & {
            x: number;
            y: number;
            w: number;
            h: number;
          }
        }
        env={{
          timeZone: "UTC",
          fontScale: 1,
          showHeader: true,
          images: new Map(),
        }}
      />,
    );
    expect(rows(html).map((row) => row.label)).toEqual(
      rows(render()).map((row) => row.label),
    );
  });
});
