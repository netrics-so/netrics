import { createHash } from "node:crypto";

import type { ResourceIconSource, WorkspaceImage } from "@netrics/contracts";
import {
  executeResourceIcons,
  supportsResourceIcons,
  type ConnectorRegistry,
  type ExecuteOptions,
  type FetchedResourceIcon,
} from "@netrics/connector-runtime";
import type { ConnectionContext, Connector } from "@netrics/connector-sdk";
import {
  connectionHasResource,
  findConnection,
  findResourceIcon,
  findResourceNames,
  hasSqlstate,
  insertAuditEvent,
  listConnections,
  listNamedResources,
  listResourceIcons,
  replaceImageReferences,
  resourceNameKey,
  resourceTopTerritories,
  withWorkspace,
  type Database,
  type ImageQuota,
  type ImageRow,
} from "@netrics/database";

import { sanitizeImage } from "./format.js";
import { presentImage, sanitizeImageName } from "./service.js";
import { postgresImageStore, type ImageStore } from "./store.js";

/**
 * Resource icons (#226, ADR 0015 section 5): a connection resource's icon,
 * such as an app's App Store icon, stored as a workspace image of origin
 * "resource_icon". The connector fetches it through its allowlisted
 * runtime.fetch; the bytes then go through the same validation as an
 * upload (magic bytes, strict header parse, metadata stripped) and count
 * against the same quota. Icons are fetched when someone uses one ("Use
 * app icon", the Brand template) and refreshed with the connection's
 * resource names, at most daily. A changed icon becomes a new image that
 * replaces the old one wherever it is shown; an unchanged one is kept.
 */

/** How long a stored icon counts as fresh. */
export const RESOURCE_ICON_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Runs one connector call with the connection's credentials. */
export type ConnectorCall = <T>(
  call: (context: ConnectionContext, options: ExecuteOptions) => Promise<T>,
) => Promise<T>;

export interface StoreIconsInput {
  db: Database;
  quota: ImageQuota;
  store?: ImageStore;
  workspaceId: string;
  connectionId: string;
  connector: Connector;
  run: ConnectorCall;
  /** The resources to fetch, with their display names. */
  resources: ReadonlyArray<{ id: string; name: string | null }>;
  /** The user who asked, or null for the daily refresh. */
  actorUserId: string | null;
  now: Date;
  /** Notes without data (an icon refused, the quota full). */
  log?: (message: string) => void;
}

/** The connector call for icons failed (a provider failure). */
export class ResourceIconFetchError extends Error {
  constructor(cause: unknown) {
    super("the connector could not fetch resource icons", { cause });
    this.name = "ResourceIconFetchError";
  }
}

/** Why one icon was not stored. */
type Skip = "invalid" | "quota_exceeded";

/**
 * Fetches the icons of the given resources and stores each new or changed
 * one. Returns the stored icon per resource id (also when unchanged).
 * Throws ResourceIconFetchError when the connector call fails.
 */
export async function fetchAndStoreIcons(
  input: StoreIconsInput,
): Promise<Map<string, ImageRow>> {
  const store = input.store ?? postgresImageStore;
  const log = input.log ?? (() => {});
  const stored = new Map<string, ImageRow>();
  if (input.resources.length === 0 || !supportsResourceIcons(input.connector)) {
    return stored;
  }
  const ids = input.resources.map((resource) => resource.id);
  const territories = await withWorkspace(
    input.db,
    { workspaceId: input.workspaceId },
    (tx) =>
      resourceTopTerritories(
        tx,
        input.workspaceId,
        input.connectionId,
        ids,
        input.now,
      ),
  );
  let icons: FetchedResourceIcon[];
  try {
    icons = await input.run((context, options) =>
      executeResourceIcons(
        input.connector,
        context,
        {
          resources: ids.map((id) => ({
            id,
            ...(territories.get(id)?.length
              ? { territories: territories.get(id)! }
              : {}),
          })),
        },
        options,
      ),
    );
  } catch (error) {
    throw new ResourceIconFetchError(error);
  }
  const names = new Map(input.resources.map((r) => [r.id, r.name]));
  for (const icon of icons) {
    const result = await storeIcon(
      input,
      store,
      icon,
      names.get(icon.resourceId) ?? null,
    );
    if (typeof result === "string") {
      // Neither the bytes nor the resource's name reach the log.
      log(
        result === "invalid"
          ? "a resource icon was refused by the image checks"
          : "a resource icon was not stored: the image quota is full",
      );
      continue;
    }
    stored.set(icon.resourceId, result);
  }
  return stored;
}

