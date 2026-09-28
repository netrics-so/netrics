import type { FastifyBaseLogger } from "fastify";

import type { DashboardTileInput } from "@netrics/contracts";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Database } from "@netrics/database";

import { createConnectionService, type Actor } from "./connections/service.js";
import type { CredentialKeyring } from "./credentials.js";
import { createDashboardService } from "./dashboards/service.js";

/**
 * Onboarding (#51): a new workspace can start with the demo connection and a
 * dashboard built from it, so the first dashboard is useful before any real
 * source is connected. Uses the same services as the UI, so every rule
 * (credential check, tile validation, audit) applies unchanged. The demo
 * connection's backfill is queued with it; tiles fill in once the worker
 * has run.
 */

const DEMO_CONNECTOR_ID = "demo";

function demoTiles(connectionId: string): DashboardTileInput[] {
  const tile = (
    metricKey: string,
    period: DashboardTileInput["period"],
    title: string,
    aggregation?: DashboardTileInput["aggregation"],
  ): DashboardTileInput => ({
    connectionId,
    metricKey,
    period,
    title,
    ...(aggregation ? { aggregation } : {}),
  });
  return [
    tile("demo.signups", "today", "Signups today"),
    tile("demo.signups", "last_7_days", "Signups, last 7 days"),
    tile("demo.signups", "this_month", "Signups this month"),
    tile("demo.visitors", "today", "Visitors today", "last"),
    tile("demo.visitors", "last_7_days", "Average visitors", "avg"),
    tile("demo.visitors", "last_30_days", "Peak visitors, 30 days", "max"),
  ];
}

export interface OnboardingDeps {
  db: Database;
  registry: ConnectorRegistry;
  credentialKeyring: CredentialKeyring;
  logger: FastifyBaseLogger;
}

/** Returns the demo dashboard's id, or null when it could not be added. */
export type AddDemoContent = (actor: Actor) => Promise<string | null>;

export function createOnboarding(deps: OnboardingDeps): AddDemoContent {
  const connections = createConnectionService(deps);
  const dashboards = createDashboardService(deps);
  const logger = deps.logger.child({ module: "onboarding" });

  return async (actor) => {
    if (!deps.registry.get(DEMO_CONNECTOR_ID)) {
      return null;
    }
    const connection = await connections.create(actor, {
      connectorId: DEMO_CONNECTOR_ID,
      name: "Demo data",
      config: {},
    });
    if (!connection.ok) {
      logger.error(
        { workspaceId: actor.workspaceId, error: connection.error },
        "could not add the demo connection",
      );
      return null;
    }
    const dashboard = await dashboards.create(actor, {
      name: "Demo dashboard",
      tiles: demoTiles(connection.value.id),
    });
    if (!dashboard.ok) {
      logger.error(
        { workspaceId: actor.workspaceId, error: dashboard.error },
        "could not add the demo dashboard",
      );
      return null;
    }
    return dashboard.value.id;
  };
}
