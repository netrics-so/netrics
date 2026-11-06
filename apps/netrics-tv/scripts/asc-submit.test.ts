import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AppStoreConnect,
  WHATS_NEW_MAX,
  buildNumber,
  createToken,
  isValidBuildNumber,
  parseTag,
  run,
  tokenParts,
  whatsNewFromReleaseNotes,
} from "./asc-submit.ts";

describe("parseTag", () => {
  it("reads the version of a netrics TV tag", () => {
    expect(parseTag("netrics-tv/v1.2.3")).toBe("1.2.3");
    expect(parseTag("netrics-tv/v0.10.0")).toBe("0.10.0");
  });

  it.each([
    "v1.2.3",
    "netrics-tv/1.2.3",
    "netrics-tv/v1.2",
    "netrics-tv/v1.2.3.4",
    "netrics-tv/v01.2.3",
    "netrics-tv/v1.2.3-beta.1",
    "netrics-tv/v1.2.3+5",
    "netrics-tv/v1.2.3 ",
    "",
  ])("refuses %j", (tag) => {
    expect(() => parseTag(tag)).toThrow(/not a netrics TV release tag/);
  });
});

describe("buildNumber", () => {
  it("is YYYYMMDD.HHMM in UTC without a leading zero in the time", () => {
    expect(buildNumber(new Date("2026-10-30T15:30:59Z"))).toBe("20261030.1530");
    expect(buildNumber(new Date("2026-01-02T09:05:00Z"))).toBe("20260102.905");
    expect(buildNumber(new Date("2026-01-02T00:00:00Z"))).toBe("20260102.0");
  });

  it("only grows and follows Apple's format", () => {
    const numbers = [
      "2026-10-30T23:59:00Z",
      "2026-10-31T00:00:00Z",
      "2026-10-31T00:01:00Z",
      "2026-12-31T23:59:00Z",
      "2027-01-01T00:00:00Z",
    ].map((iso) => buildNumber(new Date(iso)));
    for (const n of numbers) expect(isValidBuildNumber(n)).toBe(true);
    const asTuples = numbers.map((n) => n.split(".").map(Number));
    for (let i = 1; i < asTuples.length; i++) {
      const [a1 = 0, a2 = 0] = asTuples[i - 1] ?? [];
      const [b1 = 0, b2 = 0] = asTuples[i] ?? [];
      expect(b1 > a1 || (b1 === a1 && b2 > a2)).toBe(true);
    }
  });

  it("validates build numbers", () => {
    for (const ok of ["1", "0", "1.2", "1.2.3", "20261030.1530"]) {
      expect(isValidBuildNumber(ok)).toBe(true);
    }
    for (const bad of ["", "1.2.3.4", "a", "1.", "01", "1..2", "-1"]) {
      expect(isValidBuildNumber(bad)).toBe(false);
    }
  });
});

describe("whatsNewFromReleaseNotes", () => {
  it("normalises GitHub release notes", () => {
    expect(
      whatsNewFromReleaseNotes(
        "<!-- template -->\r\n\r\nFaster widgets.  \r\n\r\n\r\n\r\nFixes.\r\n",
      ),
    ).toBe("Faster widgets.\n\nFixes.");
  });

  it("keeps short notes as they are", () => {
    const notes = "a".repeat(WHATS_NEW_MAX);
    expect(whatsNewFromReleaseNotes(notes)).toBe(notes);
  });

  it("cuts long notes to 4000 characters with an ellipsis", () => {
    const cut = whatsNewFromReleaseNotes("b".repeat(5000));
    expect(Array.from(cut)).toHaveLength(WHATS_NEW_MAX);
    expect(cut.endsWith("b…")).toBe(true);
  });

  it("counts characters, not UTF-16 units, and never splits one", () => {
    const cut = whatsNewFromReleaseNotes("📺".repeat(4100));
    expect(Array.from(cut)).toHaveLength(WHATS_NEW_MAX);
    expect(cut).toBe(`${"📺".repeat(WHATS_NEW_MAX - 1)}…`);
  });
});

describe("token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  it("has App Store Connect's header and claims", () => {
    expect(tokenParts("KEY123", "issuer-uuid", 1_000)).toEqual({
      header: { alg: "ES256", kid: "KEY123", typ: "JWT" },
      claims: {
        iss: "issuer-uuid",
        iat: 1_000,
        exp: 1_900,
        aud: "appstoreconnect-v1",
      },
    });
  });

  it("is an ES256 JWT with a raw 64-byte r||s signature", () => {
    const token = createToken(privateKey, "KEY123", "issuer-uuid", 1_000);
    const [header = "", claims = "", signature = ""] = token.split(".");
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(decode(claims).exp - decode(claims).iat).toBeLessThanOrEqual(1200);
    const raw = Buffer.from(signature, "base64url");
    expect(raw).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        raw,
      ),
    ).toBe(true);
  });
});

