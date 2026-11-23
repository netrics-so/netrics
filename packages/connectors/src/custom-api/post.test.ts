// Read-only POST and GraphQL streams (ADR 0030) against the offline fixture.

import {
  ConnectorError,
  syncResultSchema,
  type ConnectionContext,
  type Connector,
  type SyncRequest,
} from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { afterAll, describe, expect, it } from "vitest";

import {
  CUSTOM_API_GRAPHQL_ERRORS,
  GRAPHQL_URL_PARAM,
  POST_FIXED_ENDPOINT,
  buildRequest,
  createCustomApiConnector,
  customApiSecretValues,
  runCustomApiTestStream,
  sendCustomApiRequest,
  type CustomApiCredentials,
} from "./index.js";
import { pinFor } from "./test-helpers.js";
import {
  fixtureDefinition,
  fixtureRuntime,
  startCustomApiFixtureServer,
  type FixtureDefinitionName,
} from "./testing/index.js";

const fixture = await startCustomApiFixtureServer();
afterAll(() => fixture.close());
const host = `127.0.0.1:${fixture.port}`;
const runtime = fixtureRuntime(["127.0.0.1"]);
const REQUEST: SyncRequest = {
  mode: "backfill",
  from: "2024-01-01T00:00:00.000Z",
  to: "2024-03-15T12:00:00.000Z",
};
const context: ConnectionContext = {
  connectionId: "c1",
  config: {},
  credentials: { host } as CustomApiCredentials,
};

const def = (name: FixtureDefinitionName) =>
  fixtureDefinition(name, fixture.origin);
const connector = (definition: CustomApiDefinition): Connector =>
  createCustomApiConnector({ definition, pin: pinFor(definition) });

async function syncAll(target: Connector) {
  const ids: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = syncResultSchema.parse(
      await target.sync(
        context,
        { ...REQUEST, ...(cursor ? { cursor } : {}) },
        runtime,
      ),
    );
    for (const page of result.datasetPages ?? [])
      ids.push(...page.records.map((record) => record.values.id));
    if (result.done) return ids;
    cursor = result.nextCursor;
  }
}

const sentBodies = () =>
  fixture.requests.map((request) => JSON.parse(request.body ?? "null"));

describe("GraphQL streams", () => {
  it("POSTs the query with variables and pages through variables.after", async () => {
    fixture.reset();
    const ids = await syncAll(connector(def("graphql")));
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(fixture.requests.map((r) => r.method)).toEqual([
      "POST",
      "POST",
      "POST",
    ]);
    expect(fixture.requests[0]!.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    const bodies = sentBodies();
    // Exactly the keys query and variables; the query is sent as written.
    for (const body of bodies)
      expect(Object.keys(body)).toEqual(["query", "variables"]);
    expect(new Set(bodies.map((b) => b.query)).size).toBe(1);
    expect(bodies.map((b) => b.variables.after)).toEqual([null, "c10", "c20"]);
    expect(
      fixture.requests.every((r) => Object.keys(r.query).length === 0),
    ).toBe(true);
  });

  it("keeps a numeric cursor a number across pages", async () => {
    fixture.reset();
    const ids = await syncAll(connector(def("graphql_number")));
    expect(ids).toHaveLength(25);
    expect(sentBodies().map((b) => b.variables.after)).toEqual([null, 10, 20]);
  });

  it("leaves the cursor out of the first page with firstPage omit", async () => {
    fixture.reset();
    const ids = await syncAll(connector(def("graphql_omit")));
    expect(ids).toHaveLength(25);
    const [first, second] = sentBodies();
    expect(first.variables).not.toHaveProperty("after");
    expect(second.variables.after).toBe("c10");
  });

  it("fails on GraphQL errors with a fixed message, without response text", async () => {
    const target = connector(def("graphql_errors"));
    const failure = await syncAll(target).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectorError);
    const error = failure as ConnectorError;
    expect(error.code).toBe(CUSTOM_API_GRAPHQL_ERRORS);
    expect(error.message).toBe(
      "The GraphQL API answered with errors (graphql_errors): stream items, HTTP 200, 2 errors.",
    );
    expect(error.message).not.toContain("LEAKED");
    const checked = await target.check(context, runtime);
    expect(checked).toEqual({ ok: false, message: error.message });
  });

  it("follows no redirect: a 3xx fails the run", async () => {
    fixture.reset();
    await expect(syncAll(connector(def("graphql_redirect")))).rejects.toThrow(
      /^HTTP 307 from .*\(stream items\): a POST request follows no redirects$/,
    );
    expect(fixture.requests.map((r) => r.path)).toEqual(["/graphql/redirect"]);
  });
});

