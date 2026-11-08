import { sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";

/**
 * How long audit and security events (sign-ins with IP address and browser,
 * membership and credential changes) are kept. The privacy policy states 12
 * months; change both together.
 */
export const AUDIT_EVENT_RETENTION_MONTHS = 12;

/**
 * How long expired sign-in sessions, idle auth rate-limit counters (keyed by
 * client IP) and expired device pairings (hashed client IP) outlive their use.
 */
export const EXPIRED_AUTH_RECORD_HOURS = 24;

/** Retention of records holding IP addresses or user agents. */
export interface SecurityRetentionPolicy {
  /** Audit events by age; also when sessions lose their sign-in IP and browser. */
  auditEventsMonths: number;
  /** Expired sessions, idle rate-limit rows and expired device pairings. */
  expiredRecordsHours: number;
  /** Maximum rows touched per table per call. */
  batch: number;
}

export const SECURITY_RETENTION: SecurityRetentionPolicy = {
  auditEventsMonths: AUDIT_EVENT_RETENTION_MONTHS,
  expiredRecordsHours: EXPIRED_AUTH_RECORD_HOURS,
  batch: 10_000,
};

export interface SecurityPruneResult {
  auditEventsDeleted: number;
  sessionsDeleted: number;
  sessionAddressesCleared: number;
  rateLimitsDeleted: number;
  devicePairingsDeleted: number;
}

/**
 * Applies SecurityRetentionPolicy as of `now` (scheduler role;
 * prune_security_records is SECURITY DEFINER, migration 0029). A count equal
 * to `batch` means more rows remain for the next call.
 */
export async function pruneSecurityRecords(
  schedulerDb: Db | Transaction,
  now: Date,
  policy: SecurityRetentionPolicy = SECURITY_RETENTION,
): Promise<SecurityPruneResult> {
  const [row] = await schedulerDb.execute<{
    audit_events_deleted: number;
    sessions_deleted: number;
    session_addresses_cleared: number;
    rate_limits_deleted: number;
    device_pairings_deleted: number;
  }>(
    sql`select * from prune_security_records(
          ${now.toISOString()}::timestamptz,
          make_interval(months => ${policy.auditEventsMonths}),
          make_interval(hours => ${policy.expiredRecordsHours}),
          ${policy.batch}
        )`,
  );
  return {
    auditEventsDeleted: row?.audit_events_deleted ?? 0,
    sessionsDeleted: row?.sessions_deleted ?? 0,
    sessionAddressesCleared: row?.session_addresses_cleared ?? 0,
    rateLimitsDeleted: row?.rate_limits_deleted ?? 0,
    devicePairingsDeleted: row?.device_pairings_deleted ?? 0,
  };
}

/**
 * How long a removed (revoked) screen's record is kept: its name, platform,
 * last heartbeat values and the admin who approved it. The privacy policy
 * states it; change both together.
 */
export const REVOKED_DEVICE_RETENTION_DAYS = 90;

/**
 * Deletes devices revoked more than `days` ago as of `now`, with their
 * pairings and tokens (scheduler role; prune_revoked_devices is SECURITY
 * DEFINER, migration 0070). A count equal to `batch` means more remain.
 */
export async function pruneRevokedDevices(
  schedulerDb: Db | Transaction,
  now: Date,
  days: number = REVOKED_DEVICE_RETENTION_DAYS,
  batch = 10_000,
): Promise<number> {
  const [row] = await schedulerDb.execute<{ deleted: number }>(
    sql`select prune_revoked_devices(
          ${now.toISOString()}::timestamptz,
          make_interval(days => ${days}),
          ${batch}
        ) as deleted`,
  );
  return row?.deleted ?? 0;
}
