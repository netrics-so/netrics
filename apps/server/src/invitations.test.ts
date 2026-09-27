import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  invitationListResponseSchema,
  invitationPreviewResponseSchema,
  invitationResponseSchema,
  memberListResponseSchema,
  workspaceListResponseSchema,
  type WorkspaceRole,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  issueSetupToken,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { INVITATION_TOKEN_HEADER, createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import type { InvitationEmail, Mailer } from "./mail/mailer.js";
import { SETUP_TOKEN_HEADER, hashSetupToken } from "./setup.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface Instance {
  app: FastifyInstance;
  db: Database;
  admin: Sql;
  sent: InvitationEmail[];
}

const instances: Instance[] = [];

/** `delivers`: whether the mailer "sends" (captured) or links are manual. */
async function createInstance(opts: {
  signup: "open" | "closed";
  delivers: boolean;
}): Promise<Instance> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    NETRICS_SIGNUP: opts.signup,
  });
  const db = createDatabase(testDb.appUrl);
  const sent: InvitationEmail[] = [];
  const mailer: Mailer = {
    delivers: opts.delivers,
    sendVerificationEmail: async () => {},
    sendPasswordResetEmail: async () => {},
    sendInvitationEmail: async (email) => {
      sent.push(email);
    },
  };
  const app = await buildApp(config, {
    db,
    mailer,
    checkDb: async () => true,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
      mailer,
    }),
  });
  const instance = {
    app,
    db,
    admin: createRawSqlClient(testDb.adminUrl, { max: 1 }),
    sent,
  };
  instances.push(instance);
  return instance;
}

