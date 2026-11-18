import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectionFreshnessStream,
  ConnectionRetention,
  ConnectorCatalogEntry,
  DashboardWidgetData,
  Device,
  WidgetFreshness,
} from "@netrics/contracts";
import type { DashboardDataFilter } from "@netrics/domain";

import { RenderedAt } from "@/app/(site)/status/rendered-at";
import { ConnectionFreshness } from "@/app/workspaces/[workspaceId]/connections/[connectionId]/connection-freshness";
import { RetentionSettings } from "@/app/workspaces/[workspaceId]/connections/[connectionId]/retention-settings";
import { SignedKeyFields } from "@/app/workspaces/[workspaceId]/connections/signed-key-fields";
import {
  ScreensView,
  type ScreenItem,
} from "@/app/workspaces/[workspaceId]/screens/screens-view";
import { PublicationTime } from "@/components/data/definition-history";
import { ScrollStatusCard } from "@/components/scroll/scroll-widgets";
import { MeasureWidgetView } from "@/components/studio/measure-widget";
import { MetricWidgetView } from "@/components/studio/metric-widget";
import { DashboardFilters } from "@/components/studio/shared-filters";
import { StatusWidgetView } from "@/components/studio/status-widget";
import { analyticsStatusLabel } from "@/lib/app-store-analytics";
import { inMachineZone, renderI18n } from "@/lib/i18n/test-render";
import { screenPreview } from "@/lib/screens";
import { signedKeyStrategyOf } from "@/lib/signed-key";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// #749, ADR 0025 §8: every date and time a viewer reads is in the viewer's
// zone (`useViewerTimeZone`: UTC through hydration, then the browser's),
// never the zone of the machine that renders it. Each instant below falls
// on different days in Auckland and Los Angeles, so a component that
// formats in the machine's zone fails one of the two whatever the
// machine's zone is.

const AUCKLAND = "Pacific/Auckland";
const LOS_ANGELES = "America/Los_Angeles";

/** 12:30 UTC on Nov 16: Nov 17, 1:30 AM in Auckland; Nov 16, 4:30 AM in LA. */
const INSTANT = "2026-11-16T12:30:00.000Z";
/** The viewer's "now": 11:30 PM in Auckland, 2:30 AM in Los Angeles. */
const NOW = Date.parse("2026-11-16T10:30:00Z");
const TEN_MIN_AGO = "2026-11-16T10:20:00Z";
/** An hour after NOW: tomorrow 12:30 AM in Auckland, 3:30 AM in LA. */
const NEXT = "2026-11-16T11:30:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The markup's text, spaces plain (`\s` covers Intl's narrow spaces). */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/**
 * Renders `ui` for a viewer in `zone`, and checks that the server markup
 * does not depend on the machine's zone: the server (here in Auckland) and
 * the browser's first render (in Los Angeles) both render the initial zone
 * until hydration, so they must agree (no hydration mismatch).
 */
function viewIn(ui: () => ReactElement, zone: string): string {
  const server = inMachineZone(AUCKLAND, () => renderI18n(ui()));
  const hydration = inMachineZone(LOS_ANGELES, () => renderI18n(ui()));
  expect(hydration).toBe(server);
  return text(renderI18n(ui(), "en", zone));
}

/** Both viewers' text: Auckland's, then Los Angeles'. */
const both = (ui: () => ReactElement) =>
  [viewIn(ui, AUCKLAND), viewIn(ui, LOS_ANGELES)] as const;

describe("screens page: the paired date", () => {
  const device: Device = {
    id: "d1",
    name: "Lobby",
    dashboardId: null,
    rotation: 0,
    displayMode: "screen",
    screen: null,
    platform: null,
    createdAt: INSTANT,
    lastSeenAt: INSTANT,
    revokedAt: null,
    heartbeat: null,
    scope: null,
  };
  const item: ScreenItem = {
    device,
    online: true,
    lastSeen: "2 minutes ago",
    revoked: null,
    dashboardName: null,
    preview: screenPreview(null),
    appleTv: false,
    platform: null,
    handheld: false,
    heartbeat: null,
    screenLine: null,
    scopeLine: null,
    filters: [],
  };
  it("is the viewer's day", () => {
    const [auckland, losAngeles] = both(() => (
      <ScreensView
        workspaceId="w"
        screens={[item]}
        counts={{ total: 1, online: 1, revoked: 0 }}
        dashboards={[]}
        canManage
        initialSelected="d1"
      />
    ));
    expect(auckland).toContain("Paired Nov 17, 2026");
    expect(losAngeles).toContain("Paired Nov 16, 2026");
  });
});

