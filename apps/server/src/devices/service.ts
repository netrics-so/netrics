import { randomInt } from "node:crypto";

import type {
  ApproveDeviceRequest,
  CreatePairingResponse,
  Device,
  DeviceCredentials,
  DeviceSelfResponse,
  PollPairingResponse,
  UpdateDeviceRequest,
} from "@netrics/contracts";
import {
  approvePairing,
  claimPairing,
  countPairingFailures,
  countRecentPairings,
  findDashboard,
  findDevice,
  findPendingPairing,
  insertAuditEvent,
  insertDevice,
  insertPairing,
  issueDeviceTokens,
  listDevices,
  pruneStalePairings,
  readPairing,
  recordPairingFailure,
  revokeDevice,
  rotateDeviceRefreshToken,
  updateDevice,
  withWorkspace,
  type Database,
  type DeviceRow,
} from "@netrics/database";

import { generatePrincipalToken, generateToken, hashToken } from "../tokens.js";

// Device pairing and credentials (ADR 0011).

/** How long a code can be approved. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_POLL_INTERVAL_SECONDS = 5;
/** New pairings per client IP and window. */
export const PAIRING_RATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };
/** Failed approvals per user and window before 429. */
export const APPROVAL_FAILURE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 };
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * How long a rotated refresh token may come back as a retry (the device
 * lost the response) before it counts as reuse.
 */
export const REFRESH_RETRY_WINDOW_SECONDS = 5 * 60;
/** Expired pairings and failed approvals are deleted after a day. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** No look-alikes: 0/O, 1/I/L, 2/Z, 5/S, 8/B are left out. */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";
const CODE_LENGTH = 8;

type ErrorStatus = 400 | 401 | 404 | 410 | 429;

