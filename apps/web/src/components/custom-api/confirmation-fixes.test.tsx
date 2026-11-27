import { describe, expect, it, vi } from "vitest";

import type {
  CustomApiDefinition,
  CustomApiPagination,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { confirmationAfterTest, reachable, stateAfterTest } from "./builder";
import { testReady } from "./builder-actions";
import { RequestPreview } from "./read-only-confirm";
import { placeholdersFor } from "./step-request";
import { TEST_RESPONSE } from "./test-fixtures";
import {
  confirmReadOnly,
  definitionIssues,
  DEFAULT_WINDOW,
  definitionOf,
  draftDefinitionOf,
  EMPTY_BODY,
  emptyBuilderState,
  readOnlyRequests,
  stepIssues,
  withReadOnlyChecked,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";
import { customApiDe } from "@/messages/custom-api/de";
import { customApiEn } from "@/messages/custom-api/en";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// #887: follow-ups from the review of #886 (POST confirmations).

function jsonPost(
  json: string,
  pagination: CustomApiPagination = { type: "none" },
): BuilderState {
  const state = emptyBuilderState("en", "UTC");
  return {
    ...state,
    name: "Query API",
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: "https://api.example.test",
      },
    ],
    variables: [
      { id: "account_id", label: "Account", secret: false, value: "a1" },
      { id: "region", label: "Region", secret: false, value: "eu" },
    ],
    stream: {
      ...state.stream,
      path: "/query",
      method: "POST",
      body: { ...EMPTY_BODY, kind: "json", json },
      records: "items",
      fields: [
        {
          id: "id",
          name: "ID",
          path: "id",
          type: "integer",
          nullable: false,
          classification: "internal",
        },
      ],
      keyFields: ["id"],
      pagination,
    },
  };
}

const withValue = (state: BuilderState, id: string, value: string) => ({
  ...state,
  variables: state.variables.map((v) => (v.id === id ? { ...v, value } : v)),
});

const savedConfirmed = (
  state: BuilderState,
  original?: CustomApiDefinition,
) => {
  const body = definitionOf(state, original).streams[0]!.request.body;
  return body?.kind === "json" && body.readOnlyConfirmed === true;
};

describe("1. the save confirmation covers the first connection's values", () => {
  const confirmed = () =>
    confirmReadOnly(
      jsonPost('{ "account": "{{account_id}}" }'),
      "records",
      true,
    );

  it("is cleared by changing a value the request uses", () => {
    const state = confirmed();
    expect(savedConfirmed(state)).toBe(true);
    const changed = withReadOnlyChecked(withValue(state, "account_id", "a2"));
    expect(changed.readOnly).toEqual({});
    expect(savedConfirmed(changed)).toBe(false);
    expect(stepIssues(changed, "review")).toContain(
      "issues.readOnlyUnconfirmed",
    );
    // Changing it back doesn't bring it back.
    expect(
      savedConfirmed(
        withReadOnlyChecked(withValue(changed, "account_id", "a1")),
      ),
    ).toBe(false);
    // Without the edit step, the save itself refuses the old confirmation.
    expect(savedConfirmed(withValue(state, "account_id", "a2"))).toBe(false);
    expect(readOnlyRequests(withValue(state, "account_id", "a2"))).toEqual([
      expect.objectContaining({ confirmed: false }),
    ]);
  });

  it("is kept when a value the request doesn't use changes", () => {
    expect(
      savedConfirmed(
        withReadOnlyChecked(withValue(confirmed(), "region", "us")),
      ),
    ).toBe(true);
  });

  it("ignores test values while editing a saved version (no connection is made)", () => {
    const state = confirmed();
    const original = definitionOf(state);
    const loaded = confirmReadOnly(state, "records", true, original);
    expect(savedConfirmed(loaded, original)).toBe(true);
    expect(
      savedConfirmed(
        withReadOnlyChecked(withValue(loaded, "account_id", "a2"), original),
        original,
      ),
    ).toBe(true);
  });
});