describe("JSON body streams", () => {
  it("pages through offset and limit in the body, as numbers", async () => {
    fixture.reset();
    const ids = await syncAll(connector(def("json_offset")));
    expect(ids).toHaveLength(25);
    expect(sentBodies()).toEqual([
      { kind: "ItemsQuery", page: { offset: 0, limit: 10 } },
      { kind: "ItemsQuery", page: { offset: 10, limit: 10 } },
      { kind: "ItemsQuery", page: { offset: 20, limit: 10 } },
    ]);
  });
});

describe("checks before every send", () => {
  const graphql = def("graphql");
  const environment = graphql.environments[0]!;
  const stream = graphql.streams[0]!;
  const build = (
    overrides: {
      definition?: Partial<CustomApiDefinition>;
      query?: Record<string, string>;
      pageParams?: Record<string, string>;
      nextUrl?: string;
    } = {},
  ) =>
    buildRequest({
      definition: { ...graphql, ...overrides.definition },
      stream: {
        request: { ...stream.request, query: overrides.query ?? {} },
      },
      environment,
      config: {},
      credentials: { host, apiKey: "k-0001" } as CustomApiCredentials,
      placeholders: {},
      pageParams: overrides.pageParams ?? {},
      ...(overrides.nextUrl ? { nextUrl: overrides.nextUrl } : {}),
    });

  it("refuses a GraphQL URL carrying a reserved parameter", () => {
    // Definitions that the definition check refuses, sent anyway.
    expect(() => build({ query: { Query: "mutation { a }" } })).toThrow(
      GRAPHQL_URL_PARAM,
    );
    expect(() => build({ pageParams: { variables: "{}" } })).toThrow(
      GRAPHQL_URL_PARAM,
    );
    expect(() =>
      build({
        definition: {
          auth: { type: "api_key", placement: "query", name: "operationName" },
        },
      }),
    ).toThrow(GRAPHQL_URL_PARAM);
    expect(build().url).toBe(`${fixture.origin}/graphql/string-cursor`);
  });

  it("refuses a POST to a URL from a response", () => {
    expect(() =>
      build({ nextUrl: `${fixture.origin}/graphql/string-cursor?x=1` }),
    ).toThrow(POST_FIXED_ENDPOINT);
  });
});

describe("redaction of the rendered body", () => {
  it("is part of the host's redaction set", () => {
    const definition = def("graphql");
    const values = customApiSecretValues(
      definition,
      { host } as CustomApiCredentials,
      {},
      definition.streams,
    );
    const built = buildRequest({
      definition,
      stream: definition.streams[0]!,
      environment: definition.environments[0]!,
      config: {},
      credentials: { host } as CustomApiCredentials,
      placeholders: {},
      pageParams: {},
      bodyWrites: [
        { path: [{ key: "variables" }, { key: "after" }], value: null },
      ],
    });
    expect(values).toContain(built.body);
  });

  it("never reaches an error of the fetch", async () => {
    const definition = def("json_offset");
    const built = buildRequest({
      definition,
      stream: definition.streams[0]!,
      environment: definition.environments[0]!,
      config: {},
      credentials: { host } as CustomApiCredentials,
      placeholders: {},
      pageParams: {},
    });
    const echo = async (_url: string, init?: { body?: string }) => {
      throw new Error(`refused request body ${init?.body ?? ""}`);
    };
    await expect(sendCustomApiRequest(echo, built)).rejects.toThrow(
      "refused request body [redacted]",
    );
  });
});

describe("the builder's test stream", () => {
  it("traces POST and fails on GraphQL errors without response text", async () => {
    const definition = def("graphql_errors");
    const traces: { method: string }[] = [];
    const failure = await runCustomApiTestStream({
      definition,
      stream: definition.streams[0]!,
      environmentId: definition.environments[0]!.id,
      config: {},
      credentials: { host } as CustomApiCredentials,
      fetch: runtime.fetch,
      chunk: null,
      limits: { maxPages: 2, maxRecords: 100, deadline: Date.now() + 10_000 },
      onPage: (trace) => traces.push(trace),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(traces.map((t) => t.method)).toEqual(["POST"]);
    expect((failure as Error).message).toMatch(/graphql_errors/);
    expect((failure as Error).message).not.toContain("LEAKED");
  });
});