afterAll(async () => {
  for (const { app, db, admin } of instances) {
    await app.close();
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
});

function call(
  app: FastifyInstance,
  method: InjectOptions["method"],
  url: string,
  cookie?: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function signUp(
  app: FastifyInstance,
  email: string,
  headers: Record<string, string> = {},
): Promise<{ response: InjectResponse; cookie: string | null }> {
  const response = await call(
    app,
    "POST",
    "/api/auth/sign-up/email",
    undefined,
    { name: email.split("@")[0]!, email, password: "password-12345" },
    headers,
  );
  const header = response.headers["set-cookie"];
  const cookie =
    (Array.isArray(header) ? header : [header])
      .find((c) => c?.startsWith("better-auth.session_token="))
      ?.split(";")[0] ?? null;
  return { response, cookie };
}

async function firstWorkspaceId(app: FastifyInstance, cookie: string) {
  const response = await call(app, "GET", "/v1/workspaces", cookie);
  return workspaceListResponseSchema.parse(response.json()).workspaces[0]!.id;
}

async function invite(
  app: FastifyInstance,
  cookie: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole = "viewer",
) {
  return call(
    app,
    "POST",
    `/v1/workspaces/${workspaceId}/invitations`,
    cookie,
    {
      email,
      role,
    },
  );
}

function tokenOf(response: InjectResponse): string {
  const { inviteUrl } = invitationResponseSchema.parse(response.json());
  return new URL(inviteUrl!).pathname.split("/").pop()!;
}

describe("invitation lifecycle (manual delivery)", () => {
  let inst: Instance;
  let owner: string;
  let workspaceId: string;

  beforeAll(async () => {
    inst = await createInstance({ signup: "open", delivers: false });
    owner = (await signUp(inst.app, "owner@example.com")).cookie!;
    await call(inst.app, "POST", "/v1/bootstrap", owner, {
      workspaceName: "Acme",
    });
    workspaceId = await firstWorkspaceId(inst.app, owner);
  }, 60_000);

  it("returns a link for the admin to hand over and lists the invitation", async () => {
    const response = await invite(
      inst.app,
      owner,
      workspaceId,
      "Alice@Example.com",
      "editor",
    );
    expect(response.statusCode).toBe(200);
    const { invitation, inviteUrl } = invitationResponseSchema.parse(
      response.json(),
    );
    expect(invitation).toMatchObject({
      email: "alice@example.com",
      role: "editor",
      delivery: "manual",
    });
    expect(inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[\w-]{43}$/);

    const list = await call(
      inst.app,
      "GET",
      `/v1/workspaces/${workspaceId}/invitations`,
      owner,
    );
    expect(
      invitationListResponseSchema
        .parse(list.json())
        .invitations.map((i) => i.email),
    ).toContain("alice@example.com");
  });

  it("previews publicly by token and 404s unknown tokens", async () => {
    const token = tokenOf(
      await invite(inst.app, owner, workspaceId, "bob@example.com"),
    );
    const preview = await call(inst.app, "GET", `/v1/invitations/${token}`);
    expect(invitationPreviewResponseSchema.parse(preview.json())).toMatchObject(
      {
        workspaceName: "Acme",
        email: "bob@example.com",
        role: "viewer",
        status: "pending",
      },
    );
    for (const bad of ["x".repeat(43), "not a token!", "a"]) {
      const response = await call(
        inst.app,
        "GET",
        `/v1/invitations/${encodeURIComponent(bad)}`,
      );
      expect(response.statusCode).toBe(404);
    }
  });

  it("grants the membership only to the matching account, once", async () => {
    const token = tokenOf(
      await invite(inst.app, owner, workspaceId, "carol@example.com", "editor"),
    );
    const mallory = (await signUp(inst.app, "mallory@example.com")).cookie!;
    const stolen = await call(
      inst.app,
      "POST",
      `/v1/invitations/${token}/accept`,
      mallory,
    );
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json()).toEqual({ error: "invitation_email_mismatch" });

    const carol = (await signUp(inst.app, "carol@example.com")).cookie!;
    const accepted = await call(
      inst.app,
      "POST",
      `/v1/invitations/${token}/accept`,
      carol,
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ workspaceId });
    // Accepting again is idempotent for the same account…
    expect(
      (await call(inst.app, "POST", `/v1/invitations/${token}/accept`, carol))
        .statusCode,
    ).toBe(200);
    // …and final for everyone else.
    const reuse = await call(
      inst.app,
      "POST",
      `/v1/invitations/${token}/accept`,
      mallory,
    );
    expect(reuse.statusCode).toBe(410);

    const members = memberListResponseSchema.parse(
      (
        await call(
          inst.app,
          "GET",
          `/v1/workspaces/${workspaceId}/members`,
          owner,
        )
      ).json(),
    ).members;
    expect(members.find((m) => m.email === "carol@example.com")?.role).toBe(
      "editor",
    );
    expect(members.some((m) => m.email === "mallory@example.com")).toBe(false);
    expect(
      (await invite(inst.app, owner, workspaceId, "carol@example.com"))
        .statusCode,
    ).toBe(409);
  });

  it("requires a session to accept", async () => {
    const token = tokenOf(
      await invite(inst.app, owner, workspaceId, "dave@example.com"),
    );
    expect(
      (await call(inst.app, "POST", `/v1/invitations/${token}/accept`))
        .statusCode,
    ).toBe(401);
  });

  it("revoked, re-issued and expired invitations cannot be accepted", async () => {
    const erin = (await signUp(inst.app, "erin@example.com")).cookie!;
    const first = tokenOf(
      await invite(inst.app, owner, workspaceId, "erin@example.com"),
    );
    // Inviting again rotates the token: the first link is revoked.
    const second = await invite(
      inst.app,
      owner,
      workspaceId,
      "erin@example.com",
    );
    const secondToken = tokenOf(second);
    expect(
      (
        await call(inst.app, "POST", `/v1/invitations/${first}/accept`, erin)
      ).json(),
    ).toEqual({ error: "invitation_revoked" });

    const { invitation } = invitationResponseSchema.parse(second.json());
    expect(
      (
        await call(
          inst.app,
          "DELETE",
          `/v1/workspaces/${workspaceId}/invitations/${invitation.id}`,
          owner,
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await call(
          inst.app,
          "POST",
          `/v1/invitations/${secondToken}/accept`,
          erin,
        )
      ).statusCode,
    ).toBe(410);

    const third = tokenOf(
      await invite(inst.app, owner, workspaceId, "erin@example.com"),
    );
    await inst.admin`
      update invitations set expires_at = now() - interval '1 minute'
      where email = 'erin@example.com' and revoked_at is null
    `;
    const expired = await call(
      inst.app,
      "POST",
      `/v1/invitations/${third}/accept`,
      erin,
    );
    expect(expired.json()).toEqual({ error: "invitation_expired" });
  });

  it("enforces who may invite whom", async () => {
    const viewerToken = tokenOf(
      await invite(inst.app, owner, workspaceId, "vic@example.com", "viewer"),
    );
    const vic = (await signUp(inst.app, "vic@example.com")).cookie!;
    await call(inst.app, "POST", `/v1/invitations/${viewerToken}/accept`, vic);
    expect(
      (await invite(inst.app, vic, workspaceId, "x@example.com")).statusCode,
    ).toBe(403);

    const adminToken = tokenOf(
      await invite(inst.app, owner, workspaceId, "ada@example.com", "admin"),
    );
    const ada = (await signUp(inst.app, "ada@example.com")).cookie!;
    await call(inst.app, "POST", `/v1/invitations/${adminToken}/accept`, ada);
    expect(
      (await invite(inst.app, ada, workspaceId, "y@example.com", "owner"))
        .statusCode,
    ).toBe(403);
    expect(
      (await invite(inst.app, ada, workspaceId, "y@example.com", "editor"))
        .statusCode,
    ).toBe(200);
  });

  it("does not let another workspace's admin see or revoke invitations", async () => {
    const other = (await signUp(inst.app, "other-owner@example.com")).cookie!;
    await call(inst.app, "POST", "/v1/workspaces", other, { name: "Other" });
    const otherWorkspace = await firstWorkspaceId(inst.app, other);
    const { invitation } = invitationResponseSchema.parse(
      (await invite(inst.app, owner, workspaceId, "zed@example.com")).json(),
    );
    expect(
      (
        await call(
          inst.app,
          "DELETE",
          `/v1/workspaces/${otherWorkspace}/invitations/${invitation.id}`,
          other,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          inst.app,
          "GET",
          `/v1/workspaces/${workspaceId}/invitations`,
          other,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("email delivery", () => {
  it("emails the link and never returns it to the admin", async () => {
    const inst = await createInstance({ signup: "open", delivers: true });
    const owner = (await signUp(inst.app, "owner@example.com")).cookie!;
    await call(inst.app, "POST", "/v1/bootstrap", owner, {
      workspaceName: "Mailed",
    });
    const workspaceId = await firstWorkspaceId(inst.app, owner);
    const response = await invite(
      inst.app,
      owner,
      workspaceId,
      "m@example.com",
    );
    expect(response.statusCode).toBe(200);
    const body = invitationResponseSchema.parse(response.json());
    expect(body.inviteUrl).toBeNull();
    expect(body.invitation.delivery).toBe("email");
    expect(inst.sent).toHaveLength(1);
    expect(inst.sent[0]).toMatchObject({
      to: "m@example.com",
      workspaceName: "Mailed",
      inviterName: "owner",
    });
    expect(inst.sent[0]!.url).toMatch(/\/invite\/[\w-]{43}$/);
  }, 60_000);
});

describe("closed sign-up", () => {
  it("lets exactly the invited address create an account with the token", async () => {
    const inst = await createInstance({ signup: "closed", delivers: true });
    // No account yet and no token: sign-up is closed.
    expect(
      (await signUp(inst.app, "owner@example.com")).response.statusCode,
    ).toBe(403);

    // The owner comes in through setup (flow covered in setup.test.ts).
    await issueSetupToken(
      inst.db,
      hashSetupToken("setup-token-0123456789abcdef"),
    );
    const owner = (
      await signUp(inst.app, "owner@example.com", {
        [SETUP_TOKEN_HEADER]: "setup-token-0123456789abcdef",
      })
    ).cookie!;
    await call(inst.app, "POST", "/v1/workspaces", owner, { name: "Closed" });
    const workspaceId = await firstWorkspaceId(inst.app, owner);

    await invite(inst.app, owner, workspaceId, "new@example.com", "editor");
    const token = new URL(inst.sent.at(-1)!.url).pathname.split("/").pop()!;

    // Without the token, or for another address, sign-up stays closed.
    expect(
      (await signUp(inst.app, "new@example.com")).response.statusCode,
    ).toBe(403);
    expect(
      (
        await signUp(inst.app, "someone-else@example.com", {
          [INVITATION_TOKEN_HEADER]: token,
        })
      ).response.statusCode,
    ).toBe(403);

    const created = await signUp(inst.app, "new@example.com", {
      [INVITATION_TOKEN_HEADER]: token,
    });
    expect(created.response.statusCode).toBe(200);
    // The emailed token proves the mailbox: the address counts as verified.
    const [row] = await inst.admin<{ email_verified: boolean }[]>`
      select email_verified from auth."user" where email = 'new@example.com'
    `;
    expect(row!.email_verified).toBe(true);

    const accepted = await call(
      inst.app,
      "POST",
      `/v1/invitations/${token}/accept`,
      created.cookie!,
    );
    expect(accepted.statusCode).toBe(200);
  }, 60_000);
});