async function storeIcon(
  input: StoreIconsInput,
  store: ImageStore,
  icon: FetchedResourceIcon,
  resourceName: string | null,
): Promise<ImageRow | Skip> {
  const checked = sanitizeImage(icon.contentType, icon.bytes);
  if (!checked.ok) {
    return "invalid";
  }
  const sha256 = createHash("sha256").update(checked.content).digest("hex");
  const { workspaceId, connectionId } = input;
  return withWorkspace(
    input.db,
    {
      workspaceId,
      ...(input.actorUserId ? { userId: input.actorUserId } : {}),
    },
    async (tx) => {
      const existing = await findResourceIcon(
        tx,
        workspaceId,
        connectionId,
        icon.resourceId,
      );
      if (existing && existing.sha256 === sha256) {
        return existing;
      }
      const inserted = await store.insert(
        tx,
        workspaceId,
        {
          name: sanitizeImageName(
            resourceName ? `${resourceName} icon` : "App icon",
          ),
          contentType: checked.contentType,
          width: checked.width,
          height: checked.height,
          sha256,
          content: checked.content,
          origin: "resource_icon",
          connectionId,
          resourceId: icon.resourceId,
          createdByUserId: input.actorUserId,
        },
        input.quota,
      );
      if (inserted.status === "quota_exceeded") {
        return "quota_exceeded";
      }
      if (existing) {
        // The new icon takes the old one's place everywhere it is shown;
        // the old image goes (a savepoint keeps it when a dashboard saved
        // meanwhile still refers to it).
        await replaceImageReferences(
          tx,
          workspaceId,
          existing.id,
          inserted.image.id,
        );
        try {
          await tx.transaction((savepoint) =>
            store.remove(savepoint, workspaceId, existing.id),
          );
        } catch (error) {
          if (!hasSqlstate(error, "23503")) {
            throw error;
          }
        }
      }
      await insertAuditEvent(tx, {
        workspaceId,
        actorUserId: input.actorUserId,
        action: existing ? "image.icon_refreshed" : "image.uploaded",
        target: inserted.image.id,
        metadata: {
          origin: "resource_icon",
          connectionId,
          contentType: inserted.image.contentType,
          bytes: inserted.image.bytes,
          width: inserted.image.width,
          height: inserted.image.height,
        },
      });
      return inserted.image;
    },
  );
}

/**
 * The daily refresh, after a sync refreshed the resource names: every icon
 * the workspace stores for this connection is fetched again in one call.
 */
export async function refreshConnectionIcons(
  input: Omit<StoreIconsInput, "resources" | "actorUserId">,
): Promise<number> {
  if (!supportsResourceIcons(input.connector)) {
    return 0;
  }
  const icons = await withWorkspace(
    input.db,
    { workspaceId: input.workspaceId },
    (tx) => listResourceIcons(tx, input.workspaceId, input.connectionId),
  );
  const resourceIds = [
    ...new Set(icons.map((icon) => icon.resourceId).filter(Boolean)),
  ] as string[];
  if (resourceIds.length === 0) {
    return 0;
  }
  const names = await withWorkspace(
    input.db,
    { workspaceId: input.workspaceId },
    (tx) =>
      findResourceNames(
        tx,
        input.workspaceId,
        resourceIds.map((resourceId) => ({
          connectionId: input.connectionId,
          resourceId,
        })),
      ),
  );
  const stored = await fetchAndStoreIcons({
    ...input,
    actorUserId: null,
    resources: resourceIds.slice(0, 50).map((id) => ({
      id,
      name: names.get(resourceNameKey(input.connectionId, id)) ?? null,
    })),
  });
  return stored.size;
}

export interface Actor {
  workspaceId: string;
  callerId: string;
}

export type IconResult =
  | { ok: true; value: WorkspaceImage }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

export interface ResourceIconServiceDeps {
  db: Database;
  quota: ImageQuota;
  registry: ConnectorRegistry;
  /** connections.callConnection, bound: runs a call with credentials. */
  callConnection: <T>(
    actor: Actor,
    connectionId: string,
    call: (
      connector: Connector,
      context: ConnectionContext,
      options: ExecuteOptions,
    ) => Promise<T>,
  ) => Promise<
    { ok: true; value: T } | { ok: false; status: 400 | 404; error: string }
  >;
  now?: () => Date;
}

