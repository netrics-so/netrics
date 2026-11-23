import { describe, expect, it } from "vitest";

import {
  customApiDefinitionSchema,
  type CustomApiDefinition,
  type CustomApiPagination,
} from "@netrics/contracts";

import {
  challengeCurrent,
  rememberedConfirmation,
} from "@/components/custom-api/builder";
import { draftReady } from "@/components/custom-api/builder-actions";

import {
  bodyLeafPaths,
  bodyOf,
  confirmReadOnly,
  definitionIssues,
  definitionOf,
  draftDefinitionOf,
  draftTestFingerprint,
  EMPTY_BODY,
  graphqlCheck,
  pageValuePlacement,
  placePageValue,
  readOnlyRequests,
  setBodyKind,
  setFirstPage,
  setMethod,
  setPageBodyPath,
  setPageParam,
  stateFromDefinition,
  stepIssues,
  withBody,
  withReadOnlyChecked,
  withRequest,
  type BuilderState,
} from "./custom-api-builder";

// #869: the builder authors POST streams (ADR 0030): method, JSON and
// GraphQL bodies, body-path paging, and the read-only confirmation that
// holds only for the exact request it was given for.

const QUERY =
  "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { endCursor } } }";

const FIELDS = [
  { id: "id", name: "ID", path: "id", type: "integer", nullable: false },
] as const;

/** A saved definition: a confirmed JSON-body stream and a GraphQL stream. */
const SAVED: CustomApiDefinition = customApiDefinitionSchema.parse({
  schemaVersion: 2,
  name: "Query API",
  environments: [
    {
      id: "production",
      name: "Production",
      baseUrl: "https://api.example.com/v1",
    },
  ],
  variables: [
    { id: "account_id", label: "Account", secret: false },
    { id: "region", label: "Region", secret: false },
  ],
  auth: { type: "api_key", placement: "header", name: "X-Key" },
  streams: [
    {
      key: "query_items",
      name: "Query items",
      request: {
        method: "POST",
        path: "/query",
        headers: { Accept: "application/json" },
        body: {
          kind: "json",
          value: { account: "{{account_id}}", page: { offset: 0, limit: 0 } },
          readOnlyConfirmed: true,
        },
      },
      pagination: {
        type: "offset",
        offsetBodyPath: "page.offset",
        limitBodyPath: "page.limit",
        limit: 10,
      },
      records: "items",
      fields: FIELDS,
      keyFields: ["id"],
      mode: "snapshot",
    },
    {
      key: "graphql_items",
      name: "GraphQL items",
      request: {
        method: "POST",
        path: "/graphql",
        body: {
          kind: "graphql",
          query: QUERY,
          variables: { first: 10, after: null },
        },
      },
      pagination: {
        type: "cursor",
        cursorPath: "data.items.pageInfo.endCursor",
        bodyPath: "variables.after",
      },
      records: "data.items.nodes",
      fields: FIELDS,
      keyFields: ["id"],
      mode: "snapshot",
    },
  ],
});

const jsonState = () => stateFromDefinition(SAVED, "query_items");
const graphqlState = () => stateFromDefinition(SAVED, "graphql_items");

/** The saved JSON stream's confirmation after an edit, as the builder applies edits. */
function confirmedAfter(edit: (state: BuilderState) => BuilderState) {
  const state = withReadOnlyChecked(edit(jsonState()), SAVED);
  const body = definitionOf(state, SAVED).streams[0]!.request.body;
  return body?.kind === "json" && body.readOnlyConfirmed === true;
}

