// ADR 0030: read-only POST and GraphQL bodies in definition schema version 2.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_API_BODY_LIMITS,
  checkCustomApiStreamRequest,
  customApiDefinitionSchema,
  customApiGraphqlProblem,
  customApiIssues,
  renderCustomApiBody,
  type CustomApiBody,
  type CustomApiIssue,
} from "./definition.js";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixture = (): Doc =>
  JSON.parse(
    readFileSync(new URL("./fixtures/v2-post.json", import.meta.url), "utf8"),
  );

/** The fixture with `change` applied to its GraphQL stream (0) and JSON stream (1). */
function doc(change: (graphql: Doc, json: Doc, d: Doc) => void): Doc {
  const d = fixture();
  change(d.streams[0], d.streams[1], d);
  return d;
}

function issuesOf(input: Doc): CustomApiIssue[] {
  const result = customApiDefinitionSchema.safeParse(input);
  expect(result.success).toBe(false);
  return customApiIssues(result.error!);
}

function expectIssue(input: Doc, code: string, path: string) {
  expect(issuesOf(input)).toContainEqual(
    expect.objectContaining({ code, path }),
  );
}

describe("POST streams (schema version 2)", () => {
  it("accepts a GraphQL and a JSON body stream", () => {
    const parsed = customApiDefinitionSchema.parse(fixture());
    expect(parsed.streams[0]!.request.method).toBe("POST");
    expect(parsed.streams[0]!.request.body?.kind).toBe("graphql");
    expect(parsed.streams[1]!.request.body?.kind).toBe("json");
  });

  it("writes no method into a GET stream", () => {
    const parsed = customApiDefinitionSchema.parse(
      doc((g, j, d) => {
        d.streams = [
          {
            ...g,
            request: { path: "/items" },
            pagination: { type: "none" },
          },
        ];
      }),
    );
    expect(parsed.streams[0]!.request).not.toHaveProperty("method");
  });

  it("refuses a body without POST and POST without a body", () => {
    expectIssue(
      doc((g) => delete g.request.method),
      "method_body",
      "streams.0.request.body",
    );
    expectIssue(
      doc((g) => delete g.request.body),
      "method_body",
      "streams.0.request.body",
    );
  });

  it("refuses any other method", () => {
    expectIssue(
      doc((g) => (g.request.method = "PUT")),
      "invalid",
      "streams.0.request.method",
    );
  });

  it("refuses next_url pagination on every POST stream", () => {
    for (const stream of [0, 1]) {
      const input = doc((_g, _j, d) => {
        d.streams[stream].pagination = {
          type: "next_url",
          source: "body",
          path: "next",
        };
      });
      expectIssue(input, "post_next_url", `streams.${stream}.pagination.type`);
    }
  });

  it("requires the read-only confirmation on a JSON body", () => {
    expectIssue(
      doc((_g, j) => delete j.request.body.readOnlyConfirmed),
      "read_only_unconfirmed",
      "streams.1.request.body.readOnlyConfirmed",
    );
    expectIssue(
      doc((_g, j) => (j.request.body.readOnlyConfirmed = false)),
      "read_only_unconfirmed",
      "streams.1.request.body.readOnlyConfirmed",
    );
  });

  it("bounds the body's size and depth", () => {
    let deep: unknown = "x";
    for (let i = 0; i < CUSTOM_API_BODY_LIMITS.depth + 1; i++)
      deep = { a: deep };
    expectIssue(
      doc((_g, j) => (j.request.body.value = deep)),
      "invalid",
      "streams.1.request.body.value",
    );
    expectIssue(
      doc(
        (_g, j) =>
          (j.request.body.value = {
            a: "x".repeat(CUSTOM_API_BODY_LIMITS.stringLength + 1),
          }),
      ),
      "invalid",
      "streams.1.request.body.value",
    );
  });
});

