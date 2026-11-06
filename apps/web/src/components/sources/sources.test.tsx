import { describe, expect, it, vi } from "vitest";

import type { Connection, ConnectorCatalogEntry } from "@netrics/contracts";

import { ConnectedStrip } from "./connected-strip";
import { ConnectorCatalogue, CUSTOM_API_PLAN_URL } from "./connector-catalogue";
import { renderI18n } from "@/lib/i18n/test-render";
import { connectorStandings } from "@/lib/sources";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const NOW = Date.parse("2026-10-04T12:00:00Z");

function entry(
  overrides: Partial<ConnectorCatalogEntry> & { id: string },
): ConnectorCatalogEntry {
  return {
    name: overrides.id,
    version: "1.0.0",
    description: `About ${overrides.id}.`,
    metricsCount: 1,
    category: "other",
    brandColor: null,
    metrics: [],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: false,
    configSchema: { type: "object", properties: {} },
    authStrategies: [{ strategy: "none" }],
    available: true,
    unavailable: null,
    ...overrides,
  };
}

const CONNECTORS = [
  entry({
    id: "google-search-console",
    name: "Google Search Console",
    category: "seo",
    brandColor: "#4285f4",
    authStrategies: [{ strategy: "oauth2", provider: "google", scopes: ["s"] }],
    metrics: [
      { key: "gsc.clicks", name: "Clicks" },
      { key: "gsc.impressions", name: "Impressions" },
      { key: "gsc.ctr", name: "CTR" },
      { key: "gsc.position", name: "Average position" },
      { key: "gsc.queries", name: "Queries" },
    ],
  }),
  entry({
    id: "vercel",
    name: "Vercel Web Analytics",
    category: "web",
    brandColor: "#000000",
    authStrategies: [{ strategy: "token" }],
    minRefreshIntervalSeconds: 3600,
  }),
  entry({
    id: "app-store-connect",
    name: "App Store Connect",
    category: "apps",
    authStrategies: [{ strategy: "signed-key", provider: "app-store-connect" }],
  }),
];

function connection(
  id: string,
  connectorId: string,
  name: string,
  health: Connection["state"]["health"],
  extra: Partial<Connection> = {},
): Connection {
  return {
    id,
    name,
    connectorId,
    connectorName: name,
    connectorVersion: "1.0.0",
    projectId: null,
    hasCredentials: true,
    oauth: null,
    setupPending: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    state: {
      health,
      authState: health === "pending" ? "ok" : health,
      authReason: null,
      lastSuccessAt: health === "ok" ? "2026-10-04T11:51:00Z" : null,
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 300,
    },
    ...extra,
  };
}

const CONNECTIONS = [
  connection("c1", "vercel", "Marketing site", "ok"),
  connection("c2", "app-store-connect", "App Store Connect", "auth_failed"),
  connection("c3", "google-search-console", "Search Console", "pending", {
    setupPending: true,
  }),
];

describe("ConnectedStrip", () => {
  const html = renderI18n(
    <ConnectedStrip
      workspaceId="w"
      connections={CONNECTIONS}
      connectors={CONNECTORS}
      now={NOW}
    />,
  );

  it("shows each connection with its last sync and links to it", () => {
    expect(html).toContain('href="/workspaces/w/connections/c1"');
    expect(html).toContain("Marketing site");
    expect(html).toContain("Synced 9 minutes ago");
    expect(html).toContain('class="dot up"');
  });

  it("washes connections that need attention and says what to do", () => {
    expect(html.match(/source-chip--attention/g)).toHaveLength(2);
    expect(html).toContain("Key rejected · Fix key");
    expect(html).toContain("Setup unfinished · Finish setup");
    expect(html).toContain('href="/workspaces/w/connections/c3#finish-setup"');
  });

  it("draws icon tiles from the brand colour, no bitmaps", () => {
    expect(html).toContain("background:#000000");
    expect(html).not.toContain("<img");
  });

  it("speaks German", () => {
    const de = renderI18n(
      <ConnectedStrip
        workspaceId="w"
        connections={CONNECTIONS}
        connectors={CONNECTORS}
        now={NOW}
      />,
      "de",
    );
    expect(de).toContain("Synchronisiert vor 9 Minuten");
    expect(de).toContain("Schlüssel abgelehnt · Schlüssel ersetzen");
  });
});

describe("ConnectorCatalogue", () => {
  const standings = connectorStandings(CONNECTIONS.slice(0, 2));

  function render(
    props: Partial<Parameters<typeof ConnectorCatalogue>[0]> = {},
  ) {
    return renderI18n(
      <ConnectorCatalogue
        workspaceId="w"
        connectors={CONNECTORS}
        standings={standings}
        mode={{ kind: "links", canCreate: true }}
        {...props}
      />,
    );
  }

  it("lists category pills for the categories present", () => {
    const html = render();
    expect(html).toContain('aria-pressed="true">All</button>');
    expect(html).toContain(">SEO</button>");
    expect(html).toContain(">Web</button>");
    expect(html).toContain(">Apps</button>");
    expect(html).not.toContain(">Revenue</button>");
  });

  it("offers Connect, Add another and Fix by how the connector stands", () => {
    const html = render();
    expect(html).toContain(
      'href="/workspaces/w/connections/new?connector=google-search-console"',
    );
    expect(html).toMatch(/class="catalogue-cta primary"[^>]*>Connect</);
    expect(html).toMatch(/aria-label="Add another Vercel Web Analytics/);
    expect(html).toContain('href="/workspaces/w/connections/c2"');
    expect(html).toMatch(/catalogue-cta--fix[^>]*>Fix</);
  });

  it("shows metric chips, auth and refresh", () => {
    const html = render();
    expect(html).toContain("<li>Clicks</li>");
    expect(html).toContain("<li>+1</li>");
    expect(html).toContain("Google sign-in");
    expect(html).toContain("every 5 min");
    expect(html).toContain("hourly");
    expect(html).toContain("API key");
  });

  it("filters by category but always shows the custom API plan", () => {
    const html = render({ initialFilter: "seo" });
    expect(html).toContain("Google Search Console");
    expect(html).not.toContain("Vercel Web Analytics");
    expect(html).toContain("Custom API");
    expect(html).toContain(`href="${CUSTOM_API_PLAN_URL}"`);
    expect(html).toContain('aria-disabled="true">Coming later');
  });

  it("offers no create actions to roles that cannot create", () => {
    const html = render({ mode: { kind: "links", canCreate: false } });
    expect(html).not.toContain("connections/new");
    // Fixing a connection stays available: its page says what the role may do.
    expect(html).toContain('href="/workspaces/w/connections/c2"');
  });

  it("picks a connector in place in the wizard", () => {
    const html = render({
      mode: { kind: "pick", selectedId: "vercel", onPick: () => {} },
    });
    expect(html).not.toContain("connections/new");
    expect(html).toContain("catalogue-card catalogue-card--selected");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Selected</);
  });
});