describe("method and body", () => {
  it("round-trips saved POST streams unchanged", () => {
    expect(definitionOf(jsonState(), SAVED)).toEqual(SAVED);
    expect(definitionOf(graphqlState(), SAVED)).toEqual(SAVED);
  });

  it("switches GET and POST, keeping the typed body but sending it only with POST", () => {
    const post = jsonState();
    const get = setMethod(post, "GET");
    expect(get.stream.body).toEqual(post.stream.body);
    expect(draftDefinitionOf(get).stream.request).not.toHaveProperty("body");
    expect(draftDefinitionOf(get).stream.request).not.toHaveProperty("method");
    // Body paths have no body to go into: the page values go back to URL parameters.
    expect(get.stream.pagination).toEqual({
      type: "offset",
      offsetParam: "offset",
      limitParam: "limit",
      limit: 10,
    });
    const back = setMethod(get, "POST");
    expect(draftDefinitionOf(back).stream.request.body).toEqual({
      kind: "json",
      value: { account: "{{account_id}}", page: { offset: 0, limit: 0 } },
    });
  });

  it("drops next-link paging when a request becomes POST", () => {
    const get = setMethod(jsonState(), "GET");
    const next = {
      ...get,
      stream: {
        ...get.stream,
        pagination: { type: "next_url", source: "link_header" } as const,
      },
    };
    expect(setMethod(next, "POST").stream.pagination).toEqual({ type: "none" });
  });

  it("switches JSON and GraphQL, keeping both texts and clearing body paths", () => {
    const json = jsonState();
    const graphql = withBody(setBodyKind(json, "graphql"), {
      query: QUERY,
      variables: '{ "first": 10, "after": null }',
    });
    expect(graphql.stream.body.json).toBe(json.stream.body.json);
    expect(draftDefinitionOf(graphql).stream.request.body?.kind).toBe(
      "graphql",
    );
    // The body paths pointed into the JSON body: the Paging step asks again.
    expect(graphql.stream.pagination).toEqual({ type: "offset", limit: 10 });
    expect(stepIssues(graphql, "paging")).toContain(
      "issues.codes.pagination_placement",
    );
    const back = setBodyKind(graphql, "json");
    expect(back.stream.body.query).toBe(QUERY);
    expect(draftDefinitionOf(back).stream.request.body).toEqual(
      draftDefinitionOf(json).stream.request.body,
    );
  });

  it("names what keeps a typed body from being sent", () => {
    expect(bodyOf({ ...EMPTY_BODY, json: "{ nope" }).problems).toEqual({
      json: "syntax",
    });
    expect(
      bodyOf({ ...EMPTY_BODY, kind: "graphql", query: "", variables: "[1]" })
        .problems,
    ).toEqual({ query: "empty", variables: "object" });
    const broken = withBody(jsonState(), { json: "{" });
    expect(stepIssues(broken, "request")).toContain("issues.bodyJson");
    expect(draftReady(broken)).toBe(false);
  });

  it("refuses page values in a body and gives a body's window its window", () => {
    const state = setMethod(
      withRequest(
        { ...jsonState(), stream: { ...jsonState().stream, method: "GET" } },
        {},
      ),
      "POST",
    );
    const paged = withBody(state, { json: '{ "after": "{{page.offset}}" }' });
    expect(stepIssues(paged, "request")).toContain(
      "issues.codes.placeholder_page_in_body",
    );
    const windowed = withBody(state, {
      json: '{ "from": "{{window.start}}" }',
    });
    expect(windowed.stream.window.type).toBe("date");
  });

  it("shows the SDK's GraphQL read-only check as the query is typed", () => {
    const state = graphqlState();
    expect(graphqlCheck(state)).toEqual({ ok: true });
    const check = (query: string) => graphqlCheck(withBody(state, { query }));
    expect(check("mutation { delete }")).toEqual({
      ok: false,
      problem: "not_query",
    });
    expect(check("query A { a } query B { b }")).toEqual({
      ok: false,
      problem: "several_definitions",
    });
    expect(check('query { a(id: "{{account_id}}") }')).toEqual({
      ok: false,
      problem: "placeholder",
    });
    expect(check("query {")).toEqual({ ok: false, problem: "syntax" });
    // Variables that don't parse yet don't hide the query's check.
    expect(
      graphqlCheck(
        withBody(state, { query: "mutation { x }", variables: "{" }),
      ),
    ).toEqual({ ok: false, problem: "not_query" });
    expect(
      stepIssues(withBody(state, { query: "mutation { x }" }), "request"),
    ).toContain("issues.codes.graphql_operation");
  });
});

