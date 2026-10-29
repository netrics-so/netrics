import type { ConnectionContext } from "@netrics/connector-sdk";
import {
  assertManifestCompatible,
  checkResultSchema,
  connectorManifestSchema,
  resourceSchema,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  APPLE_MAPS_MESSAGE,
  AppleAdsApiError,
  AppleAdsRateBudgetError,
  CHOOSE_AD_ACCOUNT_MESSAGE,
  NO_AD_ACCOUNTS_MESSAGE,
  NO_APP_STORE_ACCOUNT_MESSAGE,
  RESOURCE_KINDS,
  ROLE_MESSAGE,
  appleAdsManifest,
  createAppleAdsClient,
  createAppleAdsConnector,
  lostAccessMessage,
} from "./index.js";
import {
  createFakeAppleAds,
  jsonResponse,
  type FakeAppleAdsOptions,
  type FakeApiUser,
} from "./test-helpers.js";

// Offline contract tests of the Apple Ads connector (#373) on fixtures
// shaped after Apple's documentation (fixtures/*.json name their page;
// #370's captures confirm them before merge). Tokens are synthetic: the
// host exchanges real ones (apps/server tests).

const TOKEN = "apple-ads-access-token-user-a";
const OTHER_TOKEN = "apple-ads-access-token-user-b";
const US = "4100000001";
const EU = "4100000002";
const MAPS = "4100000003";

const USER_ONE: FakeApiUser = { tokens: [TOKEN], acls: "acls-one" };
const USER_SEVERAL: FakeApiUser = { tokens: [TOKEN], acls: "acls-several" };

const noSleep = async () => {};
const waits: number[] = [];
const recordSleep = async (ms: number) => {
  waits.push(ms);
};

function connector() {
  return createAppleAdsConnector({ sleep: recordSleep });
}

function context(
  config: Record<string, unknown> = { adAccountId: US },
  credentials: Record<string, unknown> = { accessToken: TOKEN },
  connectionId = "apple-ads-test",
): ConnectionContext {
  return { connectionId, config, credentials };
}

function fake(options: Partial<FakeAppleAdsOptions> = {}) {
  return createFakeAppleAds({ users: [USER_ONE], ...options });
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe("manifest", () => {
  it("is schema-valid and accepted by this SDK", () => {
    expect(connectorManifestSchema.safeParse(appleAdsManifest).success).toBe(
      true,
    );
    expect(() => assertManifestCompatible(appleAdsManifest)).not.toThrow();
  });

  it("reaches only the Platform API host, and names the signed-key provider", () => {
    expect(appleAdsManifest.outboundDomains).toEqual(["api.ads.apple.com"]);
    expect(appleAdsManifest.authStrategies).toEqual([
      { strategy: "signed-key", provider: "apple-ads" },
    ]);
  });

  it("keeps the ad account, its name, currency and time zone in the config, none required", () => {
    const schema = appleAdsManifest.configSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "adAccountId",
      "adAccountName",
      "currency",
      "timeZone",
    ]);
    expect(schema.required ?? []).toEqual([]);
  });
});

