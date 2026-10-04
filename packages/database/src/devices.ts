import { and, count, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import * as schema from "./schema.js";

// Devices and pairing (ADR 0011). Devices are workspace rows (withWorkspace,
// explicit workspace predicates on top of RLS). Pairings and failed
// approvals are installation-level; the application role reads and writes
// them directly. Device tokens go through SECURITY DEFINER functions.

type Executor = Db | Transaction;

export type DeviceRow = typeof schema.devices.$inferSelect;

// ─── Pairings ───────────────────────────────────────────────────────────────

export async function countRecentPairings(
  db: Executor,
  clientKey: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.devicePairings)
    .where(
      and(
        eq(schema.devicePairings.clientKey, clientKey),
        gt(schema.devicePairings.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

export async function insertPairing(
  db: Executor,
  input: {
    codeHash: string;
    pollSecretHash: string;
    clientKey: string;
    expiresAt: Date;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const [row] = await db.insert(schema.devicePairings).values(input).returning({
    id: schema.devicePairings.id,
    expiresAt: schema.devicePairings.expiresAt,
  });
  return row!;
}

/** A pairing waiting for approval, by code; null when unknown or expired. */
export async function findPendingPairing(
  db: Executor,
  codeHash: string,
  now: Date,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: schema.devicePairings.id })
    .from(schema.devicePairings)
    .where(
      and(
        eq(schema.devicePairings.codeHash, codeHash),
        isNull(schema.devicePairings.approvedAt),
        gt(schema.devicePairings.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Marks a pending pairing approved for a device. Conditional, so a pairing
 * is approved at most once; false when it was approved or expired meanwhile.
 */
export async function approvePairing(
  tx: Transaction,
  input: {
    pairingId: string;
    workspaceId: string;
    deviceId: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .update(schema.devicePairings)
    .set({
      approvedAt: input.now,
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
    })
    .where(
      and(
        eq(schema.devicePairings.id, input.pairingId),
        isNull(schema.devicePairings.approvedAt),
        gt(schema.devicePairings.expiresAt, input.now),
      ),
    )
    .returning({ id: schema.devicePairings.id });
  return rows.length === 1;
}

export type PairingState =
  | { status: "unknown" }
  | { status: "pending"; expiresAt: Date }
  | { status: "expired" }
  | { status: "claimed" }
  | { status: "approved"; workspaceId: string; deviceId: string };

/** The pairing as its device sees it (pairing id and poll secret). */
export async function readPairing(
  db: Executor,
  input: { pairingId: string; pollSecretHash: string; now: Date },
): Promise<PairingState> {
  const [row] = await db
    .select()
    .from(schema.devicePairings)
    .where(
      and(
        eq(schema.devicePairings.id, input.pairingId),
        eq(schema.devicePairings.pollSecretHash, input.pollSecretHash),
      ),
    )
    .limit(1);
  if (!row) return { status: "unknown" };
  if (row.claimedAt) return { status: "claimed" };
  if (row.approvedAt && row.workspaceId && row.deviceId) {
    return {
      status: "approved",
      workspaceId: row.workspaceId,
      deviceId: row.deviceId,
    };
  }
  return row.expiresAt > input.now
    ? { status: "pending", expiresAt: row.expiresAt }
    : { status: "expired" };
}

/**
 * Claims an approved pairing's credentials. Conditional, so exactly one poll
 * wins; the caller issues the tokens in the same transaction.
 */
export async function claimPairing(
  tx: Transaction,
  input: { pairingId: string; pollSecretHash: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(schema.devicePairings)
    .set({ claimedAt: input.now })
    .where(
      and(
        eq(schema.devicePairings.id, input.pairingId),
        eq(schema.devicePairings.pollSecretHash, input.pollSecretHash),
        isNotNull(schema.devicePairings.approvedAt),
        isNull(schema.devicePairings.claimedAt),
      ),
    )
    .returning({ id: schema.devicePairings.id });
  return rows.length === 1;
}

export async function recordPairingFailure(
  db: Executor,
  userId: string,
): Promise<void> {
  await db.insert(schema.devicePairingFailures).values({ userId });
}

export async function countPairingFailures(
  db: Executor,
  userId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.devicePairingFailures)
    .where(
      and(
        eq(schema.devicePairingFailures.userId, userId),
        gt(schema.devicePairingFailures.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

// ─── Devices ────────────────────────────────────────────────────────────────

export async function insertDevice(
  tx: Transaction,
  input: {
    workspaceId: string;
    name: string;
    dashboardId: string | null;
    approvedByUserId: string;
  },
): Promise<DeviceRow> {
  const [row] = await tx.insert(schema.devices).values(input).returning();
  return row!;
}

export async function listDevices(
  tx: Transaction,
  workspaceId: string,
): Promise<DeviceRow[]> {
  return tx
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.workspaceId, workspaceId))
    .orderBy(desc(schema.devices.createdAt));
}

export async function findDevice(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
): Promise<DeviceRow | null> {
  const [row] = await tx
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.id, deviceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Revokes a device and every token it holds, in the caller's transaction.
 * Returns false when the device does not exist or was already revoked.
 */
export async function revokeDevice(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
): Promise<boolean> {
  const rows = await tx
    .update(schema.devices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.id, deviceId),
        isNull(schema.devices.revokedAt),
      ),
    )
    .returning({ id: schema.devices.id });
  if (rows.length === 0) return false;
  await tx.execute(
    sql`select revoke_device_tokens(${deviceId}::uuid, ${workspaceId}::uuid)`,
  );
  return true;
}

/** Stores a device's new access and refresh tokens (hashes only). */
export async function issueDeviceTokens(
  tx: Transaction,
  input: {
    deviceId: string;
    workspaceId: string;
    name: string;
    accessHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    refreshExpiresAt: Date;
  },
): Promise<void> {
  await tx.execute(
    sql`select issue_device_tokens(
      ${input.deviceId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.name},
      ${input.accessHash},
      ${input.accessExpiresAt.toISOString()}::timestamptz,
      ${input.refreshHash},
      ${input.refreshExpiresAt.toISOString()}::timestamptz
    )`,
  );
}

/**
 * Deletes pairings that expired before `before` and failed approvals older
 * than it, at most `batch` rows each. Called opportunistically when a new
 * pairing starts, so the tables stay small without a separate job.
 */
export async function pruneStalePairings(
  db: Executor,
  before: Date,
  batch = 100,
): Promise<void> {
  const cutoff = before.toISOString();
  await db.execute(sql`
    delete from device_pairings where id in (
      select id from device_pairings
      where expires_at < ${cutoff}::timestamptz
      limit ${batch})`);
  await db.execute(sql`
    delete from device_pairing_failures where id in (
      select id from device_pairing_failures
      where created_at < ${cutoff}::timestamptz
      limit ${batch})`);
}

export type RefreshOutcome =
  | {
      status: "rotated";
      deviceId: string;
      workspaceId: string;
      deviceName: string;
    }
  | { status: "reused"; deviceId: string; workspaceId: string }
  | { status: "invalid" };

/**
 * Exchanges a refresh token for a new pair (hashes only) through
 * rotate_device_refresh_token(); see migration 0020 for the rules.
 */
export async function rotateDeviceRefreshToken(
  db: Executor,
  input: {
    refreshHash: string;
    accessHash: string;
    accessExpiresAt: Date;
    newRefreshHash: string;
    refreshExpiresAt: Date;
    retryWindowSeconds: number;
  },
): Promise<RefreshOutcome> {
  const rows = await db.execute<{
    status: "rotated" | "reused" | "invalid";
    device_id: string | null;
    workspace_id: string | null;
    device_name: string | null;
  }>(sql`select * from rotate_device_refresh_token(
    ${input.refreshHash},
    ${input.accessHash},
    ${input.accessExpiresAt.toISOString()}::timestamptz,
    ${input.newRefreshHash},
    ${input.refreshExpiresAt.toISOString()}::timestamptz,
    make_interval(secs => ${input.retryWindowSeconds})
  )`);
  const row = rows[0];
  if (row?.status === "rotated") {
    return {
      status: "rotated",
      deviceId: row.device_id!,
      workspaceId: row.workspace_id!,
      deviceName: row.device_name!,
    };
  }
  if (row?.status === "reused") {
    return {
      status: "reused",
      deviceId: row.device_id!,
      workspaceId: row.workspace_id!,
    };
  }
  return { status: "invalid" };
}

/** Records that the device called in, at most once a minute. */
export async function touchDevice(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
): Promise<void> {
  await tx
    .update(schema.devices)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.id, deviceId),
        sql`(${schema.devices.lastSeenAt} is null or ${schema.devices.lastSeenAt} < now() - interval '1 minute')`,
      ),
    );
}

/**
 * Renames a device, changes its dashboard or its screen settings; null when
 * it does not exist.
 */
export async function updateDevice(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
  changes: {
    name?: string;
    dashboardId?: string | null;
    rotation?: number;
    displayMode?: string;
  },
): Promise<DeviceRow | null> {
  const [row] = await tx
    .update(schema.devices)
    .set(changes)
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.id, deviceId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Stores a device's heartbeat and records the contact. `screen` replaces the
 * stored screen when given and keeps it when absent. False when the device
 * does not exist or is revoked.
 */
export async function recordDeviceHeartbeat(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
  heartbeat: {
    appVersion: string;
    uptimeSeconds: number;
    lastError: string | null;
    screen?: schema.DeviceScreenColumn;
  },
): Promise<boolean> {
  const rows = await tx
    .update(schema.devices)
    .set({
      ...heartbeat,
      lastHeartbeatAt: sql`now()`,
      lastSeenAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.devices.workspaceId, workspaceId),
        eq(schema.devices.id, deviceId),
        isNull(schema.devices.revokedAt),
      ),
    )
    .returning({ id: schema.devices.id });
  return rows.length === 1;
}