describe("2. confirmations show URL pagination", () => {
  const offset: CustomApiPagination = {
    type: "offset",
    offsetParam: "skip",
    limitBodyPath: "page.limit",
    limit: 25,
  };
  const cursor: CustomApiPagination = {
    type: "cursor",
    cursorPath: "next",
    param: "after",
  };
  const html = (pagination: CustomApiPagination, locale: Locale) => {
    const state = jsonPost('{ "page": { "limit": 0 } }', pagination);
    return renderI18n(
      <RequestPreview
        request={draftDefinitionOf(state).stream.request}
        baseUrls={["https://api.example.test"]}
        pagination={pagination}
      />,
      locale,
    ).replaceAll("&#x27;", "'");
  };

  it.each<Locale>(["en", "de"])(
    "lists URL page values with first and later requests (%s)",
    (locale) => {
      const t = (locale === "de" ? customApiDe : customApiEn).customApi.test
        .readOnly;
      const out = html(offset, locale);
      expect(out).toContain(t.firstUrl);
      expect(out).toContain("skip=0");
      expect(out).toContain(
        t.laterUrlOffset.replace("{param}", "skip").replace("{limit}", "25"),
      );
      // The body value too.
      expect(out).toContain(
        t.laterLimit.replace("{path}", "page.limit").replace("{limit}", "25"),
      );
      const cursorOut = html(cursor, locale);
      expect(cursorOut).toContain(t.urlOmitted.replace("{param}", "after"));
      expect(cursorOut).toContain(t.laterUrlCursor.replace("{param}", "after"));
    },
  );

  it("shows page numbers and a fixed page size", () => {
    const out = html(
      {
        type: "page_number",
        param: "page",
        start: 1,
        sizeParam: "per_page",
        size: 50,
      },
      "en",
    );
    const t = customApiEn.customApi.test.readOnly;
    expect(out).toContain("page=1");
    expect(out).toContain("per_page=50");
    expect(out).toContain(t.laterUrlNumber.replace("{param}", "page"));
    expect(out).toContain(
      t.laterUrlFixed.replace("{param}", "per_page").replace("{value}", "50"),
    );
  });
});

describe("3. a test's result after edits made while it ran", () => {
  const sent = confirmReadOnly(
    jsonPost('{ "account": "{{account_id}}" }'),
    "records",
    true,
  );
  const result: BuilderState = {
    ...sent,
    secretsSet: ["token"],
    lastTest: TEST_RESPONSE,
  };

  it("is the test's state when nothing changed", () => {
    expect(stateAfterTest(sent, sent, result)).toBe(result);
    expect(confirmationAfterTest("a".repeat(64), sent, sent)).toMatchObject({
      hash: "a".repeat(64),
    });
  });

  it("keeps newer edits and never revives a dropped confirmation", () => {
    const edited = withReadOnlyChecked({
      ...sent,
      stream: {
        ...sent.stream,
        body: { ...sent.stream.body, json: '{ "delete": true }' },
      },
    });
    expect(edited.readOnly).toEqual({});
    const after = stateAfterTest(edited, sent, result);
    expect(after.stream.body.json).toBe('{ "delete": true }');
    expect(after.readOnly).toEqual({});
    expect(after.secretsSet).toEqual(["token"]);
    expect(after.lastTest).toBe(TEST_RESPONSE);
    // Undone edit: still a different state, so nothing is remembered.
    const undone = withReadOnlyChecked({ ...edited, stream: sent.stream });
    expect(stateAfterTest(undone, sent, result).readOnly).toEqual({});
    expect(confirmationAfterTest("a".repeat(64), undone, sent)).toBeNull();
    expect(confirmationAfterTest(undefined, sent, sent)).toBeNull();
  });
});

describe("4. a body's window placeholder without a window", () => {
  const state = jsonPost('{ "from": "{{window.start}}" }');

  it("is a Paging issue, so Paging stays reachable", () => {
    expect(state.stream.window.type).toBe("none");
    expect(stepIssues(state, "request")).toEqual([]);
    expect(stepIssues(state, "paging")).toContain("issues.windowNeeded");
    expect(reachable(state, "paging")).toBe(true);
  });

  it("still keeps the test and the save from running", () => {
    expect(testReady(state)).toBe(false);
    expect(
      testReady({
        ...state,
        stream: { ...state.stream, window: DEFAULT_WINDOW },
      }),
    ).toBe(true);
    expect(
      definitionIssues(confirmReadOnly(state, "records", true)).map(
        (issue) => issue.code,
      ),
    ).toContain("placeholder_window_without_window");
  });
});

describe("5. the placeholder picker follows the insertion target", () => {
  const paged = jsonPost("{}", {
    type: "offset",
    offsetParam: "skip",
    limitParam: "take",
    limit: 10,
  });

  it("offers no page values for a POST path or a body", () => {
    expect(placeholdersFor({ kind: "path" }, paged)).not.toContain(
      "page.offset",
    );
    expect(placeholdersFor({ kind: "json" }, paged)).not.toContain(
      "page.offset",
    );
    expect(placeholdersFor({ kind: "path" }, paged)).toContain("account_id");
  });

  it("offers them for URL parameters, headers and a GET path", () => {
    const withRow = {
      ...paged,
      stream: { ...paged.stream, query: [{ key: "q", value: "" }] },
    };
    expect(placeholdersFor({ kind: "query", index: 0 }, withRow)).toContain(
      "page.offset",
    );
    const get = {
      ...paged,
      stream: { ...paged.stream, method: "GET" as const },
    };
    expect(placeholdersFor({ kind: "path" }, get)).toContain("page.offset");
  });
});
