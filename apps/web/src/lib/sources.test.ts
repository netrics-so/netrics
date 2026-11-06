import { describe, expect, it } from "vitest";

import type { Connection, ConnectorCatalogEntry } from "@netrics/contracts";

import {
  catalogueCta,
  connectorInitials,
  connectorStandings,
  filterCatalogue,
  iconTileStyle,
  needsAttention,
  presentCategories,
  refreshInterval,
  sourceAttention,
} from "./sources";

type Health = Connection["state"]["health"];

function connection(
  overrides: {
    id?: string;
    connectorId?: string;
    health?: Health;
    setupPending?: boolean;
    oauth?: Connection["oauth"];
  } = {},
): Pick<Connection, "id" | "connectorId" | "setupPending" | "oauth" | "state"> {
  const health = overrides.health ?? "ok";
  return {
    id: overrides.id ?? "c1",
    connectorId: overrides.connectorId ?? "demo",
    setupPending: overrides.setupPending ?? false,
    oauth: overrides.oauth ?? null,
    state: {
      health,
      authState: health === "pending" ? "ok" : health,
      authReason: null,
      lastSuccessAt: null,
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 300,
    },
  };
}

const OAUTH = { provider: "google", accountEmail: null, grantedScopes: [] };
const KEY = {
  authStrategies: [{ strategy: "signed-key" as const, provider: "asc" }],
};
const TOKEN = { authStrategies: [{ strategy: "token" as const }] };

describe("sourceAttention", () => {
  it("leaves healthy and never-synced connections alone", () => {
    expect(sourceAttention(connection())).toBe(null);
    expect(sourceAttention(connection({ health: "pending" }))).toBe(null);
    expect(needsAttention(connection({ health: "pending" }))).toBe(false);
  });

  it("finishes an unfinished setup first", () => {
    expect(
      sourceAttention(
        connection({ setupPending: true, health: "pending", oauth: OAUTH }),
      ),
    ).toEqual({
      problem: "setupPending",
      action: "finishSetup",
      anchor: "#finish-setup",
    });
  });

  it("reconnects OAuth grants and fixes keys or tokens by strategy", () => {
    expect(
      sourceAttention(connection({ health: "needs_reauthorization" })),
    ).toMatchObject({ problem: "needsReconnect", action: "reconnect" });
    expect(
      sourceAttention(connection({ health: "auth_failed", oauth: OAUTH })),
    ).toMatchObject({ problem: "authFailed", action: "reconnect" });
    expect(
      sourceAttention(connection({ health: "auth_failed" }), KEY),
    ).toMatchObject({ problem: "keyRejected", action: "fixKey" });
    expect(
      sourceAttention(connection({ health: "auth_failed" }), TOKEN),
    ).toMatchObject({ problem: "tokenRejected", action: "fixToken" });
    expect(sourceAttention(connection({ health: "outage" }))).toMatchObject({
      problem: "outage",
      action: "view",
    });
  });
});

describe("catalogue standing", () => {
  const connections = [
    connection({ id: "a", connectorId: "vercel" }),
    connection({ id: "b", connectorId: "vercel", health: "auth_failed" }),
    connection({ id: "c", connectorId: "demo" }),
  ];
  const standings = connectorStandings(connections);

  it("offers Connect, Add another, or Fix for the connection in trouble", () => {
    expect(standings.vercel).toEqual({ connections: 2, attentionId: "b" });
    expect(catalogueCta(standings.vercel)).toBe("fix");
    expect(catalogueCta(standings.demo)).toBe("addAnother");
    expect(catalogueCta(standings["app-store-connect"])).toBe("connect");
  });
});

describe("categories", () => {
  const connectors = [
    { id: "x", category: "web" },
    { id: "y", category: "other" },
    { id: "z", category: "seo" },
  ] as Pick<ConnectorCatalogEntry, "id" | "category">[];

  it("lists present categories in filter order and filters by them", () => {
    expect(presentCategories(connectors)).toEqual(["seo", "web", "other"]);
    expect(filterCatalogue(connectors, "all")).toHaveLength(3);
    expect(filterCatalogue(connectors, "seo").map((c) => c.id)).toEqual(["z"]);
    expect(filterCatalogue(connectors, "ads")).toEqual([]);
  });
});

describe("refreshInterval", () => {
  it("counts in the largest whole unit", () => {
    expect(refreshInterval(300)).toEqual({ unit: "minutes", count: 5 });
    expect(refreshInterval(3600)).toEqual({ unit: "hours", count: 1 });
    expect(refreshInterval(5400)).toEqual({ unit: "minutes", count: 90 });
    expect(refreshInterval(86_400 * 2)).toEqual({ unit: "days", count: 2 });
    expect(refreshInterval(10)).toEqual({ unit: "minutes", count: 1 });
  });
});

describe("connector icon", () => {
  it("takes up to two initials", () => {
    expect(connectorInitials("Google Search Console")).toBe("GS");
    expect(connectorInitials("Vercel Web Analytics")).toBe("VW");
    expect(connectorInitials("Demo-Connector")).toBe("DC");
    expect(connectorInitials("vercel")).toBe("V");
    expect(connectorInitials("  ")).toBe("?");
  });

  it("picks readable initials on the brand colour, neutral without one", () => {
    expect(iconTileStyle("#000000")).toEqual({
      background: "#000000",
      color: "#ffffff",
    });
    expect(iconTileStyle("#4285f4").color).toBe("#ffffff");
    expect(iconTileStyle("#fbbc05").color).toBe("var(--text)");
    expect(iconTileStyle(null)).toEqual({
      background: "var(--chip)",
      color: "var(--text-2)",
    });
    expect(iconTileStyle("red").background).toBe("var(--chip)");
  });
});
