import { describe, expect, it, vi } from "vitest";

import type { CustomApiPagination } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { keptTestConfirmation, rememberedConfirmation } from "./builder";
import { RequestPreview } from "./read-only-confirm";
import { insertionTarget } from "./step-request";
import {
  draftDefinitionOf,
  draftTestFingerprint,
  EMPTY_BODY,
  emptyBuilderState,
  setBodyKind,
  setMethod,
  withBody,
  withRequest,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";
import { customApiDe } from "@/messages/custom-api/de";
import { customApiEn } from "@/messages/custom-api/en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Review of #886 (Codex): a remembered test confirmation never comes back
// after an edit, the confirmations show the request as sent (page values
// written into the body), and "Insert value" never edits a hidden body.

function jsonPost(json: string): BuilderState {
  const state = emptyBuilderState("en", "UTC");
  return {
    ...state,
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: "https://api.example.test",
      },
    ],
    stream: {
      ...state.stream,
      path: "/query",
      method: "POST",
      body: { ...EMPTY_BODY, kind: "json", json },
    },
  };
}

describe("a remembered test confirmation", () => {
  it("is dropped by the first request-shaping edit, and an undo doesn't revive it", () => {
    const original = jsonPost('{ "q": 1 }');
    let remembered = keptTestConfirmation(
      { hash: "a".repeat(64), fingerprint: draftTestFingerprint(original) },
      original,
    );
    expect(rememberedConfirmation(remembered, original)).toBe("a".repeat(64));
    // Edit, as the builder does after every change…
    remembered = keptTestConfirmation(
      remembered,
      withRequest(original, { path: "/delete" }),
    );
    expect(remembered).toBeNull();
    // …then undo: the next test asks again.
    remembered = keptTestConfirmation(remembered, original);
    expect(rememberedConfirmation(remembered, original)).toBeUndefined();
  });

  it("survives edits that don't shape the request", () => {
    const original = jsonPost('{ "q": 1 }');
    const remembered = {
      hash: "b".repeat(64),
      fingerprint: draftTestFingerprint(original),
    };
    expect(
      keptTestConfirmation(remembered, {
        ...original,
        stream: { ...original.stream, records: "items" },
      }),
    ).toBe(remembered);
  });
});

describe("the request a confirmation shows", () => {
  const render = (
    state: BuilderState,
    pagination: CustomApiPagination,
    locale: Locale = "en",
  ) =>
    renderI18n(
      <RequestPreview
        request={draftDefinitionOf(state).stream.request}
        baseUrls={["https://api.example.test"]}
        pagination={pagination}
      />,
      locale,
    )
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'");

  it.each<Locale>(["en", "de"])(
    "shows the page values the first request sends, not the template's (%s)",
    (locale) => {
      const c = (locale === "de" ? customApiDe : customApiEn).customApi.test
        .readOnly;
      const html = render(
        jsonPost('{ "page": { "offset": 7, "limit": 5 } }'),
        {
          type: "offset",
          offsetBodyPath: "page.offset",
          limitBodyPath: "page.limit",
          limit: 100,
        },
        locale,
      );
      expect(html).toContain('"limit": 100');
      expect(html).toContain('"offset": 0');
      expect(html).not.toContain('"limit": 5');
      expect(html).toContain(c.firstRequest);
      expect(html).toContain(c.laterRequests);
    },
  );

  it("says whether the first request sends null or leaves the cursor out", () => {
    const state = jsonPost('{ "after": "x", "q": 1 }');
    const omitted = render(state, {
      type: "cursor",
      cursorPath: "next",
      bodyPath: "after",
      firstPage: "omit",
    });
    expect(omitted).not.toContain('"after"');
    const c = customApiEn.customApi.test.readOnly;
    expect(omitted).toContain(c.cursorOmitted.replace("{path}", "after"));
    const nulled = render(state, {
      type: "cursor",
      cursorPath: "next",
      bodyPath: "after",
    });
    expect(nulled).toContain('"after": null');
    expect(nulled).toContain(c.cursorNull.replace("{path}", "after"));
    // Later pages: the cursor from the previous response.
    expect(nulled).toContain(c.laterCursor.replace("{path}", "after"));
  });
});

describe("Insert value", () => {
  it("never targets a body editor that is hidden", () => {
    const post = jsonPost("{}");
    const json = { kind: "json" } as const;
    const variables = { kind: "variables" } as const;
    expect(insertionTarget(json, post)).toEqual(json);
    // Switched to GET: the body is kept but hidden.
    expect(insertionTarget(json, setMethod(post, "GET"))).toEqual({
      kind: "path",
    });
    // Switched to GraphQL: the JSON editor is hidden, the variables shown.
    const graphql = setBodyKind(post, "graphql");
    expect(insertionTarget(json, graphql)).toEqual({ kind: "path" });
    expect(insertionTarget(variables, graphql)).toEqual(variables);
    expect(insertionTarget(variables, post)).toEqual({ kind: "path" });
    // A query row that was removed is no target either.
    expect(insertionTarget({ kind: "query", index: 0 }, post)).toEqual({
      kind: "path",
    });
    expect(
      insertionTarget(
        { kind: "query", index: 0 },
        withBody(withRequest(post, { query: [{ key: "a", value: "" }] }), {}),
      ),
    ).toEqual({ kind: "query", index: 0 });
  });
});