describe("placeholders in bodies", () => {
  it.each([
    ["{{page.cursor}}"],
    ["{{page.offset}}"],
    ["{{ page.size }}"],
    ["after {{page.number}}"],
  ])("refuses the page placeholder %s in a body", (value) => {
    expectIssue(
      doc((g) => (g.request.body.variables.after = value)),
      "placeholder_page_in_body",
      "streams.0.request.body.variables.after",
    );
    expectIssue(
      doc((_g, j) => (j.request.body.value.query.cursor = value)),
      "placeholder_page_in_body",
      "streams.1.request.body.value.query.cursor",
    );
  });

  it("refuses secrets, unknown names and window values without a window", () => {
    expectIssue(
      doc((g, _j, d) => {
        d.variables.push({ id: "pat", label: "PAT", secret: true });
        g.request.body.variables.project = "{{pat}}";
      }),
      "placeholder_secret_outside_auth",
      "streams.0.request.body.variables.project",
    );
    expectIssue(
      doc((g) => (g.request.body.variables.project = "{{nope}}")),
      "placeholder_unknown",
      "streams.0.request.body.variables.project",
    );
    expectIssue(
      doc((g) => (g.request.body.variables.list = ["{{window.start}}"])),
      "placeholder_window_without_window",
      "streams.0.request.body.variables.list.0",
    );
    expectIssue(
      doc((g) => (g.request.body.variables.project = "{{ unclosed")),
      "placeholder_syntax",
      "streams.0.request.body.variables.project",
    );
  });

  it("accepts variables and window values in string leaves", () => {
    expect(customApiDefinitionSchema.safeParse(fixture()).success).toBe(true);
  });
});

describe("the GraphQL read-only guard", () => {
  it.each<[string, string]>([
    ["mutation", "mutation { deleteProject(id: 1) { id } }"],
    ["subscription", "subscription { events { id } }"],
    ["two operations", "query A { a } query B { b }"],
    ["a query and a mutation", "query A { a } mutation B { b }"],
    ["a fragment definition", "query A { ...F } fragment F on Query { a }"],
    ["a syntax error", "query { a "],
  ])("refuses %s", (_label, query) => {
    expectIssue(
      doc((g) => (g.request.body.query = query)),
      "graphql_operation",
      "streams.0.request.body.query",
    );
  });

  it("accepts a shorthand query and inline fragments", () => {
    expect(customApiGraphqlProblem("{ a }")).toBeNull();
    expect(
      customApiGraphqlProblem("query Q { node { ... on Item { id } } }"),
    ).toBeNull();
  });

  it("never echoes the query in an issue", () => {
    const secretish = "mutation { wipe(confirm: SUPERSECRETVALUE) }";
    const issues = issuesOf(doc((g) => (g.request.body.query = secretish)));
    expect(JSON.stringify(issues)).not.toContain("SUPERSECRETVALUE");
  });

  it("keeps the query a literal: no placeholders, no body path into it", () => {
    expectIssue(
      doc(
        (g) =>
          (g.request.body.query =
            'query Q { items(project: "{{project_id}}") { id } }'),
      ),
      "graphql_query_placeholder",
      "streams.0.request.body.query",
    );
    expectIssue(
      doc((g) => (g.pagination.bodyPath = "query")),
      "body_path_invalid",
      "streams.0.pagination.bodyPath",
    );
  });

  it("refuses keys besides query and variables", () => {
    for (const key of ["operationName", "extensions"])
      expectIssue(
        doc((g) => (g.request.body[key] = "x")),
        "invalid",
        "streams.0.request.body",
      );
  });

  it("refuses variables that are not an object", () => {
    for (const variables of [[], "x", null])
      expectIssue(
        doc((g) => (g.request.body.variables = variables)),
        "invalid",
        "streams.0.request.body.variables",
      );
  });

  it("refuses URL parameters that could override the body", () => {
    expectIssue(
      doc((g) => (g.request.query = { Query: "{ a }" })),
      "graphql_param_reserved",
      "streams.0.request.query.Query",
    );
    expectIssue(
      doc((g) => (g.request.query = { variables: "{}" })),
      "graphql_param_reserved",
      "streams.0.request.query.variables",
    );
    expectIssue(
      doc((_g, _j, d) => {
        d.auth = { type: "api_key", placement: "query", name: "operationName" };
      }),
      "graphql_param_reserved",
      "auth.name",
    );
    expectIssue(
      doc((g) => {
        g.pagination = {
          type: "cursor",
          cursorPath: "next",
          param: "extensions",
        };
      }),
      "graphql_param_reserved",
      "streams.0.pagination.param",
    );
  });
});

