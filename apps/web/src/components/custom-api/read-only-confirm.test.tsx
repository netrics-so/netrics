import { describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import {
  readOnlyChallenge,
  runTest,
  type BuilderClient,
} from "./builder-actions";
import { ReadOnlyConfirm } from "./read-only-confirm";
import { D, DRAFT, TEST_RESPONSE, W } from "./test-fixtures";
import { CustomApiRequestError } from "@/lib/custom-api";
import {
  draftDefinitionOf,
  EMPTY_BODY,
  emptyBuilderState,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";
import { customApiDe } from "@/messages/custom-api/de";
import { customApiEn } from "@/messages/custom-api/en";

// ADR 0030 §2: a JSON-body POST test is sent only after its author
// confirmed exactly that request (review round 2 of #882).

const HASH = "a".repeat(64);

function jsonPost(): BuilderState {
  const state = emptyBuilderState("en", "UTC");
  return {
    ...state,
    stream: {
      ...state.stream,
      path: "/query",
      method: "POST",
      body: {
        ...EMPTY_BODY,
        kind: "json",
        json: JSON.stringify({ kind: "EventsQuery", limit: 10 }),
      },
    },
  };
}

describe("the read-only confirmation of a test", () => {
  it("reads the challenge from a refused test, nothing else", () => {
    expect(
      readOnlyChallenge(
        new CustomApiRequestError(
          400,
          "custom_api_read_only_unconfirmed",
          [],
          null,
          HASH,
        ),
      ),
    ).toBe(HASH);
    expect(
      readOnlyChallenge(new CustomApiRequestError(400, "invalid_request")),
    ).toBeNull();
    expect(readOnlyChallenge(new Error("x"))).toBeNull();
  });

  it("sends the test again with the confirmation", async () => {
    const testDraft = vi.fn(async () => ({
      ...TEST_RESPONSE,
      draft: DRAFT,
    }));
    const api = {
      testDraft,
      updateDraft: vi.fn(async () => DRAFT),
    } as unknown as BuilderClient;
    await runTest(api, W, D, jsonPost(), 1, {}, HASH);
    expect(testDraft).toHaveBeenCalledWith(
      W,
      D,
      expect.objectContaining({
        readOnlyConfirmation: HASH,
        definition: expect.objectContaining({
          stream: expect.objectContaining({
            request: expect.objectContaining({ method: "POST" }),
          }),
        }),
      }),
    );
  });

  it.each<Locale>(["en", "de"])(
    "shows the exact request and asks to confirm (%s)",
    (locale) => {
      const c = (locale === "de" ? customApiDe : customApiEn).customApi.test
        .readOnly;
      const html = renderI18n(
        <ReadOnlyConfirm
          request={draftDefinitionOf(jsonPost()).stream.request}
          pending={false}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
        locale,
      ).replaceAll("&#x27;", "'");
      expect(html).toContain("POST /query");
      expect(html).toContain("&quot;kind&quot;: &quot;EventsQuery&quot;");
      expect(html).toContain(c.title);
      expect(html).toContain(c.confirm);
      // The send button waits for the confirmation.
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<\/button>/);
    },
  );
});
