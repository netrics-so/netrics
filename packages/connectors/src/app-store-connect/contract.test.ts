import type { ConnectionContext } from "@netrics/connector-sdk";
import {
  assertManifestCompatible,
  checkResultSchema,
  connectorManifestSchema,
  resourceSchema,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  AGREEMENTS_MESSAGE,
  APPS_PAGE_SIZE,
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  KEY_MISMATCH_MESSAGE,
  ROLE_MESSAGE,
  VENDOR_NUMBER_FORMAT_MESSAGE,
  appStoreConnectManifest,
  createAppStoreConnectClient,
  createAppStoreConnectConnector,
  latestReportDate,
  parseRateLimit,
  probeSalesReport,
  vendorNumberMessage,
} from "./index.js";
import {
  createFakeAppStoreConnect,
  fixture,
  type FakeAppStoreConnectOptions,
  type FakeTeam,
} from "./test-helpers.js";

// Synthetic tokens: the host signs real ES256 JWTs (apps/server tests); the
// connector only forwards whatever bearer token it is handed.
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.team-a-token.c2lnbmF0dXJl";
const OTHER_TOKEN = "eyJhbGciOiJFUzI1NiJ9.team-b-token.c2lnbmF0dXJl";
const VENDOR = "85012345";
// 2026-10-01 18:00 UTC is 11:00 PDT: Sept 29 is the latest published day.
const NOW = Date.parse("2026-10-01T18:00:00.000Z");
const LATEST_DAY = "2026-09-29";

const TEAM_A: FakeTeam = {
  tokens: [TOKEN],
  appPages: [fixture("apps-page-1"), fixture("apps-page-2")],
  vendorNumbers: [VENDOR],
  salesDays: [LATEST_DAY],
};

function connector() {
  return createAppStoreConnectConnector({ now: () => NOW });
}

function context(
  config: Record<string, unknown> = { vendorNumber: VENDOR },
  credentials: Record<string, unknown> = { accessToken: TOKEN },
): ConnectionContext {
  return { connectionId: "asc-test", config, credentials };
}

function fake(options: Partial<FakeAppStoreConnectOptions> = {}) {
  return createFakeAppStoreConnect({ teams: [TEAM_A], ...options });
}

