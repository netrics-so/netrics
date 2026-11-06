import type {
  Connection,
  ConnectorCatalogEntry,
  ConnectorCategory,
} from "@netrics/contracts";

import { sourcesNeedingAttention } from "./app-nav";

/**
 * The Sources page and connector catalogue (ADR 0018, design 3c, #306):
 * which connections need someone to act and what they should do, the
 * catalogue's categories and call to action, and the connector icon tile.
 */

/** Categories in the order the filter lists them. */
export const CATEGORY_ORDER: readonly ConnectorCategory[] = [
  "seo",
  "web",
  "apps",
  "ads",
  "revenue",
  "other",
];

/** The categories the catalogue has connectors for, in filter order. */
export function presentCategories(
  connectors: readonly Pick<ConnectorCatalogEntry, "category">[],
): ConnectorCategory[] {
  const present = new Set(connectors.map((connector) => connector.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

type AttentionInput = Pick<Connection, "setupPending" | "state">;

/** Whether a connection needs attention, by the shell's definition. */
export function needsAttention(connection: AttentionInput): boolean {
  return sourcesNeedingAttention([connection]) > 0;
}

/** What is wrong with a connection that needs attention. */
export type SourceProblem =
  | "setupPending"
  | "needsReconnect"
  | "authFailed"
  | "keyRejected"
  | "tokenRejected"
  | "outage";

/** The short action that fixes it. */
export type SourceAction =
  "finishSetup" | "reconnect" | "fixKey" | "fixToken" | "view";

export interface SourceAttention {
  problem: SourceProblem;
  action: SourceAction;
  /** Where the action happens, relative to the connection's page. */
  anchor: string;
}

/**
 * Why a connection needs attention and the short action that fixes it, or
 * null when it does not. Failed credentials say "key" or "token" by the
 * connector's auth strategy; an OAuth connection reconnects instead.
 */
export function sourceAttention(
  connection: AttentionInput & Pick<Connection, "oauth">,
  connector?: Pick<ConnectorCatalogEntry, "authStrategies">,
): SourceAttention | null {
  if (!needsAttention(connection)) {
    return null;
  }
  if (connection.setupPending) {
    return {
      problem: "setupPending",
      action: "finishSetup",
      anchor: "#finish-setup",
    };
  }
  switch (connection.state.health) {
    case "needs_reauthorization":
      return { problem: "needsReconnect", action: "reconnect", anchor: "" };
    case "auth_failed": {
      if (connection.oauth !== null) {
        return { problem: "authFailed", action: "reconnect", anchor: "" };
      }
      const strategies = connector?.authStrategies ?? [];
      if (strategies.some((strategy) => strategy.strategy === "signed-key")) {
        return { problem: "keyRejected", action: "fixKey", anchor: "" };
      }
      if (strategies.some((strategy) => strategy.strategy === "token")) {
        return { problem: "tokenRejected", action: "fixToken", anchor: "" };
      }
      return { problem: "authFailed", action: "view", anchor: "" };
    }
    default:
      return { problem: "outage", action: "view", anchor: "" };
  }
}

/** How a connector stands in this workspace, for its catalogue card. */
export interface ConnectorStanding {
  /** How many connections use it. */
  connections: number;
  /** The first of them that needs attention, if any. */
  attentionId: string | null;
}

export function connectorStandings(
  connections: readonly (AttentionInput &
    Pick<Connection, "id" | "connectorId">)[],
): Record<string, ConnectorStanding> {
  const standings: Record<string, ConnectorStanding> = {};
  for (const connection of connections) {
    const standing = (standings[connection.connectorId] ??= {
      connections: 0,
      attentionId: null,
    });
    standing.connections += 1;
    if (standing.attentionId === null && needsAttention(connection)) {
      standing.attentionId = connection.id;
    }
  }
  return standings;
}

/** The catalogue card's call to action. */
export type CatalogueCta = "connect" | "addAnother" | "fix";

export function catalogueCta(
  standing: ConnectorStanding | undefined,
): CatalogueCta {
  if (!standing || standing.connections === 0) {
    return "connect";
  }
  return standing.attentionId !== null ? "fix" : "addAnother";
}

/** How the connector signs in, for the card's footer. */
export function primaryAuthStrategy(
  connector: Pick<ConnectorCatalogEntry, "authStrategies">,
): ConnectorCatalogEntry["authStrategies"][number] | null {
  return connector.authStrategies[0] ?? null;
}

/** A refresh interval as a count of its largest whole unit. */
export function refreshInterval(seconds: number): {
  unit: "minutes" | "hours" | "days";
  count: number;
} {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    return { unit: "days", count: seconds / 86_400 };
  }
  if (seconds >= 3_600 && seconds % 3_600 === 0) {
    return { unit: "hours", count: seconds / 3_600 };
  }
  return { unit: "minutes", count: Math.max(1, Math.round(seconds / 60)) };
}

/** Up to two initials of a name: "Google Search Console" → "GS". */
export function connectorInitials(name: string): string {
  const words = name
    .split(/[\s\-–—_/]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "");
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0]!.charAt(0).toUpperCase();
  }
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/**
 * The icon tile's colours: the brand colour behind white initials, or
 * near-black ones on light colours where white falls below the 3:1 WCAG
 * contrast for large bold text; a neutral chip tile without a brand colour.
 */
export function iconTileStyle(brandColor: string | null): {
  background: string;
  color: string;
} {
  const match = brandColor ? /^#([0-9a-f]{6})$/i.exec(brandColor) : null;
  if (!match) {
    return { background: "var(--chip)", color: "var(--text-2)" };
  }
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  const withWhite = 1.05 / (luminance + 0.05);
  return {
    background: brandColor!,
    color: withWhite >= 3 ? "#ffffff" : "var(--text)",
  };
}

/** The catalogue's connectors under a category filter ("all" keeps every one). */
export function filterCatalogue<
  T extends Pick<ConnectorCatalogEntry, "category">,
>(connectors: readonly T[], filter: ConnectorCategory | "all"): readonly T[] {
  return filter === "all"
    ? connectors
    : connectors.filter((connector) => connector.category === filter);
}
