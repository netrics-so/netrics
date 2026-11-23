// Read-only POST and GraphQL streams (ADR 0030) against the offline fixture.

import {
  ConnectorError,
  syncResultSchema,
  type ConnectionContext,
  type Connector,
  type SyncRequest,
} from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { afterAll, describe, expect, it, vi } from "vitest";

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

describe("GraphQL error envelopes on other statuses", () => {
  const at = (path: string): CustomApiDefinition => {
    const definition = def("graphql_errors");
    const stream = definition.streams[0]!;
    return {
      ...definition,
      streams: [{ ...stream, request: { ...stream.request, path } }],
    };
  };
  const failureOf = (path: string) =>
    syncAll(connector(at(path))).then(
      () => null,
      (error: unknown) => error as Error,
    );

  it("fails a 400 with errors as graphql_errors, without their text", async () => {
    const error = await failureOf("/graphql/errors-400");
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error!.message).toBe(
      "The GraphQL API answered with errors (graphql_errors): stream items, HTTP 400, 1 error.",
    );
    expect(
      await connector(at("/graphql/errors-400")).check(context, runtime),
    ).toEqual({ ok: false, message: error!.message });
  });

  it("reads no error body of a stream that is not GraphQL (review round 2)", async () => {
    const text = vi.fn(() => '{"errors":[{"message":"x"}]}');
    const failing = {
      ...runtime,
      fetch: async () => ({
        status: 500,
        headers: {},
        text,
        json: () => JSON.parse(text()) as unknown,
        bytes: () => new Uint8Array(),
      }),
    };
    for (const name of ["pages", "json_offset"] as const) {
      text.mockClear();
      await expect(
        connector(def(name)).sync(context, REQUEST, failing),
      ).rejects.toThrow(/^HTTP 500 from /);
      expect(text).not.toHaveBeenCalled();
    }
  });

  it("keeps auth and rate-limit handling first", async () => {
    expect((await failureOf("/graphql/errors-401"))!.name).toBe(
      "CustomApiAuthError",
    );
    expect((await failureOf("/graphql/errors-429"))!.name).toBe(
      "RateLimitedError",
    );
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

  it("never lets a page value change a POST path", () => {
    expect(() =>
      buildRequest({
        definition: graphql,
        stream: {
          request: { ...stream.request, path: "/graphql/{{page.cursor}}" },
        },
        environment,
        config: {},
        credentials: { host } as CustomApiCredentials,
        placeholders: { "page.cursor": "c10" },
        pageParams: {},
      }),
    ).toThrow(/No value for placeholder/);
  });

  it("refuses a POST to a URL from a response", () => {
    expect(() =>
      build({ nextUrl: `${fixture.origin}/graphql/string-cursor?x=1` }),
    ).toThrow(POST_FIXED_ENDPOINT);
  });
});

describe("the rendered body's size", () => {
  it("refuses a body over the limit once values are filled in, before the fetch", async () => {
    const base = def("json_offset");
    const stream = base.streams[0]!;
    const definition: CustomApiDefinition = {
      ...base,
      variables: [{ id: "big", label: "Big", secret: false }],
      streams: [
        {
          ...stream,
          request: {
            ...stream.request,
            body: {
              kind: "json",
              value: {
                list: Array.from({ length: 300 }, () => "{{big}}"),
                page: { offset: 0, limit: 0 },
              },
              readOnlyConfirmed: true,
            },
          },
        },
      ],
    };
    const value = "b".repeat(500);
    fixture.reset();
    const failure = await connector(definition)
      .sync({ ...context, config: { big: value } }, REQUEST, runtime)
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(failure?.name).toBe("CustomApiConfigError");
    expect(failure?.message).toMatch(/larger than 128 KiB/);
    expect(failure?.message).not.toContain(value);
    expect(fixture.requests).toHaveLength(0);
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