/**
 * A small in-memory App Store Connect: enough of apps, builds, versions,
 * localizations and review submissions to run the flow offline.
 */
function fakeAppStoreConnect(options: { firstVersion?: boolean } = {}) {
  const calls: string[] = [];
  const state = {
    buildPolls: 0,
    versions: [] as { id: string; platform: string; versionString: string }[],
    builds: {} as Record<string, string>,
    whatsNew: {} as Record<string, string>,
    submissions: [] as {
      id: string;
      platform: string;
      items: string[];
      submitted: boolean;
    }[],
  };
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
    });

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const path = url.pathname;
    const q = url.searchParams;
    calls.push(`${method} ${path}`);

    if (method === "GET" && path === "/v1/apps") {
      return json(200, {
        data: [
          {
            id: "other",
            type: "apps",
            attributes: { bundleId: "tv.netrics.x" },
          },
          {
            id: "app1",
            type: "apps",
            attributes: { bundleId: "tv.netrics", name: "netrics TV" },
          },
        ],
      });
    }
    if (method === "GET" && path === "/v1/builds") {
      expect(q.get("filter[app]")).toBe("app1");
      expect(q.get("filter[version]")).toBe("20261030.1530");
      const platform = q.get("filter[preReleaseVersion.platform]") ?? "";
      state.buildPolls++;
      if (state.buildPolls === 1) return json(200, { data: [] });
      const processingState = state.buildPolls === 2 ? "PROCESSING" : "VALID";
      return json(200, {
        data: [
          {
            id: `build-${platform}`,
            type: "builds",
            attributes: { processingState },
          },
        ],
      });
    }
    const versionsMatch = /^\/v1\/apps\/app1\/appStoreVersions$/.exec(path);
    if (method === "GET" && versionsMatch) {
      const platform = q.get("filter[platform]");
      return json(200, {
        data: state.versions
          .filter((v) => v.platform === platform)
          .map((v) => ({
            id: v.id,
            type: "appStoreVersions",
            attributes: {
              versionString: v.versionString,
              appVersionState: "PREPARE_FOR_SUBMISSION",
            },
          })),
      });
    }
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const v = {
        id: `ver-${body.data.attributes.platform}`,
        platform: body.data.attributes.platform,
        versionString: body.data.attributes.versionString,
      };
      state.versions.push(v);
      return json(201, {
        data: {
          id: v.id,
          type: "appStoreVersions",
          attributes: { appVersionState: "PREPARE_FOR_SUBMISSION" },
        },
      });
    }
    const buildRel =
      /^\/v1\/appStoreVersions\/([^/]+)\/relationships\/build$/.exec(path);
    if (method === "PATCH" && buildRel?.[1]) {
      state.builds[buildRel[1]] = body.data.id;
      return json(204);
    }
    const locs =
      /^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/.exec(
        path,
      );
    if (method === "GET" && locs?.[1]) {
      return json(200, {
        data: ["en-US", "de-DE"].map((locale) => ({
          id: `${locs[1]}-${locale}`,
          type: "appStoreVersionLocalizations",
          attributes: { locale },
        })),
      });
    }
    const loc = /^\/v1\/appStoreVersionLocalizations\/(.+)$/.exec(path);
    if (method === "PATCH" && loc?.[1]) {
      if (options.firstVersion) {
        return json(409, {
          errors: [
            {
              code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
              detail:
                "An attribute value is not acceptable for the current resource state.",
            },
          ],
        });
      }
      state.whatsNew[loc[1]] = body.data.attributes.whatsNew;
      return json(200, {
        data: { id: loc[1], type: "appStoreVersionLocalizations" },
      });
    }
    if (method === "GET" && path === "/v1/reviewSubmissions") {
      return json(200, { data: [] });
    }
    if (method === "POST" && path === "/v1/reviewSubmissions") {
      const s = {
        id: `sub-${body.data.attributes.platform}`,
        platform: body.data.attributes.platform,
        items: [] as string[],
        submitted: false,
      };
      state.submissions.push(s);
      return json(201, {
        data: {
          id: s.id,
          type: "reviewSubmissions",
          attributes: { state: "READY_FOR_REVIEW" },
        },
      });
    }
    const items = /^\/v1\/reviewSubmissions\/([^/]+)\/items$/.exec(path);
    if (method === "GET" && items) {
      const s = state.submissions.find((x) => x.id === items[1]);
      return json(200, {
        data: (s?.items ?? []).map((id) => ({
          id: `item-${id}`,
          type: "reviewSubmissionItems",
          relationships: {
            appStoreVersion: { data: { id, type: "appStoreVersions" } },
          },
        })),
      });
    }
    if (method === "POST" && path === "/v1/reviewSubmissionItems") {
      const s = state.submissions.find(
        (x) => x.id === body.data.relationships.reviewSubmission.data.id,
      );
      s?.items.push(body.data.relationships.appStoreVersion.data.id);
      return json(201, { data: { id: "item", type: "reviewSubmissionItems" } });
    }
    const sub = /^\/v1\/reviewSubmissions\/([^/]+)$/.exec(path);
    if (method === "PATCH" && sub) {
      const s = state.submissions.find((x) => x.id === sub[1]);
      if (s) s.submitted = body.data.attributes.submitted;
      return json(200, { data: { id: sub[1], type: "reviewSubmissions" } });
    }
    return json(404, {
      errors: [{ code: "NOT_FOUND", detail: `no route ${method} ${path}` }],
    });
  };

  let clock = 0;
  const lines: string[] = [];
  const asc = new AppStoreConnect({
    keyId: "KEY123",
    issuerId: "issuer",
    privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
    fetch: fetchImpl as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => lines.push(line),
  });
  return { asc, state, calls, lines };
}

