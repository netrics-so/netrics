import {
  createDashboardRequestSchema,
  type CreateDashboardFromTemplateRequest,
  type DashboardTemplateOptionsResponse,
} from "@netrics/contracts";
import {
  supportsResourceIcons,
  type ConnectorRegistry,
} from "@netrics/connector-runtime";
import {
  connectionHasResource,
  findConnection,
  findResourceNames,
  listConnections,
  listNamedResources,
  resourceNameKey,
  withWorkspace,
  type Database,
} from "@netrics/database";

import { DEFAULT_LOCALE, type Locale } from "@netrics/domain";

import type { ResourceIconService } from "../images/resource-icons.js";
import type { createDashboardService } from "./service.js";
import {
  APP_STORE_CONNECT,
  TEMPLATE_CONNECTORS,
  brandSupported,
  buildBrandTemplate,
  buildOverviewTemplate,
  type TemplateSource,
} from "./templates.js";

/**
 * "New dashboard → from a template" (ADR 0015 section 9, #226): the
 * builders in ./templates turn the workspace's connections into a
 * dashboard, which is then created through the dashboard service like one
 * a user sends, so every rule (metrics, resources, layout, images, accent
 * contrast, audit) applies unchanged. Templates are generated server-side,
 * like the onboarding dashboard (#51), and are ordinary dashboards after.
 */

interface Actor {
  workspaceId: string;
  callerId: string;
  /**
   * The creator's language (their session's, ADR 0016 section 3): the
   * template's names and titles are created in it (section 5, #268).
   */
  locale?: Locale;
}

type DashboardService = ReturnType<typeof createDashboardService>;
type DashboardResult = Awaited<ReturnType<DashboardService["create"]>>;

export interface TemplateServiceDeps {
  db: Database;
  registry: ConnectorRegistry;
  dashboards: DashboardService;
  icons: ResourceIconService;
  /** Whether an App Store Connect connection holds a reviews key. */
  hasReviewsKey: (actor: Actor, connectionId: string) => Promise<boolean>;
}

export function createTemplateService(deps: TemplateServiceDeps) {
  const inWorkspace = <T>(
    actor: Actor,
    fn: Parameters<typeof withWorkspace<T>>[2],
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      fn,
    );

  /** The workspace's connections the templates know metrics of. */
  async function sources(actor: Actor): Promise<TemplateSource[]> {
    const rows = await inWorkspace(actor, async (tx) =>
      (await listConnections(tx, actor.workspaceId)).map(
        (loaded) => loaded.row,
      ),
    );
    const known = rows.filter(
      (row) =>
        (TEMPLATE_CONNECTORS as readonly string[]).includes(row.connectorId) &&
        deps.registry.get(row.connectorId) !== undefined,
    );
    return Promise.all(
      known.map(async (row) => ({
        connectionId: row.id,
        connectionName: row.name,
        connectorId: row.connectorId,
        ...(row.connectorId === APP_STORE_CONNECT
          ? { hasReviews: await deps.hasReviewsKey(actor, row.id) }
          : {}),
      })),
    );
  }

  function iconSupported(connectorId: string): boolean {
    const registered = deps.registry.get(connectorId);
    return (
      registered !== undefined && supportsResourceIcons(registered.connector)
    );
  }

  return {
    async options(actor: Actor): Promise<DashboardTemplateOptionsResponse> {
      const all = await sources(actor);
      const byId = new Map(all.map((source) => [source.connectionId, source]));
      const brandable = all.filter((source) =>
        brandSupported(source.connectorId),
      );
      const resources = await inWorkspace(actor, (tx) =>
        listNamedResources(
          tx,
          actor.workspaceId,
          brandable.map((source) => source.connectionId),
        ),
      );
      const strip = (source: TemplateSource) => ({
        connectionId: source.connectionId,
        connectionName: source.connectionName,
        connectorId: source.connectorId,
      });
      return {
        overview: { sources: all.map(strip) },
        brand: {
          resources: resources.map((resource) => {
            const source = byId.get(resource.connectionId)!;
            return {
              ...strip(source),
              resourceId: resource.resourceId,
              name: resource.name,
              kind: resource.kind,
              iconSupported: iconSupported(source.connectorId),
            };
          }),
        },
      };
    },

    async create(
      actor: Actor,
      body: CreateDashboardFromTemplateRequest,
    ): Promise<DashboardResult> {
      const locale = actor.locale ?? DEFAULT_LOCALE;
      if (body.template === "overview") {
        const built = buildOverviewTemplate(await sources(actor), {
          name: body.name,
          locale,
        });
        if (!built) {
          return { ok: false, status: 409, error: "none_connected" };
        }
        return deps.dashboards.create(
          actor,
          createDashboardRequestSchema.parse(built),
        );
      }

      const found = await inWorkspace(actor, async (tx) => {
        const connection = await findConnection(
          tx,
          actor.workspaceId,
          body.connectionId,
        );
        if (
          !connection ||
          !(await connectionHasResource(
            tx,
            actor.workspaceId,
            body.connectionId,
            body.resourceId,
          ))
        ) {
          return null;
        }
        const names = await findResourceNames(tx, actor.workspaceId, [
          { connectionId: body.connectionId, resourceId: body.resourceId },
        ]);
        return {
          row: connection.row,
          name:
            names.get(resourceNameKey(body.connectionId, body.resourceId)) ??
            body.resourceId,
        };
      });
      if (!found) {
        return { ok: false, status: 404, error: "resource_not_found" };
      }
      if (!brandSupported(found.row.connectorId)) {
        return { ok: false, status: 400, error: "template_unsupported" };
      }
      let logoImageId = body.logoImageId;
      if (logoImageId === undefined) {
        // Best effort: a brand without a reachable icon starts without a
        // logo, and the studio's picker can add one.
        const icon = iconSupported(found.row.connectorId)
          ? await deps.icons.use(actor, body.connectionId, body.resourceId)
          : null;
        logoImageId = icon?.ok ? icon.value.id : null;
      }
      const source: TemplateSource = {
        connectionId: found.row.id,
        connectionName: found.row.name,
        connectorId: found.row.connectorId,
        ...(found.row.connectorId === APP_STORE_CONNECT
          ? { hasReviews: await deps.hasReviewsKey(actor, found.row.id) }
          : {}),
      };
      const built = buildBrandTemplate({
        source,
        resourceId: body.resourceId,
        resourceName: found.name,
        ...(body.name ? { name: body.name } : {}),
        logoImageId,
        accentColor: body.accentColor ?? null,
        locale,
      });
      if (!built) {
        return { ok: false, status: 400, error: "template_unsupported" };
      }
      return deps.dashboards.create(
        actor,
        createDashboardRequestSchema.parse(built),
      );
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