export type Result<T> =
  { ok: true; value: T } | { ok: false; status: ErrorStatus; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(status: ErrorStatus, error: string): Result<T> {
  return { ok: false, status, error };
}

export function generatePairingCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The code as stored (hashed): upper case, without spaces and dashes. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

export function presentDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    dashboardId: row.dashboardId,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export interface DeviceServiceDeps {
  db: Database;
  pairingUrl: string;
  now?: () => Date;
}

export function createDeviceService(deps: DeviceServiceDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function approveUrl(code: string): string {
    const url = new URL(deps.pairingUrl);
    url.searchParams.set("code", code);
    return url.toString();
  }

  return {
    /** A new pairing for an unauthenticated device, rate-limited per IP. */
    async createPairing(
      clientIp: string,
    ): Promise<Result<CreatePairingResponse>> {
      const at = now();
      const clientKey = hashToken(`pairing:${clientIp}`);
      const recent = await countRecentPairings(
        db,
        clientKey,
        new Date(at.getTime() - PAIRING_RATE_LIMIT.windowMs),
      );
      if (recent >= PAIRING_RATE_LIMIT.max) {
        return fail(429, "too_many_requests");
      }
      // Pairings and failed approvals are only needed briefly.
      await pruneStalePairings(db, new Date(at.getTime() - STALE_AFTER_MS));
      const pollSecret = generateToken();
      // A code collision with a live pairing is astronomically unlikely;
      // the unique index turns it into a retry.
      for (let attempt = 0; ; attempt += 1) {
        const code = generatePairingCode();
        try {
          const pairing = await insertPairing(db, {
            codeHash: hashToken(normalizePairingCode(code)),
            pollSecretHash: hashToken(pollSecret),
            clientKey,
            expiresAt: new Date(at.getTime() + PAIRING_TTL_MS),
          });
          return ok({
            pairingId: pairing.id,
            code,
            pollSecret,
            expiresAt: pairing.expiresAt.toISOString(),
            pollIntervalSeconds: PAIRING_POLL_INTERVAL_SECONDS,
            pairingUrl: deps.pairingUrl,
            approveUrl: approveUrl(code),
          });
        } catch (error) {
          if (attempt >= 2) throw error;
        }
      }
    },

    /**
     * Approves a code for a new device in the caller's workspace. Unknown,
     * expired and already used codes all answer 404 and count as failures.
     */
    async approve(
      actor: { workspaceId: string; userId: string },
      body: ApproveDeviceRequest,
    ): Promise<Result<Device>> {
      const at = now();
      const failures = await countPairingFailures(
        db,
        actor.userId,
        new Date(at.getTime() - APPROVAL_FAILURE_LIMIT.windowMs),
      );
      if (failures >= APPROVAL_FAILURE_LIMIT.max) {
        return fail(429, "too_many_attempts");
      }
      const pairing = await findPendingPairing(
        db,
        hashToken(normalizePairingCode(body.code)),
        at,
      );
      if (!pairing) {
        await recordPairingFailure(db, actor.userId);
        return fail(404, "pairing_not_found");
      }
      const result = await withWorkspace(
        db,
        { workspaceId: actor.workspaceId, userId: actor.userId },
        async (tx): Promise<Result<DeviceRow>> => {
          if (
            body.dashboardId &&
            !(await findDashboard(tx, actor.workspaceId, body.dashboardId))
          ) {
            return fail(404, "dashboard_not_found");
          }
          const device = await insertDevice(tx, {
            workspaceId: actor.workspaceId,
            name: body.name,
            dashboardId: body.dashboardId,
            approvedByUserId: actor.userId,
          });
          const approved = await approvePairing(tx, {
            pairingId: pairing.id,
            workspaceId: actor.workspaceId,
            deviceId: device.id,
            now: at,
          });
          if (!approved) {
            // Approved elsewhere or expired since the lookup: undo the device.
            throw new PairingRaceError();
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.userId,
            action: "device.approved",
            target: device.id,
            metadata: { name: device.name, dashboardId: device.dashboardId },
          });
          return ok(device);
        },
      ).catch((error: unknown) => {
        if (error instanceof PairingRaceError) {
          return fail<DeviceRow>(404, "pairing_not_found");
        }
        throw error;
      });
      return result.ok ? ok(presentDevice(result.value)) : result;
    },

    /**
     * The device's poll. The first poll after approval receives the
     * credentials; the pairing is spent afterwards.
     */
    async poll(input: {
      pairingId: string;
      pollSecret: string;
    }): Promise<Result<PollPairingResponse>> {
      const at = now();
      const pollSecretHash = hashToken(input.pollSecret);
      const state = await readPairing(db, {
        pairingId: input.pairingId,
        pollSecretHash,
        now: at,
      });
      switch (state.status) {
        case "unknown":
          return fail(404, "pairing_not_found");
        case "expired":
          return fail(410, "pairing_expired");
        case "claimed":
          return fail(410, "pairing_claimed");
        case "pending":
          return ok({
            status: "pending",
            expiresAt: state.expiresAt.toISOString(),
          });
      }
      const { workspaceId, deviceId } = state;
      return withWorkspace(db, { workspaceId }, async (tx) => {
        const device = await findDevice(tx, workspaceId, deviceId);
        if (!device || device.revokedAt) {
          return fail<PollPairingResponse>(410, "pairing_claimed");
        }
        const claimed = await claimPairing(tx, {
          pairingId: input.pairingId,
          pollSecretHash,
          now: at,
        });
        if (!claimed) {
          return fail<PollPairingResponse>(410, "pairing_claimed");
        }
        const accessToken = generatePrincipalToken();
        const refreshToken = generatePrincipalToken();
        const accessExpiresAt = new Date(at.getTime() + ACCESS_TOKEN_TTL_MS);
        const refreshExpiresAt = new Date(at.getTime() + REFRESH_TOKEN_TTL_MS);
        await issueDeviceTokens(tx, {
          deviceId,
          workspaceId,
          name: device.name,
          accessHash: hashToken(accessToken),
          accessExpiresAt,
          refreshHash: hashToken(refreshToken),
          refreshExpiresAt,
        });
        return ok<PollPairingResponse>({
          status: "approved",
          device: { id: device.id, name: device.name },
          credentials: {
            accessToken,
            accessTokenExpiresAt: accessExpiresAt.toISOString(),
            refreshToken,
            refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
          },
        });
      });
    },

    async list(workspaceId: string): Promise<Device[]> {
      const rows = await withWorkspace(db, { workspaceId }, (tx) =>
        listDevices(tx, workspaceId),
      );
      return rows.map(presentDevice);
    },

    /** Revokes the device and all its tokens; the next request gets 401. */
    async revoke(
      actor: { workspaceId: string; userId: string },
      deviceId: string,
    ): Promise<Result<Device>> {
      return withWorkspace(
        db,
        { workspaceId: actor.workspaceId, userId: actor.userId },
        async (tx) => {
          const revoked = await revokeDevice(tx, actor.workspaceId, deviceId);
          const device = await findDevice(tx, actor.workspaceId, deviceId);
          if (!device) {
            return fail<Device>(404, "device_not_found");
          }
          if (revoked) {
            await insertAuditEvent(tx, {
              workspaceId: actor.workspaceId,
              actorUserId: actor.userId,
              action: "device.revoked",
              target: deviceId,
              metadata: { name: device.name },
            });
          }
          return ok(presentDevice(device));
        },
      );
    },
    /**
     * Exchanges a refresh token for a new pair. A refresh token that comes
     * back after it was replaced revokes the device (ADR 0011).
     */
    async refresh(refreshToken: string): Promise<Result<DeviceCredentials>> {
      const at = now();
      const accessToken = generatePrincipalToken();
      const nextRefreshToken = generatePrincipalToken();
      const accessExpiresAt = new Date(at.getTime() + ACCESS_TOKEN_TTL_MS);
      const refreshExpiresAt = new Date(at.getTime() + REFRESH_TOKEN_TTL_MS);
      const outcome = await rotateDeviceRefreshToken(db, {
        refreshHash: hashToken(refreshToken),
        accessHash: hashToken(accessToken),
        accessExpiresAt,
        newRefreshHash: hashToken(nextRefreshToken),
        refreshExpiresAt,
        retryWindowSeconds: REFRESH_RETRY_WINDOW_SECONDS,
      });
      if (outcome.status === "reused") {
        // Its tokens are already revoked; mark the device so it shows up.
        await withWorkspace(
          db,
          { workspaceId: outcome.workspaceId },
          async (tx) => {
            if (await revokeDevice(tx, outcome.workspaceId, outcome.deviceId)) {
              await insertAuditEvent(tx, {
                workspaceId: outcome.workspaceId,
                actorUserId: null,
                action: "device.revoked",
                target: outcome.deviceId,
                metadata: { reason: "refresh_token_reuse" },
              });
            }
          },
        );
        return fail(401, "unauthorized");
      }
      if (outcome.status === "invalid") {
        return fail(401, "unauthorized");
      }
      return ok({
        accessToken,
        accessTokenExpiresAt: accessExpiresAt.toISOString(),
        refreshToken: nextRefreshToken,
        refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      });
    },

    /** The calling device (after the device guard). */
    async self(principal: {
      workspaceId: string;
      deviceId: string;
    }): Promise<Result<DeviceSelfResponse["device"]>> {
      const device = await withWorkspace(
        db,
        { workspaceId: principal.workspaceId },
        (tx) => findDevice(tx, principal.workspaceId, principal.deviceId),
      );
      if (!device || device.revokedAt) {
        return fail(401, "unauthorized");
      }
      return ok({
        id: device.id,
        name: device.name,
        dashboardId: device.dashboardId,
      });
    },

    /** Renames a device or assigns another dashboard. */
    async update(
      actor: { workspaceId: string; userId: string },
      deviceId: string,
      body: UpdateDeviceRequest,
    ): Promise<Result<Device>> {
      return withWorkspace(
        db,
        { workspaceId: actor.workspaceId, userId: actor.userId },
        async (tx) => {
          if (
            body.dashboardId &&
            !(await findDashboard(tx, actor.workspaceId, body.dashboardId))
          ) {
            return fail<Device>(404, "dashboard_not_found");
          }
          const device = await updateDevice(tx, actor.workspaceId, deviceId, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.dashboardId !== undefined
              ? { dashboardId: body.dashboardId }
              : {}),
          });
          if (!device) {
            return fail<Device>(404, "device_not_found");
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.userId,
            action: "device.updated",
            target: deviceId,
            metadata: {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.dashboardId !== undefined
                ? { dashboardId: body.dashboardId }
                : {}),
            },
          });
          return ok(presentDevice(device));
        },
      );
    },
  };
}

class PairingRaceError extends Error {
  constructor() {
    super("pairing approved or expired concurrently");
    this.name = "PairingRaceError";
  }
}

export type DeviceService = ReturnType<typeof createDeviceService>;