describe("pagination through the body", () => {
  it("needs exactly one placement per page value", () => {
    expectIssue(
      doc((g) => (g.pagination.param = "after")),
      "pagination_placement",
      "streams.0.pagination.param",
    );
    expectIssue(
      doc((g) => delete g.pagination.bodyPath),
      "pagination_placement",
      "streams.0.pagination.param",
    );
    expectIssue(
      doc((_g, j) => (j.pagination.offsetParam = "offset")),
      "pagination_placement",
      "streams.1.pagination.offsetParam",
    );
    expectIssue(
      doc((g) => {
        g.pagination = {
          type: "cursor",
          cursorPath: "next",
          param: "after",
          firstPage: "omit",
        };
      }),
      "pagination_placement",
      "streams.0.pagination.firstPage",
    );
  });

  it("points at an existing leaf of the template", () => {
    expectIssue(
      doc((g) => (g.pagination.bodyPath = "variables.missing")),
      "body_path_invalid",
      "streams.0.pagination.bodyPath",
    );
    expectIssue(
      doc((g) => (g.pagination.bodyPath = "variables")),
      "body_path_invalid",
      "streams.0.pagination.bodyPath",
    );
    expectIssue(
      doc((_g, j) => (j.pagination.offsetBodyPath = "query")),
      "body_path_invalid",
      "streams.1.pagination.offsetBodyPath",
    );
    expectIssue(
      doc((_g, j) => (j.pagination.limitBodyPath = "offset")),
      "body_path_invalid",
      "streams.1.pagination.limitBodyPath",
    );
  });

  it("omits only object properties on the first page", () => {
    const omit = doc((g) => (g.pagination.firstPage = "omit"));
    expect(customApiDefinitionSchema.safeParse(omit).success).toBe(true);
    expectIssue(
      doc((g) => {
        g.request.body.variables.after = [null];
        g.pagination.bodyPath = "variables.after[0]";
        g.pagination.firstPage = "omit";
      }),
      "body_path_invalid",
      "streams.0.pagination.bodyPath",
    );
  });

  it("refuses body paths on a GET stream", () => {
    expectIssue(
      doc((g) => {
        delete g.request.method;
        delete g.request.body;
      }),
      "body_path_invalid",
      "streams.0.pagination.bodyPath",
    );
  });
});

describe("checkCustomApiStreamRequest", () => {
  it("reports under the paths the caller names (the draft's shape)", () => {
    const d = fixture();
    const parsed = customApiDefinitionSchema.parse(d);
    const stream = structuredClone(parsed.streams[0]!);
    (stream.request.body as { query: string }).query = "mutation { a }";
    const found: { path: (string | number)[]; code?: string }[] = [];
    checkCustomApiStreamRequest(
      stream,
      parsed,
      (path, code) => found.push({ path, ...(code ? { code } : {}) }),
      {
        paths: {
          stream: ["definition", "stream"],
          auth: ["definition", "auth"],
        },
        confirmation: "draft",
      },
    );
    expect(found).toEqual([
      {
        path: ["definition", "stream", "request", "body", "query"],
        code: "graphql_operation",
      },
    ]);
  });

  it("skips the stored confirmation for a draft", () => {
    const parsed = customApiDefinitionSchema.parse(fixture());
    const stream = structuredClone(parsed.streams[1]!);
    delete (stream.request.body as { readOnlyConfirmed?: boolean })
      .readOnlyConfirmed;
    const found: string[] = [];
    const check = (confirmation: "stored" | "draft") =>
      checkCustomApiStreamRequest(
        stream,
        parsed,
        (_path, code) => found.push(code ?? "invalid"),
        { paths: { stream: [], auth: [] }, confirmation },
      );
    check("draft");
    expect(found).toEqual([]);
    check("stored");
    expect(found).toEqual(["read_only_unconfirmed"]);
  });
});

describe("renderCustomApiBody", () => {
  const graphql: CustomApiBody = {
    kind: "graphql",
    query: "query Q($p: String!, $after: String) { a }",
    variables: { p: "{{project_id}}", after: null, n: 5 },
  };

  it("renders string leaves and keeps the query", () => {
    const text = renderCustomApiBody(graphql, (t) =>
      t.replace("{{project_id}}", 'a"b'),
    );
    expect(JSON.parse(text)).toEqual({
      query: graphql.query,
      variables: { p: 'a"b', after: null, n: 5 },
    });
    expect(Object.keys(JSON.parse(text))).toEqual(["query", "variables"]);
  });

  it("writes page values with their JSON type, or omits the property", () => {
    const path = [{ key: "variables" }, { key: "after" }];
    expect(
      JSON.parse(renderCustomApiBody(graphql, (t) => t, [{ path, value: 42 }]))
        .variables.after,
    ).toBe(42);
    expect(
      JSON.parse(
        renderCustomApiBody(graphql, (t) => t, [{ path, value: "abc" }]),
      ).variables.after,
    ).toBe("abc");
    const omitted = JSON.parse(
      renderCustomApiBody(graphql, (t) => t, [{ path, omit: true }]),
    );
    expect(omitted.variables).not.toHaveProperty("after");
  });

  it("refuses a write into the query", () => {
    expect(() =>
      renderCustomApiBody(graphql, (t) => t, [
        { path: [{ key: "query" }], value: "mutation { a }" },
      ]),
    ).toThrow();
  });
});
