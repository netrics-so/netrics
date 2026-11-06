import { randomUUID } from "node:crypto";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";
import {
  AUDIT_EVENT_RETENTION_MONTHS,
  pruneSecurityRecords,
  SECURITY_RETENTION,
  type SecurityRetentionPolicy,
} from "./security-retention.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// #163: the privacy policy keeps security events (sign-ins with IP address
// and browser) for 12 months. Every case runs against a fixed clock, far from
// the wall clock, so the cutoffs come from `now` and not from the database.
const NOW = new Date("2031-03-15T12:00:00.000Z");

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

/** `NOW` shifted by whole months (negative: earlier) plus milliseconds. */
function at(months: number, ms = 0): Date {
  const date = new Date(NOW);
  date.setUTCMonth(date.getUTCMonth() + months);
  return new Date(date.getTime() + ms);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let testDb: TestDatabase;
let admin: postgres.Sql;
let schedulerClient: postgres.Sql;
let appClient: postgres.Sql;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceId: string;
let authUserId: string;

async function auditEvent(
  createdAt: Date,
  workspace: string | null = workspaceId,
): Promise<string> {
  const [row] = await admin`
    insert into audit_events (workspace_id, action, metadata, created_at)
    values (${workspace}, 'auth.login',
            ${admin.json({ ipAddress: "203.0.113.7", userAgent: "Safari" })},
            ${createdAt.toISOString()}::timestamptz)
    returning id`;
  return row!.id as string;
}

async function auditEventIds(): Promise<string[]> {
  const rows = await admin`select id from audit_events order by created_at`;
  return rows.map((row) => row.id as string);
}

// better-auth stores auth.* timestamps as UTC wall-clock values.
function utc(date: Date): string {
  return date.toISOString().slice(0, -1);
}

async function session(createdAt: Date, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into auth.session
      (id, expires_at, token, created_at, updated_at, ip_address, user_agent,
       user_id)
    values (${id}, ${utc(expiresAt)}::timestamp, ${randomUUID()},
            ${utc(createdAt)}::timestamp, ${utc(createdAt)}::timestamp,
            '203.0.113.7', 'Safari', ${authUserId})`;
  return id;
}

async function rateLimit(lastRequest: Date): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into auth.rate_limit (id, key, count, last_request)
    values (${id}, ${`203.0.113.7/sign-in/${id}`}, 1,
            ${lastRequest.getTime()})`;
  return id;
}

async function pairing(expiresAt: Date): Promise<string> {
  const [row] = await admin`
    insert into device_pairings
      (code_hash, poll_secret_hash, client_key, expires_at)
    values (${randomUUID()}, 'p', 'hashed-ip',
            ${expiresAt.toISOString()}::timestamptz)
    returning id`;
  return row!.id as string;
}

async function ids(
  table: "auth.session" | "auth.rate_limit" | "device_pairings",
): Promise<string[]> {
  const rows = await admin.unsafe(`select id from ${table} order by id`);
  return rows.map((row) => row.id as string);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  appClient = postgres(testDb.appUrl, { max: 1 });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });

  const [workspace] =
    await admin`insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  authUserId = randomUUID();
  await admin`
    insert into auth.user (id, name, email, updated_at)
    values (${authUserId}, 'U', 'u@example.com', now())`;
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

beforeEach(async () => {
  await admin`delete from audit_events`;
  await admin`delete from auth.session`;
  await admin`delete from auth.rate_limit`;
  await admin`delete from device_pairings`;
});

describe("pruneSecurityRecords", () => {
  it("keeps audit events for 12 months", () => {
    expect(AUDIT_EVENT_RETENTION_MONTHS).toBe(12);
    expect(SECURITY_RETENTION.auditEventsMonths).toBe(12);
  });

  it("deletes audit events older than 12 months and keeps recent ones", async () => {
    const yearAndADay = await auditEvent(at(-12, -DAY));
    const justPast = await auditEvent(at(-12, -1000));
    const installation = await auditEvent(at(-14), null);
    const justInside = await auditEvent(at(-12, 1000));
    const lastMonth = await auditEvent(at(-1));
    const today = await auditEvent(at(0, -HOUR));

    const result = await pruneSecurityRecords(schedulerDb, NOW);

    expect(result.auditEventsDeleted).toBe(3);
    expect(await auditEventIds()).toEqual([justInside, lastMonth, today]);
    expect(await auditEventIds()).not.toContain(yearAndADay);
    expect(await auditEventIds()).not.toContain(justPast);
    expect(await auditEventIds()).not.toContain(installation);
  });

  it("cuts off by the clock it is given, not the database's", async () => {
    // A year-old event by the wall clock is recent by a clock in 2020.
    await admin`
      insert into audit_events (workspace_id, action, created_at)
      values (${workspaceId}, 'auth.login', now() - interval '13 months')`;
    const result = await pruneSecurityRecords(
      schedulerDb,
      new Date("2020-01-01T00:00:00.000Z"),
    );
    expect(result.auditEventsDeleted).toBe(0);
    expect(await auditEventIds()).toHaveLength(1);
  });

  it("deletes at most one batch per table per call", async () => {
    for (let i = 0; i < 5; i++) {
      await auditEvent(at(-13, -i * HOUR));
      await rateLimit(new Date(NOW.getTime() - 2 * DAY - i));
    }
    const recent = await auditEvent(at(-1));
    const policy: SecurityRetentionPolicy = { ...SECURITY_RETENTION, batch: 2 };

    const counts = [];
    for (let call = 0; call < 4; call++) {
      const result = await pruneSecurityRecords(schedulerDb, NOW, policy);
      counts.push([result.auditEventsDeleted, result.rateLimitsDeleted]);
    }

    expect(counts).toEqual([
      [2, 2],
      [2, 2],
      [1, 1],
      [0, 0],
    ]);
    expect(await auditEventIds()).toEqual([recent]);
    expect(await ids("auth.rate_limit")).toEqual([]);
  });

  it("deletes sessions a day after they expire and keeps live ones", async () => {
    const longExpired = await session(
      at(-1),
      new Date(NOW.getTime() - 2 * DAY),
    );
    const justExpired = await session(at(-1), new Date(NOW.getTime() - HOUR));
    const live = await session(at(0, -DAY), new Date(NOW.getTime() + 6 * DAY));

    const result = await pruneSecurityRecords(schedulerDb, NOW);

    expect(result.sessionsDeleted).toBe(1);
    expect(await ids("auth.session")).toEqual([justExpired, live].sort());
    expect(await ids("auth.session")).not.toContain(longExpired);
  });

  it("clears the sign-in IP and browser of sessions older than 12 months", async () => {
    const yearOld = await session(at(-13), new Date(NOW.getTime() + 6 * DAY));
    const recent = await session(at(-11), new Date(NOW.getTime() + 6 * DAY));

    const result = await pruneSecurityRecords(schedulerDb, NOW);

    expect(result.sessionAddressesCleared).toBe(1);
    const rows = await admin`
      select id, ip_address, user_agent from auth.session order by id`;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    // Still signed in; only the sign-in IP and browser are gone.
    expect(byId.get(yearOld)).toMatchObject({
      ip_address: null,
      user_agent: null,
    });
    expect(byId.get(recent)).toMatchObject({
      ip_address: "203.0.113.7",
      user_agent: "Safari",
    });
    // Already cleared rows are not counted again.
    const again = await pruneSecurityRecords(schedulerDb, NOW);
    expect(again.sessionAddressesCleared).toBe(0);
  });

  it("deletes rate-limit counters idle for a day and keeps active ones", async () => {
    await rateLimit(new Date(NOW.getTime() - DAY - 1000));
    const active = await rateLimit(new Date(NOW.getTime() - 60_000));

    const result = await pruneSecurityRecords(schedulerDb, NOW);

    expect(result.rateLimitsDeleted).toBe(1);
    expect(await ids("auth.rate_limit")).toEqual([active]);
  });

  it("deletes device pairings a day after they expire", async () => {
    await pairing(new Date(NOW.getTime() - 2 * DAY));
    const pending = await pairing(new Date(NOW.getTime() + 5 * 60_000));
    const justExpired = await pairing(new Date(NOW.getTime() - HOUR));

    const result = await pruneSecurityRecords(schedulerDb, NOW);

    expect(result.devicePairingsDeleted).toBe(1);
    expect(await ids("device_pairings")).toEqual([pending, justExpired].sort());
  });

  it("is callable by the scheduler role only", async () => {
    await expect(
      appClient`select * from prune_security_records(now(), '1 day', '1 day', 1)`,
    ).rejects.toThrow(/permission denied/);
  });

  it("leaves audit events append-only for the app role", async () => {
    await auditEvent(at(-13));
    await appClient`delete from audit_events`.catch(() => undefined);
    expect(await auditEventIds()).toHaveLength(1);
  });
});
