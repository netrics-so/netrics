/**
 * Server-side API calls carry the browser's language (#770). The API
 * localizes by the user's setting, the instance default, then
 * Accept-Language (ADR 0016); the web page resolves its language the same
 * way. A server component that forwarded only the cookie made the API answer
 * in English for a user without a language setting while the page rendered
 * in the browser's language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const incoming = new Headers({
  cookie: "better-auth.session_token=abc",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8",
  "user-agent": "browser",
  "x-forwarded-for": "203.0.113.7",
});

vi.mock("next/headers", () => ({ headers: async () => incoming }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Outside a React server render cache() does not memoize; keep it simple.
  cache: <T>(fn: T) => fn,
}));

import { forwardedHeaders } from "./api-fetch";
import { getMe, listConnectors } from "./api";
import { getCurrentMe } from "./current-user";
import { getDataWorkspace } from "./data-api";
import { requireSession } from "./session";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sentHeaders(call = 0): Headers {
  return new Headers(fetchMock.mock.calls[call]![1]!.headers);
}

describe("forwardedHeaders", () => {
  it("keeps the cookie and Accept-Language of the browser request, nothing else", () => {
    expect(Object.fromEntries(forwardedHeaders(incoming))).toEqual({
      cookie: "better-auth.session_token=abc",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
    });
  });

  it("leaves out what the browser did not send", () => {
    expect(Object.fromEntries(forwardedHeaders(new Headers()))).toEqual({});
  });
});

describe("server-side API calls", () => {
  it("send the browser's Accept-Language with the cookie from a page", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ user: { id: "u1", email: "a@example.com", name: "A" } }),
    );
    const { forwarded } = await requireSession();
    expect(sentHeaders(0).get("accept-language")).toBe(
      "de-DE,de;q=0.9,en;q=0.8",
    );

    fetchMock.mockResolvedValueOnce(json({ connectors: [] }));
    await listConnectors(forwarded);
    const headers = sentHeaders(1);
    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(headers.get("accept-language")).toBe("de-DE,de;q=0.9,en;q=0.8");
    // Never the browser's own forwarding headers or anything else.
    expect(headers.get("user-agent")).toBeNull();
  });

  it("send it on the /v1/me call that decides the page language", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await getCurrentMe();
    expect(sentHeaders().get("accept-language")).toBe(
      "de-DE,de;q=0.9,en;q=0.8",
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await getMe(forwardedHeaders(incoming));
    expect(sentHeaders(1).get("accept-language")).toBe(
      "de-DE,de;q=0.9,en;q=0.8",
    );
  });

  it("send it from the data page's fetchers", async () => {
    fetchMock.mockImplementation(async () =>
      json({ sources: [], preparations: [], models: [], installs: [] }),
    );
    await getDataWorkspace("w1", forwardedHeaders(incoming));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init!.headers).get("accept-language")).toBe(
        "de-DE,de;q=0.9,en;q=0.8",
      );
    }
  });
});