/** Everything a call returned or threw, for leak checks. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe("manifest", () => {
  const manifest = appStoreConnectManifest;

  it("is schema-valid and accepted by this SDK", () => {
    expect(connectorManifestSchema.safeParse(manifest).success).toBe(true);
    expect(() => assertManifestCompatible(manifest)).not.toThrow();
  });

  it("signs with the host's App Store Connect key and reaches only Apple's API", () => {
    expect(manifest.id).toBe("app-store-connect");
    expect(manifest.authStrategies).toEqual([
      { strategy: "signed-key", provider: "app-store-connect" },
    ]);
    expect(manifest.outboundDomains).toEqual(["api.appstoreconnect.apple.com"]);
    expect(manifest.rateLimit).toEqual({
      maxRequests: 3500,
      windowSeconds: 3600,
      scope: "key",
    });
  });

  it("asks for the vendor number as config, not as a credential", () => {
    expect(manifest.configSchema).toMatchObject({
      properties: { vendorNumber: { type: "string" } },
      required: ["vendorNumber"],
      additionalProperties: false,
    });
  });
});

describe("discovery", () => {
  it("lists every app across pages, keyed by Apple ID, with platforms as a label", async () => {
    const api = fake();
    const resources = await connector().discover(context(), api.runtime);
    for (const resource of resources) {
      expect(resourceSchema.safeParse(resource).success).toBe(true);
    }
    expect(resources).toEqual([
      {
        id: "1000000003",
        name: "Example Atlas",
        kind: "iOS, visionOS",
        metadata: {
          bundleId: "com.example.atlas",
          sku: "EXATLAS",
          platforms: ["IOS", "VISION_OS"],
        },
      },
      {
        id: "1000000004",
        name: "Example Draft",
        kind: "app",
        metadata: {
          bundleId: "com.example.draft",
          sku: "EXDRAFT",
          platforms: [],
        },
      },
      {
        id: "1000000001",
        name: "Example Field Notes",
        kind: "iOS, tvOS",
        metadata: {
          bundleId: "com.example.fieldnotes",
          sku: "EXFIELDNOTES",
          platforms: ["IOS", "TV_OS"],
        },
      },
      {
        id: "1000000002",
        name: "Example Ledger",
        kind: "macOS",
        metadata: {
          bundleId: "com.example.ledger",
          sku: "EXLEDGER",
          platforms: ["MAC_OS"],
        },
      },
    ]);

    // Page 1 asks for the fields; page 2 follows links.next as given.
    expect(api.requests).toHaveLength(2);
    const [first, second] = api.requests.map((request) => request.url);
    expect(first!.pathname).toBe("/v1/apps");
    expect(Object.fromEntries(first!.searchParams)).toEqual({
      "fields[apps]": "name,bundleId,sku,appStoreVersions",
      include: "appStoreVersions",
      "fields[appStoreVersions]": "platform",
      "limit[appStoreVersions]": "50",
      limit: String(APPS_PAGE_SIZE),
    });
    expect(second!.toString()).toBe(
      (fixture("apps-page-1") as { links: { next: string } }).links.next,
    );
    for (const request of api.requests) {
      expect(request.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("lists only the apps of the team whose key signed the token", async () => {
    const teamB: FakeTeam = {
      tokens: [OTHER_TOKEN],
      appPages: [
        {
          data: [
            {
              type: "apps",
              id: "2000000001",
              attributes: { name: "Other Team App", bundleId: "org.other.app" },
            },
          ],
          links: {},
        },
      ],
      vendorNumbers: ["86000001"],
    };
    const api = fake({ teams: [TEAM_A, teamB] });
    const a = await connector().discover(context(), api.runtime);
    const b = await connector().discover(
      context({ vendorNumber: "86000001" }, { accessToken: OTHER_TOKEN }),
      api.runtime,
    );
    expect(a.map((resource) => resource.id)).not.toContain("2000000001");
    expect(b.map((resource) => resource.id)).toEqual(["2000000001"]);
  });

  it("refuses to follow a next link to another host", async () => {
    const api = fake({
      teams: [
        {
          ...TEAM_A,
          appPages: [
            {
              data: [],
              links: { next: "https://evil.example.com/v1/apps?cursor=x" },
            },
          ],
        },
      ],
    });
    await expect(connector().discover(context(), api.runtime)).rejects.toThrow(
      /outside api\.appstoreconnect\.apple\.com/,
    );
    expect(api.requests).toHaveLength(1);
  });

  it("surfaces a refused token as AccessTokenRejectedError (the key is the problem)", async () => {
    const api = fake();
    const error = await connector()
      .discover(context({}, { accessToken: "revoked" }), api.runtime)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppStoreConnectApiError);
    expect((error as Error).name).toBe("AccessTokenRejectedError");
  });

  it("throws on 429 and 5xx so the job backs off", async () => {
    for (const [status, name] of [
      [429, "error-rate-limit"],
      [500, "error-unexpected"],
    ] as const) {
      const api = fake({ failures: [{ status, fixture: name }] });
      const error = await connector()
        .discover(context(), api.runtime)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AppStoreConnectApiError);
      expect((error as AppStoreConnectApiError).isRetryable).toBe(true);
    }
  });
});

describe("check: key, role and vendor number", () => {
  async function check(
    options: Partial<FakeAppStoreConnectOptions> = {},
    ctx = context(),
  ) {
    const api = fake(options);
    const result = await connector().check(ctx, api.runtime);
    expect(checkResultSchema.safeParse(result).success).toBe(true);
    return { result, requests: api.requests };
  }

  it("passes with a Sales key and a vendor number of the team", async () => {
    const { result, requests } = await check();
    expect(result).toEqual({ ok: true });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v1/apps",
      "/v1/salesReports",
    ]);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      limit: "1",
      "fields[apps]": "name",
    });
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual({
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[version]": "1_0",
      "filter[vendorNumber]": VENDOR,
      "filter[reportDate]": LATEST_DAY,
    });
    expect(requests[1]!.init?.headers?.accept).toBe(
      "application/a-gzip, application/json",
    );
  });

  it("passes when the latest day had no sales (404)", async () => {
    const { result } = await check({
      teams: [{ ...TEAM_A, salesDays: [] }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("passes on a 404 for a report that is not published yet", async () => {
    const api = fake({
      // The apps probe answers normally; the report answers 404.
      teams: [{ ...TEAM_A }],
    });
    const client = createAppStoreConnectClient(async (url, init) => {
      if (url.includes("/v1/salesReports")) {
        return {
          status: 404,
          headers: {},
          text: () => JSON.stringify(fixture("error-not-found-not-available")),
          json: () => fixture("error-not-found-not-available"),
          bytes: () => new Uint8Array(),
        };
      }
      return api.fetch(url, init);
    }, TOKEN);
    expect(
      await probeSalesReport(client, { vendorNumber: VENDOR }, NOW),
    ).toEqual({ ok: true });
  });

  it("401: the issuer ID, key ID and private key do not belong together, or the key was revoked", async () => {
    const { result, requests } = await check(
      {},
      context(undefined, { accessToken: "not-a-token-of-this-team" }),
    );
    expect(result).toEqual({ ok: false, message: KEY_MISMATCH_MESSAGE });
    expect(requests).toHaveLength(1);
  });

  it("403 on the sales report names the missing role", async () => {
    const { result } = await check({
      teams: [{ ...TEAM_A, role: "developer" }],
    });
    expect(result).toEqual({ ok: false, message: ROLE_MESSAGE });
    expect(ROLE_MESSAGE).toMatch(/Sales or Finance role/);
    expect(ROLE_MESSAGE).toMatch(/Admin also works, but grants more/);
  });

  it("403 for missing agreements says so instead of blaming the role", async () => {
    const { result } = await check({
      teams: [{ ...TEAM_A, agreementsMissing: true }],
    });
    expect(result).toEqual({ ok: false, message: AGREEMENTS_MESSAGE });
  });

  it("a vendor number of another team is reported as a wrong vendor number", async () => {
    const { result } = await check({}, context({ vendorNumber: "86999999" }));
    expect(result).toEqual({
      ok: false,
      message: vendorNumberMessage("86999999"),
    });
  });

  it("a malformed vendor number fails before any request", async () => {
    for (const vendorNumber of [undefined, "", "85-01", "abc", 85012345]) {
      const { result, requests } = await check({}, context({ vendorNumber }));
      expect(result.ok).toBe(false);
      expect(requests).toHaveLength(0);
    }
    const api = fake();
    expect(
      await probeSalesReport(
        createAppStoreConnectClient(api.fetch, TOKEN),
        { vendorNumber: "x" },
        NOW,
      ),
    ).toEqual({ ok: false, message: VENDOR_NUMBER_FORMAT_MESSAGE });
  });

  it("without a token it asks for a key", async () => {
    const { result, requests } = await check({}, context(undefined, {}));
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("429 and 5xx throw (retryable), on either probe", async () => {
    for (const failures of [
      [{ status: 429, fixture: "error-rate-limit" }],
      [{ status: 200 }, { status: 429, fixture: "error-rate-limit" }],
      [{ status: 503 }],
    ]) {
      const api = fake({ failures });
      const error = await connector()
        .check(context(), api.runtime)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AppStoreConnectApiError);
      expect((error as AppStoreConnectApiError).isRetryable).toBe(true);
    }
  });

  it("never puts the token into a result or an error", async () => {
    const cases: Array<Partial<FakeAppStoreConnectOptions>> = [
      {},
      { teams: [{ ...TEAM_A, role: "developer" }] },
      { teams: [{ ...TEAM_A, agreementsMissing: true }] },
      { teams: [{ ...TEAM_A, vendorNumbers: [] }] },
      { failures: [{ status: 429, fixture: "error-rate-limit" }] },
      { failures: [{ status: 500, fixture: "error-unexpected" }] },
      { failures: [{ status: 400, fixture: "error-invalid-vendor" }] },
      { remaining: 3 },
    ];
    for (const options of cases) {
      const api = fake(options);
      const results = [
        await outcome(() => connector().check(context(), api.runtime)),
        await outcome(() => connector().discover(context(), api.runtime)),
      ];
      for (const result of results) {
        expect(result).not.toContain(TOKEN);
        expect(result).not.toContain("team-a-token");
      }
    }
  });
});

describe("rate limit", () => {
  it("parses Apple's X-Rate-Limit header", () => {
    expect(parseRateLimit("user-hour-lim:3500;user-hour-rem:2499;")).toEqual({
      limit: 3500,
      remaining: 2499,
    });
    expect(parseRateLimit(undefined)).toEqual({});
    expect(parseRateLimit("garbage")).toEqual({});
  });

  it("stops before the next request when the hourly budget runs low", async () => {
    const api = fake({ remaining: 42 });
    const error = await connector()
      .discover(context(), api.runtime)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppStoreConnectRateBudgetError);
    // The first page answered; the second was never asked for.
    expect(api.requests).toHaveLength(1);
  });

  it("keeps going while the budget lasts", async () => {
    const api = fake({ remaining: 3000 });
    await expect(
      connector().discover(context(), api.runtime),
    ).resolves.toHaveLength(4);
  });
});

describe("latest report date (Pacific Time)", () => {
  it.each([
    // Before noon PDT: two days back; from noon on: yesterday.
    ["2026-10-01T18:00:00.000Z", "2026-09-29"],
    ["2026-10-01T19:00:00.000Z", "2026-09-30"],
    // Early UTC morning is still the previous evening in California.
    ["2026-10-02T03:00:00.000Z", "2026-09-30"],
    // PST in winter (UTC−8): 19:59 UTC is 11:59, 20:00 UTC is noon.
    ["2026-01-15T19:59:00.000Z", "2026-01-13"],
    ["2026-01-15T20:00:00.000Z", "2026-01-14"],
    // Across a month and a year boundary.
    ["2027-01-01T21:00:00.000Z", "2026-12-31"],
  ])("at %s it reads %s", (now, day) => {
    expect(latestReportDate(Date.parse(now))).toBe(day);
  });
});

describe("egress", () => {
  it("reaches api.appstoreconnect.apple.com over https and nothing else", async () => {
    const api = fake();
    await connector().check(context(), api.runtime);
    await connector().discover(context(), api.runtime);
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.url.protocol).toBe("https:");
      expect(request.url.hostname).toBe("api.appstoreconnect.apple.com");
    }
  });
});
