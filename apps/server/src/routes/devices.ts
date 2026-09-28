import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  DEVICE_API_VERSION,
  approveDeviceRequestSchema,
  createPairingResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  pollPairingRequestSchema,
  pollPairingResponseSchema,
  serverInfoResponseSchema,
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
import { createRequireSession } from "./session.js";

// HTTP layer for devices and pairing (ADR 0010, ADR 0011).

export interface DeviceRouteDeps {
  authService: AuthService;
  db: Database;
  pairingUrl: string;
  version: string;
}

const deviceParamsSchema = z.object({ deviceId: z.uuid() });

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
      const pairing = unwrap(await devices.createPairing(request.ip), reply);
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
