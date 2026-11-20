import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureDefinition } from "@netrics/connectors/custom-api/testing";
import {
  createDatabase,
  createWorkspace,
  insertConnection,
  insertCustomApiDefinition,
  schema,
  withWorkspace,
  type Database,
} from "@netrics/database";

import { createDefaultRegistry } from "./connectors.js";
import { requestOperatorBackfill } from "./operator-backfill.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

const registry = createDefaultRegistry();

let appDb: Database;
let ownerDb: Database;
let workspaceId: string;
let otherWorkspaceId: string;
const connectionId = randomUUID();
const pendingConnectionId = randomUUID();

beforeAll(async () => {
  const testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "operator@example.com", displayName: "Operator" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Backfill",
    ownerUserId: user!.id,
  });
  otherWorkspaceId = await createWorkspace(appDb, {
    name: "Other",
    ownerUserId: user!.id,
  });
  await withWorkspace(appDb, { workspaceId }, (tx) =>
    tx.insert(schema.connections).values([
      { id: connectionId, workspaceId, connectorId: "demo", name: "demo" },
      {
        id: pendingConnectionId,
        workspaceId,
        connectorId: "demo",
        name: "pending",
        setupPending: true,
      },
    ]),
  );
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await ownerDb.$client.end({ timeout: 5 }).catch(() => undefined);
});

async function backfillJobs() {
  return withWorkspace(appDb, { workspaceId }, (tx) =>
    tx
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.connectionId, connectionId),
          eq(schema.jobs.kind, "connection.backfill"),
        ),
      ),
  );
}

describe("requestOperatorBackfill", () => {
  it("queues one backfill and audits it without an actor", async () => {
    const result = await requestOperatorBackfill(ownerDb, registry, {
      workspaceId,
      connectionId,
    });
    expect(result).toMatchObject({ ok: true, connectorId: "demo" });
    const jobs = await backfillJobs();
    expect(jobs).toEqual([
      { id: (result as { jobId: string }).jobId, status: "pending" },
    ]);
    const events = await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "connection.backfill_requested")),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: null,
      target: connectionId,
    });
  });

  it("supersedes a backfill that is still waiting when asked again", async () => {
    const result = await requestOperatorBackfill(ownerDb, registry, {
      workspaceId,
      connectionId,
    });
    expect(result.ok).toBe(true);
    const jobs = await backfillJobs();
    expect(jobs.filter((job) => job.status === "pending")).toEqual([
      { id: (result as { jobId: string }).jobId, status: "pending" },
    ]);
  });

  it("refuses a connection of another workspace, and one still in setup", async () => {
    expect(
      await requestOperatorBackfill(ownerDb, registry, {
        workspaceId: otherWorkspaceId,
        connectionId,
      }),
    ).toEqual({ ok: false, reason: "no such connection in this workspace" });
    const pending = await requestOperatorBackfill(ownerDb, registry, {
      workspaceId,
      connectionId: pendingConnectionId,
    });
    expect(pending.ok).toBe(false);
  });

  it("finds a custom-api connection by its pin, not the registry (ADR 0027)", async () => {
    const id = randomUUID();
    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      const document = fixtureDefinition("pages", "https://127.0.0.1:4443");
      const stored = await insertCustomApiDefinition(tx, workspaceId, {
        id: randomUUID(),
        projectId: null,
        name: document.name,
        createdBy: null,
        document: document as unknown as Record<string, unknown>,
        documentSha256: "0".repeat(64),
        schemaVersion: 1,
        datasetVersions: { items: 1 },
      });
      await insertConnection(tx, {
        id,
        workspaceId,
        connectorId: "custom-api",
        name: "custom",
        config: {},
        credentialsEncrypted: null,
        projectId: null,
        pollIntervalSeconds: 3600,
        customApi: {
          definitionVersionId: stored.version.id,
          environmentId: "production",
        },
      });
    });
    expect(registry.get("custom-api")).toBeUndefined();
    const result = await requestOperatorBackfill(appDb, registry, {
      workspaceId,
      connectionId: id,
    });
    expect(result).toMatchObject({ ok: true, connectorId: "custom-api" });
  });
});
