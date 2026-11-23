import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { workspaceResponseSchema } from "@netrics/contracts";
import type { Job, Sql } from "@netrics/database";

import { createConnectionService } from "./connections/service.js";
import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { OAuthProviders } from "./oauth/config.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";
import { createItemsFixture, type ItemsFixture } from "./test-items.js";

// #839: a request that resolved its access (or a screen its token) while
// the workspace was there, and reaches its service after the deletion
// committed, or after the purge removed the workspace altogether, is
// answered like one for an unknown workspace: 404 workspace_not_found (401
// for a screen), never a 5xx from a service that took the failure for one
// of its own. The moment is forced: access resolution is wrapped so the
// deletion runs right after it succeeded, inside the request.

const between = vi.hoisted(() => ({
  /** Runs once, right after the next access (or token) resolution. */
  next: null as null | (() => Promise<void>),
}));

async function runBetween(): Promise<void> {
  const run = between.next;
  if (!run) return;
  between.next = null;
  await run();
}

vi.mock("./routes/access.js", async (importActual) => {
  const actual = await importActual<typeof import("./routes/access.js")>();
  return {
    ...actual,
    resolveAccess: async (...args: Parameters<typeof actual.resolveAccess>) => {
      const access = await actual.resolveAccess(...args);
      if (access) await runBetween();
      return access;
    },
  };
});

vi.mock("@netrics/database", async (importActual) => {
  const actual = await importActual<typeof import("@netrics/database")>();
  return {
    ...actual,
    resolvePrincipalToken: async (
      ...args: Parameters<typeof actual.resolvePrincipalToken>
    ) => {
      const token = await actual.resolvePrincipalToken(...args);
      if (token) await runBetween();
      return token;
    },
  };
});

let fixture: ItemsFixture;
let admin: Sql;
let purge: ReturnType<typeof createJobHandlers>[string];

type Moment = "deleted" | "purged";
const MOMENTS: Moment[] = ["deleted", "purged"];

/** Every GET of a workspace in the API, other ids made up. */
const READS: string[] = (() => {
  const document = JSON.parse(
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../packages/contracts/openapi.json",
      ),
      "utf8",
    ),
  ) as { paths: Record<string, Record<string, unknown>> };
  return (
    Object.entries(document.paths)
      .filter(
        ([route, methods]) =>
          route.startsWith("/v1/workspaces/{workspaceId}") && "get" in methods,
      )
      .map(([route]) => route.replace("/v1/workspaces/{workspaceId}", ""))
      // Answers from the installation's configuration alone: nothing of the
      // workspace is read, so there is nothing to refuse.
      .filter((route) => route !== "/custom-api/oauth")
  );
})();

/** One write per service. */
const WRITES: Array<[string, Record<string, unknown>]> = [
  ["/projects", { name: "Late" }],
  ["/invitations", { email: "late@example.com", role: "viewer" }],
  ["/demo", {}],
  ["/dashboards", { name: "Late" }],
  ["/themes", { name: "Late", base: "paper" }],
  ["/custom-api/drafts", {}],
  // (`code` is replaced by one of a pairing that waits for approval.)
  ["/devices/approve", { code: "", name: "Late", dashboardId: null }],
  ["/delete", { name: "Gone" }],
];

async function newWorkspace(): Promise<string> {
  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: fixture.owner },
    payload: { name: "Gone" },
  });
  expect(created.statusCode, created.body).toBe(200);
  return workspaceResponseSchema.parse(created.json()).workspace.id;
}

let pairings = 0;
async function pairingCode(): Promise<string> {
  pairings += 1;
  const started = await fixture.app.inject({
    method: "POST",
    url: "/v1/device/pairings",
    remoteAddress: `198.51.100.${pairings}`,
  });
  expect(started.statusCode, started.body).toBe(200);
  return (started.json() as { code: string }).code;
}

