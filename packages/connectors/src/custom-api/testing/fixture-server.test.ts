import { request as httpsRequest } from "node:https";

import type { ConnectorResponse } from "@netrics/connector-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURE_DEFINITION_NAMES,
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