describe("read-only confirmation (ADR 0030 §2)", () => {
  it("keeps a loaded confirmation while nothing request-shaping changes", () => {
    expect(confirmedAfter((s) => ({ ...s, name: "Renamed" }))).toBe(true);
    expect(
      confirmedAfter((s) => ({
        ...s,
        defaults: { ...s.defaults, refreshMinutes: 30 },
      })),
    ).toBe(true);
    // A connection value the request doesn't use.
    expect(
      confirmedAfter((s) => ({
        ...s,
        variables: s.variables.map((v) =>
          v.id === "region" ? { ...v, label: "Area" } : v,
        ),
      })),
    ).toBe(true);
    // Formatting the JSON differently sends the same body.
    expect(
      confirmedAfter((s) =>
        withBody(s, { json: JSON.stringify(JSON.parse(s.stream.body.json)) }),
      ),
    ).toBe(true);
  });

  it.each<[string, (state: BuilderState) => BuilderState]>([
    [
      "an environment's base URL",
      (s) => ({
        ...s,
        environments: s.environments.map((e) => ({
          ...e,
          baseUrl: "https://api.example.com/v2",
        })),
      }),
    ],
    [
      "a new environment",
      (s) => ({
        ...s,
        environments: [
          ...s.environments,
          {
            id: "staging",
            name: "Staging",
            baseUrl: "https://other.example.com",
          },
        ],
      }),
    ],
    ["the method", (s) => setMethod(setMethod(s, "GET"), "POST")],
    ["the path", (s) => withRequest(s, { path: "/delete" })],
    [
      "a query parameter",
      (s) => withRequest(s, { query: [{ key: "dry", value: "0" }] }),
    ],
    [
      "a header",
      (s) =>
        withRequest(s, { headers: [{ key: "Accept", value: "text/csv" }] }),
    ],
    ["the body", (s) => withBody(s, { json: '{ "action": "delete" }' })],
    ["the body kind", (s) => setBodyKind(s, "graphql")],
    [
      "the pagination",
      (s) => ({
        ...s,
        stream: {
          ...s.stream,
          pagination: {
            ...(s.stream.pagination as CustomApiPagination),
            limit: 50,
          } as CustomApiPagination,
        },
      }),
    ],
    [
      "the window",
      (s) => ({
        ...s,
        stream: {
          ...s.stream,
          window: {
            type: "date",
            stepDays: 1,
            lookbackDays: 0,
            backfillDays: 7,
            paramFormat: "date",
            endInclusive: false,
          },
        },
      }),
    ],
    [
      "the login type",
      (s) => ({
        ...s,
        auth: {
          type: "bearer",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      }),
    ],
    [
      "the login's placement",
      (s) => ({
        ...s,
        auth: { type: "api_key", placement: "query", name: "key" },
      }),
    ],
    [
      "a connection value the request uses",
      (s) => ({
        ...s,
        variables: s.variables.map((v) =>
          v.id === "account_id" ? { ...v, secret: true } : v,
        ),
      }),
    ],
  ])("drops it when %s changes", (_what, edit) => {
    expect(confirmedAfter(edit)).toBe(false);
  });

  it("never brings it back by changing a setting back", () => {
    const original = jsonState();
    const moved = withReadOnlyChecked(
      {
        ...original,
        environments: [
          { ...original.environments[0]!, baseUrl: "https://x.example" },
        ],
      },
      SAVED,
    );
    const back = withReadOnlyChecked(
      { ...moved, environments: original.environments },
      SAVED,
    );
    expect(back.readOnly).toEqual({});
    expect(definitionIssues(back, SAVED).map((i) => i.code)).toEqual([
      "read_only_unconfirmed",
    ]);
  });

  it("drops another stream's confirmation when a shared setting changes", () => {
    // Editing the GraphQL stream; the base URL also moves the JSON stream.
    const state = withReadOnlyChecked(
      {
        ...graphqlState(),
        environments: [
          {
            id: "production",
            name: "Production",
            baseUrl: "https://api.example.com/v2",
          },
        ],
      },
      SAVED,
    );
    const saved = definitionOf(state, SAVED);
    expect(saved.streams[0]!.request.body).not.toHaveProperty(
      "readOnlyConfirmed",
    );
    expect(
      stepIssues(state, "review", { editing: true, original: SAVED }),
    ).toContain("issues.readOnlyUnconfirmed");
    // The save-time confirmation lists it, with the request it saves.
    const [request] = readOnlyRequests(state, SAVED);
    expect(request).toMatchObject({
      confirmed: false,
      stream: { key: "query_items" },
    });
    const confirmed = confirmReadOnly(state, "query_items", true, SAVED);
    expect(
      definitionOf(confirmed, SAVED).streams[0]!.request.body,
    ).toMatchObject({
      readOnlyConfirmed: true,
    });
    expect(
      stepIssues(confirmed, "review", { editing: true, original: SAVED }),
    ).toEqual([]);
  });

  it("is given at save time for a new JSON-body request", () => {
    const base = jsonState();
    const fresh: BuilderState = { ...base, readOnly: {} };
    expect(stepIssues(fresh, "review")).toEqual(["issues.readOnlyUnconfirmed"]);
    expect(readOnlyRequests(fresh)).toEqual([
      expect.objectContaining({ confirmed: false }),
    ]);
    const confirmed = confirmReadOnly(fresh, "query_items", true);
    expect(readOnlyRequests(confirmed)[0]!.confirmed).toBe(true);
    expect(definitionIssues(confirmed)).toEqual([]);
    // Taking it back asks again.
    expect(
      stepIssues(confirmReadOnly(confirmed, "query_items", false), "review"),
    ).toEqual(["issues.readOnlyUnconfirmed"]);
    // A GraphQL body needs none: its operation check holds.
    expect(
      readOnlyRequests(graphqlState(), SAVED).map((r) => r.stream.key),
    ).toEqual(["query_items"]);
  });
});

describe("a pending test confirmation", () => {
  const challenge = (state: BuilderState) => ({
    hash: "a".repeat(64),
    pages: 1,
    fingerprint: draftTestFingerprint(state),
  });

  it("holds while the request stays the same", () => {
    const state = jsonState();
    expect(challengeCurrent(challenge(state), state)).toBe(true);
    // Mapping fields doesn't change the request.
    expect(
      challengeCurrent(challenge(state), {
        ...state,
        stream: { ...state.stream, fields: [] },
      }),
    ).toBe(true);
  });

  it.each<[string, (state: BuilderState) => BuilderState]>([
    ["the body", (s) => withBody(s, { json: '{ "x": 1 }' })],
    ["the path", (s) => withRequest(s, { path: "/other" })],
    [
      "the base URL",
      (s) => ({
        ...s,
        environments: s.environments.map((e) => ({
          ...e,
          baseUrl: "https://api.example.com/v2",
        })),
      }),
    ],
    [
      "the test environment",
      (s) => ({
        ...s,
        environments: [
          ...s.environments,
          {
            id: "staging",
            name: "Staging",
            baseUrl: "https://api.example.com/v1",
          },
        ],
        environmentId: "staging",
      }),
    ],
    [
      "a test value",
      (s) => ({
        ...s,
        variables: s.variables.map((v) =>
          v.id === "account_id" ? { ...v, value: "other" } : v,
        ),
      }),
    ],
  ])("goes stale when %s changes", (_what, edit) => {
    const state = jsonState();
    expect(challengeCurrent(challenge(state), edit(state))).toBe(false);
  });

  it("is reused for the same request only, never after a change", () => {
    const state = jsonState();
    const confirmed = challenge(state);
    // Picking the records doesn't change the request: no second question.
    expect(
      rememberedConfirmation(confirmed, {
        ...state,
        stream: { ...state.stream, records: "other" },
      }),
    ).toBe(confirmed.hash);
    expect(
      rememberedConfirmation(confirmed, withBody(state, { json: "{}" })),
    ).toBeUndefined();
    expect(rememberedConfirmation(null, state)).toBeUndefined();
  });
});

describe("page values in the body (ADR 0030 §3)", () => {
  const cursor: CustomApiPagination = {
    type: "cursor",
    cursorPath: "next",
    param: "cursor",
  };

  it("puts a page value in a URL parameter or the body, never both", () => {
    const body = placePageValue(cursor, "cursor", "body", "variables.after");
    expect(body).toEqual({
      type: "cursor",
      cursorPath: "next",
      bodyPath: "variables.after",
    });
    expect(pageValuePlacement(body, "cursor")).toBe("body");
    const url = placePageValue(setFirstPage(body, "omit"), "cursor", "url");
    expect(url).toEqual({
      type: "cursor",
      cursorPath: "next",
      param: "cursor",
    });
    // Body chosen, no value picked yet: neither is set.
    expect(placePageValue(cursor, "cursor", "body")).toEqual({
      type: "cursor",
      cursorPath: "next",
    });
  });

  it("removes a cleared setting instead of writing an empty string", () => {
    expect(setPageParam(cursor, "cursor", "")).toEqual({
      type: "cursor",
      cursorPath: "next",
    });
    const offset: CustomApiPagination = {
      type: "offset",
      offsetBodyPath: "page.offset",
      limitParam: "limit",
      limit: 10,
    };
    expect(setPageParam(offset, "limit", " ")).toEqual({
      type: "offset",
      offsetBodyPath: "page.offset",
      limit: 10,
    });
    const omitted = setFirstPage(
      placePageValue(cursor, "cursor", "body", "variables.after"),
      "omit",
    );
    expect(omitted).toMatchObject({ firstPage: "omit" });
    expect(setPageBodyPath(omitted, "cursor", "")).toEqual({
      type: "cursor",
      cursorPath: "next",
    });
    // null is the default and never written.
    expect(setFirstPage(omitted, "null")).not.toHaveProperty("firstPage");
  });

  it("offers the body's values, for GraphQL only under variables", () => {
    expect(bodyLeafPaths(graphqlState())).toEqual([
      "variables.first",
      "variables.after",
    ]);
    expect(bodyLeafPaths(jsonState())).toEqual([
      "account",
      "page.offset",
      "page.limit",
    ]);
  });

  it("shows the SDK's body-path rules in the Paging step", () => {
    const state = graphqlState();
    const missing = {
      ...state,
      stream: {
        ...state.stream,
        pagination: setPageBodyPath(
          state.stream.pagination,
          "cursor",
          "variables.before",
        ),
      },
    };
    expect(stepIssues(missing, "paging")).toContain(
      "issues.codes.body_path_invalid",
    );
    expect(stepIssues(state, "paging")).toEqual([]);
  });
});
