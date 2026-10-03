import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  DEVICE_API_VERSION,
  approveDeviceRequestSchema,
  createPairingResponseSchema,
  deviceDashboardResponseSchema,
  deviceHeartbeatRequestSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  deviceSelfResponseSchema,
  pollPairingRequestSchema,
  pollPairingResponseSchema,
  refreshDeviceTokenRequestSchema,
  refreshDeviceTokenResponseSchema,
  serverInfoResponseSchema,
  updateDeviceRequestSchema,
} from "@netrics/contracts";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createDeviceService, type Result } from "../devices/service.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireDevice } from "./principal.js";
import { createRequireSession } from "./session.js";

// HTTP layer for devices and pairing (ADR 0010, ADR 0011).

export interface DeviceRouteDeps {
  authService: AuthService;
  db: Database;
  pairingUrl: string;
  version: string;
}

const deviceParamsSchema = z.object({ deviceId: z.uuid() });

/** Whether an If-None-Match header names this entity tag. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}

function unwrap<T>(result: Result<T>, reply: FastifyReply): T | null {
  if (!result.ok) {
    sendError(reply, result.status, result.error);
    return null;
  }
  return result.value;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: DeviceRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const requireDevice = createRequireDevice({ db: deps.db });
  const devices = createDeviceService(deps);

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
  ): Promise<WorkspaceAccess | null> {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) {
      return null;
    }
    if (!can(access.role, action)) {
      sendError(reply, 403, "forbidden");
      return null;
    }
    return access;
  }

  // Public: the TV app checks a server before pairing (ADR 0010).
  app.get(
    "/v1/server",
    {
      schema: routeSchema({
        summary: "Identify this server for device apps",
        tags: ["devices"],
        response: serverInfoResponseSchema,
        public: true,
      }),
    },
    async () =>
      serverInfoResponseSchema.parse({
        product: "netrics",
        deviceApiVersion: DEVICE_API_VERSION,
        version: deps.version,
        pairingUrl: deps.pairingUrl,
      }),
  );

  // Public: a device starts pairing without any credentials.
  app.post(
    "/v1/device/pairings",
    {
      schema: routeSchema({
        summary: "Start pairing a device (shows a code on screen)",
        tags: ["devices"],
        response: createPairingResponseSchema,
        errors: [429],
        public: true,
      }),
    },
    async (request, reply) => {
      const pairing = unwrap(
        await devices.createPairing(request.clientIp),
        reply,
      );
      if (!pairing) {
        return;
      }
      return createPairingResponseSchema.parse(pairing);
    },
  );

  // Public: the device proves itself with the poll secret.
  app.post(
    "/v1/device/pairings/poll",
    {
      schema: routeSchema({
        summary: "Poll a pairing; returns the credentials once approved",
        tags: ["devices"],
        body: pollPairingRequestSchema,
        response: pollPairingResponseSchema,
        errors: [404, 410],
        public: true,
      }),
    },
    async (request, reply) => {
      const body = parseBody(pollPairingRequestSchema, request, reply);
      if (!body) {
        return;
      }
      const result = unwrap(await devices.poll(body), reply);
      if (!result) {
        return;
      }
      // Credentials must never be cached on the way.
      void reply.header("cache-control", "no-store");
      return pollPairingResponseSchema.parse(result);
    },
  );

  // Public: the refresh token in the body is the credential.
  app.post(
    "/v1/device/token",
    {
      schema: routeSchema({
        summary: "Exchange a device refresh token for new credentials",
        tags: ["devices"],
        body: refreshDeviceTokenRequestSchema,
        response: refreshDeviceTokenResponseSchema,
        public: true,
      }),
    },
    async (request, reply) => {
      const body = parseBody(refreshDeviceTokenRequestSchema, request, reply);
      if (!body) {
        return;
      }
      const credentials = unwrap(
        await devices.refresh(body.refreshToken),
        reply,
      );
      if (!credentials) {
        return;
      }
      void reply.header("cache-control", "no-store");
      return refreshDeviceTokenResponseSchema.parse({ credentials });
    },
  );

  // Device API: device access tokens only (ADR 0011).
  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireDevice);

      scope.get(
        "/me",
        {
          schema: routeSchema({
            summary: "The calling device",
            tags: ["devices"],
            response: deviceSelfResponseSchema,
            device: true,
          }),
        },
        async (request, reply) => {
          const device = unwrap(await devices.self(request.device!), reply);
          if (!device) {
            return;
          }
          return deviceSelfResponseSchema.parse({ device });
        },
      );

      scope.get(
        "/dashboard",
        {
          schema: routeSchema({
            summary:
              "The device's dashboard as tiles; send If-None-Match with the " +
              "last ETag to get 304 when nothing changed",
            tags: ["devices"],
            response: deviceDashboardResponseSchema,
            device: true,
            notModified: true,
          }),
        },
        async (request, reply) => {
          const dashboard = unwrap(
            await devices.dashboard(request.device!, request.log),
            reply,
          );
          if (!dashboard) {
            return;
          }
          const etag = `"${dashboard.version}"`;
          // Private data: caches must ask again every time.
          void reply.header("etag", etag).header("cache-control", "no-cache");
          if (matchesEtag(request.headers["if-none-match"], etag)) {
            return reply.code(304).send();
          }
          return deviceDashboardResponseSchema.parse(dashboard);
        },
      );

      scope.post(
        "/heartbeat",
        {
          schema: routeSchema({
            summary: "Report the device's app version, uptime and last error",
            tags: ["devices"],
            body: deviceHeartbeatRequestSchema,
            device: true,
          }),
        },
        async (request, reply) => {
          const body = parseBody(deviceHeartbeatRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await devices.heartbeat(request.device!, body);
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return reply.code(204).send();
        },
      );

      done();
    },
    { prefix: "/v1/device" },
  );

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/devices",
        {
          schema: routeSchema({
            summary: "List paired devices",
            tags: ["devices"],
            response: deviceListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "devices:view");
          if (!access) {
            return;
          }
          return deviceListResponseSchema.parse({
            devices: await devices.list(access.workspaceId),
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/devices/approve",
        {
          schema: routeSchema({
            summary: "Approve a pairing code and add the device",
            tags: ["devices"],
            body: approveDeviceRequestSchema,
            response: deviceResponseSchema,
            errors: [403, 404, 429],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "devices:manage");
          if (!access) {
            return;
          }
          const body = parseBody(approveDeviceRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const device = unwrap(
            await devices.approve(
              { workspaceId: access.workspaceId, userId: access.callerId },
              body,
            ),
            reply,
          );
          if (!device) {
            return;
          }
          return deviceResponseSchema.parse({ device });
        },
      );

      scope.patch(
        "/workspaces/:workspaceId/devices/:deviceId",
        {
          schema: routeSchema({
            summary: "Rename a device or change its dashboard",
            tags: ["devices"],
            body: updateDeviceRequestSchema,
            response: deviceResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "devices:manage");
          if (!access) {
            return;
          }
          const params = deviceParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "device_not_found");
          }
          const body = parseBody(updateDeviceRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const device = unwrap(
            await devices.update(
              { workspaceId: access.workspaceId, userId: access.callerId },
              params.data.deviceId,
              body,
            ),
            reply,
          );
          if (!device) {
            return;
          }
          return deviceResponseSchema.parse({ device });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/devices/:deviceId/revoke",
        {
          schema: routeSchema({
            summary: "Revoke a device and all its credentials",
            tags: ["devices"],
            response: deviceResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "devices:manage");
          if (!access) {
            return;
          }
          const params = deviceParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "device_not_found");
          }
          const device = unwrap(
            await devices.revoke(
              { workspaceId: access.workspaceId, userId: access.callerId },
              params.data.deviceId,
            ),
            reply,
          );
          if (!device) {
            return;
          }
          return deviceResponseSchema.parse({ device });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
