import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomApiRequestError, testDraft, updateDraft } from "./custom-api";
import { draftDefinitionOf, emptyBuilderState } from "./custom-api-builder";
import {
  D,
  DRAFT as draft,
  TEST_RESPONSE,
  W,
} from "@/components/custom-api/test-fixtures";

// The builder's browser client (#807).

const definition = () => {
  const state = emptyBuilderState("en", "UTC");
  state.name = "Shop API";
  state.environments[0]!.baseUrl = "https://api.example.test";
  state.stream.path = "/stats";
  return draftDefinitionOf(state);
};

afterEach(() => vi.unstubAllGlobals());

describe("custom API client", () => {
  it("sends the test request and parses the response", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(TEST_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await testDraft(W, D, {
      definition: definition(),
      environmentId: "production",
      pages: 1,
    });
    expect(result.log[0]!.status).toBe(200);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(`/v1/workspaces/${W}/custom-api/drafts/${D}/test`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      environmentId: "production",
      pages: 1,
      definition: { stream: { request: { path: "/stats" } } },
    });
  });

  it("says how long to wait when test requests are rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "custom_api_test_rate_limited" }),
            { status: 429, headers: { "retry-after": "42" } },
          ),
      ),
    );
    const error = await testDraft(W, D, {
      definition: definition(),
      environmentId: "production",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CustomApiRequestError);
    expect(error).toMatchObject({
      code: "custom_api_test_rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("sends only the secrets given and answers their names", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ draft }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const stored = await updateDraft(W, D, {
      definition: definition(),
      environmentId: "production",
      secrets: { token: "secret-token-value" },
    });
    expect(stored.secretsSet).toEqual(["token"]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string).secrets).toEqual({
      token: "secret-token-value",
    });
  });
});
