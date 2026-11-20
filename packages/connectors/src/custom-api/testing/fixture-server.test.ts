import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";

import type { ConnectorResponse } from "@netrics/connector-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURE_DEFINITION_NAMES,
  FIXTURE_OAUTH_CLIENT,
  FIXTURE_SECRETS,
  fixtureDefinition,
  fixtureRuntime,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "./index.js";

describe("custom API fixture server", () => {
  let fixture: CustomApiFixtureServer;
  beforeAll(async () => {
    fixture = await startCustomApiFixtureServer();
  });
  afterAll(() => fixture.close());

  it("serves every route deterministically and records requests", async () => {
    const runtime = fixtureRuntime(["127.0.0.1"]);
    const get = (path: string, headers: Record<string, string> = {}) =>
      runtime.fetch(`${fixture.origin}${path}`, { headers });
    fixture.reset();
    const b64 = (value: string) => Buffer.from(value).toString("base64");
    const cases: [string, Record<string, string>, number][] = [
      ["/items/pages?page=3&per_page=10", {}, 200],
      ["/items/offset?offset=20&limit=10", {}, 200],
      ["/items/cursor?cursor=c20", {}, 200],
      ["/items/next-body", {}, 200],
      ["/items/next-link", {}, 200],
      ["/stats", {}, 200],
      ["/daily?from=2024-01-01&to=2024-01-08", {}, 200],
      ["/daily?from=1704067200&to=1704672000&fmt=unix", {}, 200],
      ["/auth/api-key-header", {}, 401],
      ["/auth/api-key-header", { "x-api-key": "forbidden-key" }, 403],
      ["/auth/api-key-header", { "x-api-key": FIXTURE_SECRETS.apiKey }, 200],
      [`/auth/api-key-query?api_key=${FIXTURE_SECRETS.apiKey}`, {}, 200],
      [`/auth/api-key-query?api_key=${FIXTURE_SECRETS.apiKey}&bad=1`, {}, 400],
      [
        "/auth/bearer",
        { authorization: `Bearer ${FIXTURE_SECRETS.token}` },
        200,
      ],
      [
        "/auth/bearer-custom",
        { "x-token": `Token ${FIXTURE_SECRETS.token}` },
        200,
      ],
      [
        "/auth/basic",
        {
          authorization: `Basic ${b64(`${FIXTURE_SECRETS.username}:${FIXTURE_SECRETS.password}`)}`,
        },
        200,
      ],
      ["/edge/next-off-host", {}, 200],
      ["/edge/redirect-off-host", {}, 302],
      ["/edge/repeat-cursor", {}, 200],
      ["/edge/endless?cursor=7", {}, 200],
      ["/edge/bad-values", {}, 200],
      ["/edge/not-json", {}, 200],
      ["/edge/deep", {}, 200],
      ["/edge/429", {}, 429],
    ];
    const responses: ConnectorResponse[] = [];
    for (const [path, headers, status] of cases) {
      const response = await get(path, headers);
      expect(response.status, path).toBe(status);
      responses.push(response);
    }
    expect(fixture.requests).toHaveLength(cases.length);
    expect(fixture.requests[0]).toMatchObject({
      method: "GET",
      host: `127.0.0.1:${fixture.port}`,
      path: "/items/pages",
      query: { page: "3", per_page: "10" },
    });
    expect(fixture.requests[10]!.headers["x-api-key"]).toBe(
      FIXTURE_SECRETS.apiKey,
    );

    const ids = (body: unknown, key = "data") =>
      ((body as Record<string, { id: number }[]>)[key] ?? []).map((i) => i.id);
    expect(ids(responses[0]!.json())).toEqual([21, 22, 23, 24, 25]);
    expect(ids(responses[1]!.json(), "items")).toHaveLength(5);
    expect(responses[2]!.json()).toMatchObject({ meta: { next: null } });
    expect(responses[3]!.json()).toMatchObject({
      links: { next: `${fixture.origin}/items/next-body?after=10` },
    });
    expect(responses[4]!.headers.link).toContain('rel="next"');
    expect(responses[5]!.json()).toEqual({
      visitors: 1234,
      as_of: "2024-01-01",
    });
    const week = (responses[6]!.json() as { data: { orders: number }[] }).data;
    expect(week.map((day) => day.orders)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      (responses[7]!.json() as { data: { date: number }[] }).data[0]!.date,
    ).toBe(1704067200);
    expect(responses[12]!.text()).toContain(FIXTURE_SECRETS.apiKey);
    expect(responses[16]!.json()).toMatchObject({
      links: {
        next: `http://localhost:${fixture.port}/items/next-body?after=10`,
      },
    });
    expect(responses[17]!.headers.location).toBe(
      `http://localhost:${fixture.port}/items/pages`,
    );
    expect(responses[19]!.json()).toMatchObject({ meta: { next: "8" } });
    expect(() => responses[21]!.json()).toThrow();
    expect(responses[22]!.text().startsWith('{"a":{"a":')).toBe(true);
    expect(responses[23]!.headers["retry-after"]).toBe("120");
  });

  it("builds a definition for every route group", () => {
    for (const name of FIXTURE_DEFINITION_NAMES)
      expect(
        fixtureDefinition(name, fixture.origin).environments[0]!.baseUrl,
      ).toBe(fixture.origin);
  });

  it("issues, refreshes and revokes tokens", async () => {
    const runtime = fixtureRuntime(["127.0.0.1"]);
    const { clientId, clientSecret } = FIXTURE_OAUTH_CLIENT;
    const post = (
      path: string,
      values: Record<string, string>,
      headers: Record<string, string> = {},
    ) =>
      runtime.fetch(`${fixture.origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(values).toString(),
      });
    const json = (response: ConnectorResponse) =>
      response.json() as Record<string, string>;
    const items = (token: string) =>
      runtime.fetch(`${fixture.origin}/oauth/api/items`, {
        headers: { authorization: `Bearer ${token}` },
      });

    // Client credentials, body and basic; a wrong secret is invalid_client.
    const minted = await post("/oauth/token", {
      grant_type: "client_credentials",
      scope: "items.read",
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(minted.status).toBe(200);
    expect(json(minted)).toMatchObject({
      token_type: "Bearer",
      scope: "items.read",
    });
    expect(json(minted).refresh_token).toBeUndefined();
    expect((await items(json(minted).access_token!)).status).toBe(200);
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    expect(
      (
        await post(
          "/oauth/token",
          { grant_type: "client_credentials" },
          { authorization: `Basic ${basic}` },
        )
      ).status,
    ).toBe(200);
    expect(fixture.oauth.tokenRequests.at(-1)!.clientAuth).toBe("basic");
    const refused = await post("/oauth/token", {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "wrong",
    });
    expect(refused.status).toBe(401);
    expect(json(refused)).toEqual({ error: "invalid_client" });

    // Authorization code with PKCE.
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://localhost:3000/oauth/custom/callback";
    const authorize = await runtime.fetch(
      `${fixture.origin}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state: "s1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.location!);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;
    const exchange = (codeVerifier: string) =>
      post("/oauth/token?rotate=1", {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: clientId,
        client_secret: clientSecret,
      });
    const granted = await exchange(verifier);
    expect(granted.status).toBe(200);
    const refresh = json(granted).refresh_token!;
    expect(refresh).toBeTruthy();
    // A code works once.
    expect((await exchange(verifier)).status).toBe(400);

    // Refresh rotates with ?rotate=1; the old refresh token is dead.
    const refreshed = await post("/oauth/token?rotate=1", {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(refreshed.status).toBe(200);
    const rotated = json(refreshed).refresh_token!;
    expect(rotated).not.toBe(refresh);
    const stale = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(json(stale)).toEqual({ error: "invalid_grant" });

    // Revocation ends the grant; expired access tokens are refused.
    expect(
      (
        await post("/oauth/revoke", {
          token: rotated,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).status,
    ).toBe(200);
    expect(fixture.oauth.revoked).toEqual([rotated]);
    expect(
      json(
        await post("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: rotated,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      ),
    ).toEqual({ error: "invalid_grant" });
    const access = json(refreshed).access_token!;
    expect((await items(access)).status).toBe(200);
    fixture.oauth.expireAccessTokens();
    expect((await items(access)).status).toBe(401);
    expect(fixture.oauth.issued).toContain(code);
  });

  it("refuses hosts the fixture runtime does not allow", async () => {
    await expect(
      fixtureRuntime(["127.0.0.1"]).fetch(
        `http://localhost:${fixture.port}/stats`,
      ),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("custom API fixture server over https", () => {
  it("serves over https with tls: true and exposes its certificate", async () => {
    const fixture = await startCustomApiFixtureServer({ tls: true });
    try {
      expect(fixture.origin).toBe(`https://127.0.0.1:${fixture.port}`);
      expect(fixture.ca).toContain("BEGIN CERTIFICATE");
      const body = await new Promise<string>((resolve, reject) => {
        const request = httpsRequest(
          `${fixture.origin}/stats`,
          { ca: fixture.ca! },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += chunk));
            response.on("end", () => resolve(text));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(JSON.parse(body)).toEqual({ visitors: 1234, as_of: "2024-01-01" });
      expect(fixture.requests[0]!.host).toBe(`127.0.0.1:${fixture.port}`);
    } finally {
      await fixture.close();
    }
  });
});