describe("signed key: the generated pair's expiry", () => {
  const strategy = signedKeyStrategyOf({
    id: "apple-ads",
    name: "Apple Ads",
    version: "0.1.0",
    description: "Spend.",
    metricsCount: 1,
    category: "ads",
    brandColor: "#0d84ff",
    metrics: [],
    minRefreshIntervalSeconds: 21600,
    supportsBackfill: true,
    configSchema: { type: "object", properties: {} },
    authStrategies: [
      {
        strategy: "signed-key",
        provider: "apple-ads",
        providerName: "Apple Ads",
        generatedKeyPair: true,
        fields: [
          {
            key: "privateKey",
            label: "Private key",
            description: "PEM.",
            input: "file",
            secret: true,
            maxBytes: 4096,
          },
        ],
        setup: { steps: ["One."], url: "https://ads.apple.com/" },
      },
    ],
    available: true,
    unavailable: null,
  } as ConnectorCatalogEntry)!;
  it("is the viewer's date and time", () => {
    const [auckland, losAngeles] = both(() => (
      <SignedKeyFields
        strategy={strategy}
        values={{}}
        onChange={() => {}}
        keyPair={{
          workspaceId: "w",
          value: {
            pendingKeyId: "00000000-0000-4000-8000-000000000001",
            publicKey: "-----BEGIN PUBLIC KEY-----",
            expiresAt: INSTANT,
          },
          onChange: () => {},
        }}
      />
    ));
    expect(auckland).toContain("Nov 17, 2026, 1:30 AM");
    expect(losAngeles).toContain("Nov 16, 2026, 4:30 AM");
  });
});

describe("connection retention: the day it was chosen", () => {
  const retention: ConnectionRetention = {
    datasets: [],
    workspaceMaxDays: null,
    basis: "chosen",
    chosenAt: INSTANT,
    chosenBy: null,
  };
  it("is the viewer's day", () => {
    const [auckland, losAngeles] = both(() => (
      <RetentionSettings
        workspaceId="w"
        connectionId="c"
        retention={retention}
        canUpdate
      />
    ));
    expect(auckland).toContain("Chosen on Nov 17, 2026.");
    expect(losAngeles).toContain("Chosen on Nov 16, 2026.");
  });
});

describe("definition history: a version's publication time", () => {
  it("is the viewer's date and time", () => {
    const [auckland, losAngeles] = both(() => <PublicationTime at={INSTANT} />);
    expect(auckland).toContain("11/17/2026, 1:30:00 AM");
    expect(losAngeles).toContain("11/16/2026, 4:30:00 AM");
  });
});

describe("status page: when it was checked", () => {
  it("is the viewer's date and time", () => {
    const [auckland, losAngeles] = both(() => <RenderedAt at={INSTANT} />);
    expect(auckland).toContain("Checked at Nov 17, 2026, 1:30:00 AM");
    expect(losAngeles).toContain("Checked at Nov 16, 2026, 4:30:00 AM");
  });
});

describe("measure widget", () => {
  const freshness: WidgetFreshness = {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: TEN_MIN_AGO,
    // A covered day: the provider's, the same for every viewer.
    dataThrough: "2026-11-15",
    nextExpectedAt: NEXT,
  };
  const data = {
    widgetId: "00000000-0000-4000-8000-000000000001",
    status: "ok",
    error: null,
    exclusions: [],
    freshness,
    metadata: {
      modelId: "00000000-0000-4000-8000-000000000002",
      modelName: "Orders",
      measures: [
        { id: "count", name: "Orders" },
        { id: "last", name: "Last order" },
      ],
      dimensions: [],
    },
    result: {
      releaseId: null,
      receivedAt: INSTANT,
      rows: [
        {
          dimensions: {},
          measures: {
            count: { value: 3, type: "integer", status: "ok" },
            last: { value: INSTANT, type: "timestamp", status: "ok" },
          },
        },
      ],
      warnings: [],
      operations: 1,
      provenance: [],
      appliedFilter: null,
      groupBy: [],
    },
  } as unknown as DashboardWidgetData;
  const view = (withFreshness = true) => (
    <MeasureWidgetView
      widget={{
        title: null,
        options: { view: "table", limit: 20 },
        binding: { measureIds: ["count", "last"], groupBy: [] },
      }}
      data={withFreshness ? data : { ...data, freshness: undefined }}
    />
  );

  it("shows times in the viewer's zone, the covered day as it is", () => {
    const [auckland, losAngeles] = both(view);
    // A timestamp value; the freshness line replaces the oldest source
    // refresh (#769).
    expect(auckland).toContain("Nov 17, 2026, 1:30 AM");
    expect(losAngeles).toContain("Nov 16, 2026, 4:30 AM");
    expect(auckland).not.toContain("Oldest source refresh");
    // The next expected data: tomorrow just after midnight in Auckland.
    expect(auckland).toMatch(/Up to Nov 15 · .*tomorrow ~12:30 AM/);
    expect(losAngeles).toMatch(/Up to Nov 15 · .*~3:30 AM/);
    expect(losAngeles).not.toContain("tomorrow");
  });

  it("shows the oldest source refresh in the viewer's zone without freshness", () => {
    const [auckland, losAngeles] = both(() => view(false));
    expect(auckland).toContain("Oldest source refresh: Nov 17, 2026, 1:30 AM");
    expect(losAngeles).toContain(
      "Oldest source refresh: Nov 16, 2026, 4:30 AM",
    );
  });
});