const runOptions = {
  bundleId: "tv.netrics",
  version: "1.2.3",
  build: "20261030.1530",
  platforms: ["IOS", "TV_OS"] as ("IOS" | "TV_OS")[],
  whatsNew: "Faster widgets.",
  wait: { timeoutMs: 60 * 60000, intervalMs: 30000 },
};

describe("run", () => {
  it("only waits for processing on a pre-release", async () => {
    const { asc, calls, state } = fakeAppStoreConnect();
    await run(asc, { ...runOptions, submit: false });
    expect(calls.filter((c) => c !== "GET /v1/builds")).toEqual([
      "GET /v1/apps",
    ]);
    expect(state.versions).toEqual([]);
  });

  it("attaches, describes and submits both platforms", async () => {
    const { asc, state } = fakeAppStoreConnect();
    await run(asc, { ...runOptions, submit: true });
    expect(state.builds).toEqual({
      "ver-IOS": "build-IOS",
      "ver-TV_OS": "build-TV_OS",
    });
    expect(state.whatsNew).toEqual({
      "ver-IOS-en-US": "Faster widgets.",
      "ver-IOS-de-DE": "Faster widgets.",
      "ver-TV_OS-en-US": "Faster widgets.",
      "ver-TV_OS-de-DE": "Faster widgets.",
    });
    expect(state.submissions).toEqual([
      { id: "sub-IOS", platform: "IOS", items: ["ver-IOS"], submitted: true },
      {
        id: "sub-TV_OS",
        platform: "TV_OS",
        items: ["ver-TV_OS"],
        submitted: true,
      },
    ]);
  });

  it("submits the first version without What's New", async () => {
    const { asc, state, lines } = fakeAppStoreConnect({ firstVersion: true });
    await run(asc, { ...runOptions, submit: true });
    expect(state.whatsNew).toEqual({});
    expect(lines.some((l) => l.includes("not accepted for en-US"))).toBe(true);
    expect(state.submissions.every((s) => s.submitted)).toBe(true);
  });

  it("fails with the API's error detail and keeps the token out of it", async () => {
    const { asc } = fakeAppStoreConnect();
    const error = await asc
      .request("GET", "/v1/nowhere?x=1")
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "GET /v1/nowhere failed with HTTP 404: NOT_FOUND: no route GET /v1/nowhere",
    );
    expect((error as Error).message).not.toMatch(/Bearer|eyJ/);
  });

  it("gives up when processing takes longer than the timeout", async () => {
    const { asc } = fakeAppStoreConnect();
    await expect(
      run(asc, {
        ...runOptions,
        submit: false,
        wait: { timeoutMs: 30000, intervalMs: 30000 },
      }),
    ).rejects.toThrow(/still PROCESSING after 1 min/);
  });
});