export function createResourceIconService(deps: ResourceIconServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const inWorkspace = <T>(
    actor: Actor,
    fn: Parameters<typeof withWorkspace<T>>[2],
  ) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      fn,
    );

  return {
    /**
     * The resources whose icon can be used: those of connections whose
     * connector can fetch icons, with the stored icon when there is one.
     */
    async list(actor: Actor): Promise<ResourceIconSource[]> {
      return inWorkspace(actor, async (tx) => {
        const connections = (await listConnections(tx, actor.workspaceId))
          .map((loaded) => loaded.row)
          .filter((row) => {
            const registered = deps.registry.get(row.connectorId);
            return (
              registered !== undefined &&
              supportsResourceIcons(registered.connector)
            );
          });
        const names = new Map(connections.map((row) => [row.id, row.name]));
        const [resources, icons] = [
          await listNamedResources(
            tx,
            actor.workspaceId,
            connections.map((row) => row.id),
          ),
          await listResourceIcons(tx, actor.workspaceId),
        ];
        const iconOf = new Map<string, ImageRow>();
        for (const icon of icons) {
          const key = resourceNameKey(icon.connectionId!, icon.resourceId!);
          if (!iconOf.has(key)) iconOf.set(key, icon);
        }
        return resources.map((resource) => {
          const icon = iconOf.get(
            resourceNameKey(resource.connectionId, resource.resourceId),
          );
          return {
            connectionId: resource.connectionId,
            connectionName: names.get(resource.connectionId) ?? "",
            resourceId: resource.resourceId,
            name: resource.name,
            kind: resource.kind,
            image: icon ? presentImage(icon) : null,
          };
        });
      });
    },

    /**
     * The icon of one resource as a workspace image: the stored one while
     * it is fresh, else fetched now. A provider failure answers the stored
     * icon if there is one (502 otherwise); no icon at all is 404.
     */
    async use(
      actor: Actor,
      connectionId: string,
      resourceId: string,
    ): Promise<IconResult> {
      const found = await inWorkspace(actor, async (tx) => {
        const connection = await findConnection(
          tx,
          actor.workspaceId,
          connectionId,
        );
        if (
          !connection ||
          !(await connectionHasResource(
            tx,
            actor.workspaceId,
            connectionId,
            resourceId,
          ))
        ) {
          return null;
        }
        const names = await findResourceNames(tx, actor.workspaceId, [
          { connectionId, resourceId },
        ]);
        return {
          connectorId: connection.row.connectorId,
          name: names.get(resourceNameKey(connectionId, resourceId)) ?? null,
          icon: await findResourceIcon(
            tx,
            actor.workspaceId,
            connectionId,
            resourceId,
          ),
        };
      });
      if (!found) {
        return { ok: false, status: 404, error: "resource_not_found" };
      }
      const registered = deps.registry.get(found.connectorId);
      if (!registered || !supportsResourceIcons(registered.connector)) {
        return { ok: false, status: 400, error: "resource_icons_unsupported" };
      }
      const at = now();
      if (
        found.icon &&
        at.getTime() - found.icon.createdAt.getTime() < RESOURCE_ICON_MAX_AGE_MS
      ) {
        return { ok: true, value: presentImage(found.icon) };
      }
      let stored: Map<string, ImageRow>;
      let quotaFull = false;
      try {
        const result = await deps.callConnection(
          actor,
          connectionId,
          async (connector, context, options) =>
            fetchAndStoreIcons({
              db: deps.db,
              quota: deps.quota,
              workspaceId: actor.workspaceId,
              connectionId,
              connector,
              run: (call) => call(context, options),
              resources: [{ id: resourceId, name: found.name }],
              actorUserId: actor.callerId,
              now: at,
              log: (message) => {
                if (/quota/.test(message)) quotaFull = true;
              },
            }),
        );
        if (!result.ok) {
          return result;
        }
        stored = result.value;
      } catch (error) {
        if (!(error instanceof ResourceIconFetchError)) {
          throw error;
        }
        // The provider's error stays out of the answer and the log line.
        return found.icon
          ? { ok: true, value: presentImage(found.icon) }
          : { ok: false, status: 502, error: "resource_icon_unavailable" };
      }
      const icon = stored.get(resourceId) ?? found.icon;
      if (icon) {
        return { ok: true, value: presentImage(icon) };
      }
      return quotaFull
        ? { ok: false, status: 409, error: "image_quota_exceeded" }
        : { ok: false, status: 404, error: "resource_icon_not_found" };
    },
  };
}

export type ResourceIconService = ReturnType<typeof createResourceIconService>;