describe("check", () => {
  it("passes for an App Store ad account with an API role, without a context on /v1/acls", async () => {
    const api = fake();
    const result = await connector().check(context(), api.runtime);
    expect(checkResultSchema.parse(result)).toEqual({ ok: true });
    expect(api.requests.map((r) => [r.url.pathname, r.context])).toEqual([
      ["/v1/acls", undefined],
      [`/v1/ad-accounts/${US}`, `adAccountId=${US}`],
    ]);
    expect(api.requests.every((r) => r.token === TOKEN)).toBe(true);
  });

  it("passes in the preview, before an ad account is chosen, when one App Store account qualifies", async () => {
    const api = fake({ users: [USER_SEVERAL] });
    expect(await connector().check(context({}), api.runtime)).toEqual({
      ok: true,
    });
  });

  it("is auth_failed-worthy when the configured ad account left the ACL", async () => {
    const api = fake({ users: [{ tokens: [TOKEN], acls: "acls-lost" }] });
    expect(await connector().check(context(), api.runtime)).toEqual({
      ok: false,
      message: lostAccessMessage(US),
    });
    expect(lostAccessMessage(US)).toContain("no longer has access");
  });

  it("refuses a non-API role with the role message", async () => {
    const api = fake({
      users: [{ tokens: [TOKEN], acls: "acls-no-api-role" }],
    });
    expect(await connector().check(context(), api.runtime)).toEqual({
      ok: false,
      message: ROLE_MESSAGE,
    });
    expect(await connector().check(context({}), api.runtime)).toEqual({
      ok: false,
      message: ROLE_MESSAGE,
    });
  });

  it("refuses an API user without ad accounts", async () => {
    const api = fake({ users: [{ tokens: [TOKEN], acls: "acls-empty" }] });
    expect(await connector().check(context({}), api.runtime)).toEqual({
      ok: false,
      message: NO_AD_ACCOUNTS_MESSAGE,
    });
  });

  it("refuses an Apple Maps ad account", async () => {
    const api = fake({ users: [USER_SEVERAL] });
    expect(
      await connector().check(context({ adAccountId: MAPS }), api.runtime),
    ).toEqual({ ok: false, message: NO_APP_STORE_ACCOUNT_MESSAGE });
  });

  it("turns a 403 into the role message", async () => {
    const api = fake({
      failures: [{ status: 403, fixture: "error-forbidden" }],
    });
    expect(await connector().check(context(), api.runtime)).toEqual({
      ok: false,
      message: ROLE_MESSAGE,
    });
  });

  it("refuses a malformed ad account ID before any call", async () => {
    const api = fake();
    const result = await connector().check(
      context({ adAccountId: "41; x-evil: 1" }),
      api.runtime,
    );
    expect(result.ok).toBe(false);
    expect(api.requests).toHaveLength(0);
  });

  it("throws AccessTokenRejectedError on a 401, so the host re-exchanges once", async () => {
    const api = fake();
    const error = await connector()
      .check(context(undefined, { accessToken: "stale" }), api.runtime)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppleAdsApiError);
    expect((error as Error).name).toBe("AccessTokenRejectedError");
    expect((error as Error).message).toContain("UNAUTHORIZED");
  });

  it("has no token: asks for a key", async () => {
    const result = await connector().check(
      context(undefined, {}),
      fake().runtime,
    );
    expect(result.ok).toBe(false);
  });
});

describe("errors and rate limits", () => {
  it("honours a short Retry-After on 429 and then succeeds", async () => {
    waits.length = 0;
    const api = fake({
      failures: [
        {
          status: 429,
          fixture: "error-rate-limit",
          headers: { "retry-after": "7" },
        },
      ],
    });
    expect(await connector().check(context(), api.runtime)).toEqual({
      ok: true,
    });
    expect(waits).toEqual([7000]);
  });

  it("throws a retryable 429 when Retry-After is too long to wait in a call", async () => {
    const api = fake({
      failures: [
        {
          status: 429,
          fixture: "error-rate-limit",
          headers: { "retry-after": "600" },
        },
      ],
    });
    const error = (await connector()
      .check(context(), api.runtime)
      .catch((e: unknown) => e)) as AppleAdsApiError;
    expect(error).toBeInstanceOf(AppleAdsApiError);
    expect(error.status).toBe(429);
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(600);
    expect(api.requests).toHaveLength(1);
  });

  it("retries 5xx with backoff, then throws a retryable error", async () => {
    waits.length = 0;
    const failures = Array.from({ length: 3 }, () => ({
      status: 500,
      fixture: "error-internal",
    }));
    const error = (await connector()
      .check(context(), fake({ failures }).runtime)
      .catch((e: unknown) => e)) as AppleAdsApiError;
    expect(error.status).toBe(500);
    expect(error.isRetryable).toBe(true);
    expect(waits).toEqual([1000, 2000]);
  });

  it("shows Apple's error code and message on other errors", async () => {
    const api = fake({
      failures: [{ status: 400, fixture: "error-validation" }],
    });
    const message = await outcome(() =>
      connector().check(context(), api.runtime),
    );
    expect(message).toContain("VALIDATION_ERROR/INVALID_FIELD");
    expect(message).toContain("Unknown filter field");
  });

  it("stops before the window is used up (RateLimit-Remaining)", async () => {
    const api = fake({ remaining: 3 });
    const client = createAppleAdsClient(api.fetch, TOKEN, {
      signal: new AbortController().signal,
      sleep: noSleep,
    });
    await client.json("/v1/acls");
    expect(client.rateLimit).toEqual({
      limit: 100,
      remaining: 3,
      resetSeconds: 30,
    });
    const error = await client.json("/v1/acls").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppleAdsRateBudgetError);
    expect((error as AppleAdsRateBudgetError).resetSeconds).toBe(30);
    expect(api.requests).toHaveLength(1);
  });

  it("does not retry without a signal (validation probes)", async () => {
    const api = fake({
      failures: [
        { status: 429, headers: { "retry-after": "1" } },
        { status: 429 },
      ],
    });
    const client = createAppleAdsClient(api.fetch, TOKEN);
    const error = await client.json("/v1/acls").catch((e: unknown) => e);
    expect((error as AppleAdsApiError).status).toBe(429);
    expect(api.requests).toHaveLength(1);
  });

  it("refuses paths outside /v1 and malformed contexts", async () => {
    const client = createAppleAdsClient(fake().fetch, TOKEN);
    await expect(client.json("https://evil.example/v1/acls")).rejects.toThrow();
    await expect(
      client.json("/v1/campaigns/query", { adAccountId: "1\r\nx: y" }),
    ).rejects.toThrow("digits only");
  });
});