/** Deletes the workspace; for "purged" also runs its purge to the end. */
async function remove(workspaceId: string, moment: Moment): Promise<void> {
  const deleted = await fixture.app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/delete`,
    headers: { cookie: fixture.owner },
    payload: { name: "Gone" },
  });
  expect(deleted.statusCode, deleted.body).toBe(204);
  if (moment === "deleted") return;
  await purge({
    job: {
      id: randomUUID(),
      kind: "workspace.purge",
      workspaceId: null,
      connectionId: null,
      attempts: 0,
      payload: { purge_workspace_id: workspaceId },
    } as unknown as Job,
    appDb: fixture.db,
    schedulerDb: fixture.db,
    logger: pino({ level: "silent" }),
  });
  const [row] = await admin`
    select 1 from workspaces where id = ${workspaceId}`;
  expect(row).toBeUndefined();
}

/** The request, with the workspace removed right after its access check. */
async function across(
  moment: Moment,
  method: "GET" | "POST",
  route: string,
  payload?: Record<string, unknown>,
) {
  const workspaceId = await newWorkspace();
  let removed = false;
  between.next = async () => {
    await remove(workspaceId, moment);
    removed = true;
  };
  try {
    const response = await fixture.app.inject({
      method,
      url: `/v1/workspaces/${workspaceId}${route
        .replace("{version}", "1")
        .replace(/\{\w+\}/g, () => randomUUID())}`,
      headers: { cookie: fixture.owner },
      ...(payload
        ? {
            payload:
              "code" in payload
                ? { ...payload, code: await pairingCode() }
                : payload,
          }
        : {}),
    });
    return { response, removed };
  } finally {
    between.next = null;
  }
}

beforeAll(async () => {
  fixture = await createItemsFixture("wsgone");
  admin = fixture.admin;
  const registry = createDefaultRegistry();
  const credentialKeyring = createCredentialKeyring(
    Buffer.alloc(32, 7).toString("base64"),
  );
  const connections = createConnectionService({
    db: fixture.db,
    registry,
    credentialKeyring,
    oauthProviders: new OAuthProviders([]),
  });
  purge = createJobHandlers({
    registry,
    credentialKeyring,
    purgeConnection: (workspaceId, connectionId) =>
      connections.removeForPurge(workspaceId, connectionId),
  })["workspace.purge"]!;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe.each(MOMENTS)(
  "a request overtaken by its workspace being %s",
  (moment) => {
    it("covers every read route of the API", () => {
      expect(READS.length).toBeGreaterThan(45);
    });

    it.each(READS)("GET %s", async (route) => {
      const { response, removed } = await across(moment, "GET", route);
      // A route that refuses its input before it resolves access never got
      // that far; everything else is the unknown workspace.
      if (!removed) {
        expect(response.statusCode, response.body).toBe(400);
        return;
      }
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({ error: "workspace_not_found" });
    });

    it.each(WRITES)("POST %s", async (route, payload) => {
      const { response, removed } = await across(
        moment,
        "POST",
        route,
        payload,
      );
      if (!removed) {
        expect(response.statusCode, response.body).toBe(400);
        return;
      }
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({ error: "workspace_not_found" });
    });

    it("a screen's request is answered 401", async () => {
      // pairScreen pairs in the fixture's own workspace: a screen there, and
      // that workspace removed under its request.
      const local = await createItemsFixture(`wsgone-${moment}`);
      try {
        const { token } = await local.pairScreen(null);
        // An owner's only workspace is not deleted (#855).
        const spare = await local.app.inject({
          method: "POST",
          url: "/v1/workspaces",
          headers: { cookie: local.owner },
          payload: { name: "Spare" },
        });
        expect(spare.statusCode, spare.body).toBe(200);
        between.next = async () => {
          const deleted = await local.app.inject({
            method: "POST",
            url: `/v1/workspaces/${local.workspaceId}/delete`,
            headers: { cookie: local.owner },
            payload: { name: "Items" },
          });
          expect(deleted.statusCode, deleted.body).toBe(204);
          if (moment === "purged") {
            // No connections here: the workspace row goes with its cascade.
            await local.admin`
            delete from workspaces where id = ${local.workspaceId}`;
          }
        };
        const response = await local.app.inject({
          method: "GET",
          url: "/v1/device/dashboard",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(between.next).toBeNull();
        expect(response.statusCode, response.body).toBe(401);
        expect(response.json()).toEqual({ error: "unauthorized" });
      } finally {
        between.next = null;
        await local.close();
      }
    });
  },
);