describe("dashboard filters: a timestamp value", () => {
  const filter: DashboardDataFilter = {
    id: "at",
    name: "Ordered",
    type: "timestamp",
    mode: "range",
    mappings: [],
    defaultValue: null,
  };
  it("is the viewer's date and time", () => {
    const [auckland, losAngeles] = both(() => (
      <DashboardFilters
        filters={[filter]}
        values={{ at: { kind: "range", from: INSTANT, to: null } }}
        onChange={() => {}}
      />
    ));
    expect(auckland).toContain("Nov 17, 2026, 1:30 AM – …");
    expect(losAngeles).toContain("Nov 16, 2026, 4:30 AM – …");
  });
});

describe("App Store analytics status: a reporting day", () => {
  it("is Apple's day, never converted, whatever the zone", () => {
    for (const zone of [AUCKLAND, LOS_ANGELES])
      expect(
        inMachineZone(zone, () =>
          analyticsStatusLabel("available", "2026-11-15", "en"),
        ),
      ).toContain("Nov 15, 2026");
  });
});

describe("freshness lines: the next expected time", () => {
  const sales: WidgetFreshness = {
    kind: "periodic",
    stream: "Sales",
    fetchedAt: TEN_MIN_AGO,
    dataThrough: "2026-11-15",
    nextExpectedAt: NEXT,
  };
  const expectNext = (auckland: string, losAngeles: string) => {
    expect(auckland).toContain("Nov 15");
    expect(auckland).toContain("tomorrow ~12:30 AM");
    expect(losAngeles).toContain("Nov 15");
    expect(losAngeles).toContain("~3:30 AM");
    expect(losAngeles).not.toContain("tomorrow");
  };

  it("in a widget footer", () => {
    const [auckland, losAngeles] = both(() => (
      <MetricWidgetView
        label="Proceeds"
        period="last_7_days"
        aggregation="sum"
        metric={{ kind: "counter", granularity: "day", better: "higher" }}
        reading={{
          value: 1248,
          unit: "count",
          delta: 120,
          ratio: 0.106,
          series: [{ value: 1 }, { value: 2 }],
          timeZone: "UTC",
        }}
        notice={null}
        source="App Store Connect"
        updatedAt={TEN_MIN_AGO}
        freshness={sales}
        placement={{ x: 0, y: 0, w: 8, h: 4 }}
        showHeader
        fontScale={1}
        options={{ showSparkline: false, showChange: true }}
      />
    ));
    expectNext(auckland, losAngeles);
  });

  const board = {
    label: "Sources",
    options: { showAge: true },
    items: [
      {
        connectionId: "c1",
        name: "App Store Connect",
        status: "ok" as const,
        lastSuccessAt: TEN_MIN_AGO,
      },
    ],
    streams: { c1: [{ freshness: sales, overdue: false }] },
    placement: { x: 0, y: 0, w: 8, h: 6 },
    showHeader: true,
    fontScale: 1,
  };

  it("on the status board", () => {
    const [auckland, losAngeles] = both(() => <StatusWidgetView {...board} />);
    expectNext(auckland, losAngeles);
  });

  it("on the scroll view's status card", () => {
    const [auckland, losAngeles] = both(() => (
      <ScrollStatusCard {...board} width={600} rootPx={16} />
    ));
    expectNext(auckland, losAngeles);
  });

  it("on the connection page", () => {
    const streams: ConnectionFreshnessStream[] = [
      {
        key: "sales",
        name: "Sales",
        kind: "periodic",
        period: "day",
        entries: [
          {
            resource: null,
            dataThrough: "2026-11-15",
            nextExpectedAt: NEXT,
            checkedAt: TEN_MIN_AGO,
            advancedAt: TEN_MIN_AGO,
            late: false,
            overdue: false,
          },
        ],
      },
    ];
    const [auckland, losAngeles] = both(() => (
      <ConnectionFreshness
        streams={streams}
        nextCheckAt={null}
        resourceNames={{}}
        authState="ok"
      />
    ));
    expectNext(auckland, losAngeles);
  });
});