describe("discover", () => {
  it("lists the API user's ad accounts before one is chosen: App Store selectable, Apple Maps shown but not", async () => {
    const api = fake({ users: [USER_SEVERAL] });
    const resources = await connector().discover(context({}), api.runtime);
    for (const resource of resources) {
      expect(resourceSchema.safeParse(resource).success).toBe(true);
    }
    expect(
      resources.map(({ id, name, kind, metadata }) => ({
        id,
        name,
        kind,
        selectable: metadata?.selectable,
        reason: metadata?.reason,
        currency: metadata?.currency,
        timeZone: metadata?.timeZone,
        orgId: metadata?.orgId,
      })),
    ).toEqual([
      {
        id: US,
        name: "Example Apps US",
        kind: RESOURCE_KINDS.adAccount,
        selectable: true,
        reason: undefined,
        currency: "USD",
        timeZone: "America/Los_Angeles",
        orgId: "4000000001",
      },
      {
        id: EU,
        name: "Example Apps EU",
        kind: RESOURCE_KINDS.adAccount,
        selectable: true,
        reason: undefined,
        currency: "EUR",
        timeZone: "Europe/Berlin",
        orgId: "4000000002",
      },
      {
        id: MAPS,
        name: "Example Cafés on Maps",
        kind: RESOURCE_KINDS.adAccount,
        selectable: false,
        reason: APPLE_MAPS_MESSAGE,
        currency: "USD",
        timeZone: "America/Los_Angeles",
        orgId: "4000000001",
      },
    ]);
    expect(resources[1]!.metadata).toMatchObject({
      systemStatus: "INACTIVE",
      systemStatusReasons: ["ORG_NO_PAYMENT_METHOD_ON_FILE"],
      roles: ["Limited Access: API Read Only"],
    });
    // Each details call carries that account's own context.
    expect(
      api.requests
        .filter((r) => r.url.pathname.startsWith("/v1/ad-accounts/"))
        .map((r) => [
          r.url.pathname.slice("/v1/ad-accounts/".length),
          r.context,
        ]),
    ).toEqual([
      [US, `adAccountId=${US}`],
      [EU, `adAccountId=${EU}`],
      [MAPS, `adAccountId=${MAPS}`],
    ]);
  });

  it("lists an account without an API role without a details call", async () => {
    const api = fake({
      users: [{ tokens: [TOKEN], acls: "acls-no-api-role" }],
    });
    const [account] = await connector().discover(context({}), api.runtime);
    expect(account).toMatchObject({
      id: US,
      metadata: { selectable: false, reason: ROLE_MESSAGE },
    });
    expect(api.requests.map((r) => r.url.pathname)).toEqual(["/v1/acls"]);
  });

  it("names the configured account's promoted apps and campaigns, every call in its context", async () => {
    const api = fake();
    const resources = await connector().discover(context(), api.runtime);
    expect(resources.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual(
      [
        { id: "1000000001", name: "Wurfel", kind: "app" },
        { id: "1000000002", name: "Dicey", kind: "app" },
        { id: "5100000001", name: "Wurfel – Brand", kind: "campaign" },
        { id: "5100000002", name: "Wurfel – Discovery", kind: "campaign" },
        { id: "5100000003", name: "Dicey – Category", kind: "campaign" },
      ],
    );
    expect(resources[3]!.metadata).toEqual({
      adAccountId: US,
      appId: "1000000001",
      status: "PAUSED",
      displayStatus: "PAUSED",
    });
    expect(api.requests.every((r) => r.context === `adAccountId=${US}`)).toBe(
      true,
    );
    const query = api.requests.find(
      (r) => r.url.pathname === "/v1/campaigns/query",
    )!;
    expect(query.method).toBe("POST");
    expect(query.body).toMatchObject({
      filters: [
        {
          field: "promotedObjectType",
          operator: "EQUALS",
          value: "APPSTORE_APP",
        },
      ],
      pagination: { offset: 0, pageSize: 1000, fetchTotalCount: true },
    });
  });

  it("keeps campaigns whose app Apple does not name", async () => {
    const api = fake();
    const original = api.fetch;
    const resources = await connector().discover(context(), {
      signal: api.runtime.signal,
      fetch: async (url, init) =>
        url.includes("/v1/apps/1000000002")
          ? jsonResponse(404, {})
          : original(url, init),
    });
    expect(resources.filter((r) => r.kind === "app").map((r) => r.id)).toEqual([
      "1000000001",
    ]);
    expect(resources.filter((r) => r.kind === "campaign")).toHaveLength(3);
  });
});

describe("one ad account per connection", () => {
  it("two connections in one workspace never use each other's context or token", async () => {
    const api = fake({
      users: [
        { tokens: [TOKEN], acls: "acls-several" },
        { tokens: [OTHER_TOKEN], acls: "acls-lost" },
      ],
    });
    const us = context({ adAccountId: US }, { accessToken: TOKEN }, "conn-us");
    const eu = context(
      { adAccountId: EU },
      { accessToken: OTHER_TOKEN },
      "conn-eu",
    );
    const c = connector();
    await Promise.all([
      c.check(us, api.runtime),
      c.check(eu, api.runtime),
      c.discover(us, api.runtime),
      c.discover(eu, api.runtime),
    ]);
    const scoped = api.requests.filter((r) => r.url.pathname !== "/v1/acls");
    expect(scoped.length).toBeGreaterThan(4);
    for (const request of scoped) {
      expect(request.context).toBe(
        request.token === TOKEN ? `adAccountId=${US}` : `adAccountId=${EU}`,
      );
    }
    const euNames = (await c.discover(eu, api.runtime)).map((r) => r.name);
    expect(euNames).toContain("Wurfel – DE Brand");
    expect(euNames).not.toContain("Wurfel – Brand");
  });

  it("a token cannot read an account outside its ACL (403), whatever the config says", async () => {
    const api = fake({ users: [{ tokens: [TOKEN], acls: "acls-lost" }] });
    const error = await connector()
      .discover(context({ adAccountId: US }), api.runtime)
      .catch((e: unknown) => e);
    expect((error as AppleAdsApiError).status).toBe(403);
  });
});

describe("sync", () => {
  it("asks for an ad account before it reads anything", async () => {
    await expect(
      connector().sync(
        context({}),
        {
          mode: "incremental",
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-02T00:00:00.000Z",
        },
        fake().runtime,
      ),
    ).rejects.toThrow(CHOOSE_AD_ACCOUNT_MESSAGE);
  });

  it("reads the campaign report only in the configured ad account's context (#374)", async () => {
    const api = fake();
    // A fixed clock: the window is the day before.
    const result = await createAppleAdsConnector({
      sleep: noSleep,
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
    }).sync(
      context(),
      {
        mode: "incremental",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
      },
      api.runtime,
    );
    expect(result.done).toBe(true);
    const reports = api.requests.filter(
      (r) => r.url.pathname === "/v1/reports/apps/campaigns/query",
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.context).toBe(`adAccountId=${US}`);
      expect(request.token).toBe(TOKEN);
    }
  });
});

describe("secrets", () => {
  it("never puts the access token in a result or an error", async () => {
    const outcomes = await Promise.all([
      outcome(() => connector().check(context(), fake().runtime)),
      outcome(() =>
        connector().check(
          context(),
          fake({ failures: [{ status: 403, fixture: "error-forbidden" }] })
            .runtime,
        ),
      ),
      outcome(() =>
        connector().check(
          context(),
          fake({
            failures: [{ status: 429, headers: { "retry-after": "99" } }],
          }).runtime,
        ),
      ),
      outcome(() => connector().discover(context(), fake().runtime)),
    ]);
    for (const text of outcomes) {
      expect(text).not.toContain(TOKEN);
    }
  });
});
