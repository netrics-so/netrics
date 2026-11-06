import { afterEach, describe, expect, it, vi } from "vitest";

import { relayOAuthCallback } from "./oauth-callback";

// The web callback route (ADR 0012): forwards the provider's query with the
// session cookie to the API and answers 303 to the app path it returns.

const API = "http://api.internal:3001";

function browserRequest(query: string, headers: Record<string, string> = {}) {
  return new Request(
    `https://netrics.example.com/oauth/google/callback${query}`,
    {
      headers: {
        cookie: "better-auth.session_token=abc",
        "sec-fetch-site": "cross-site",
        referer: "https://accounts.google.com/",
        "x-forwarded-for": "198.51.100.7",
        ...headers,
      },
    },
  );
}

function stubApi(response: () => Response) {
  vi.stubEnv("NETRICS_API_URL", API);
  const upstream = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => response(),
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function expectSeeOther(response: Response, location: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(location);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("relayOAuthCallback", () => {
  it("forwards state and code with the session cookie and redirects to the API's path", async () => {
    const upstream = stubApi(() =>
      Response.json({
        outcome: "connected",
        redirectTo: "/workspaces/w/connections/new?oauth=connected",
      }),
    );
    const response = await relayOAuthCallback(
      browserRequest("?state=s-123&code=c-456&scope=openid&authuser=0"),
      "google",
    );
    expectSeeOther(response, "/workspaces/w/connections/new?oauth=connected");

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/v1/oauth/google/callback`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      state: "s-123",
      code: "c-456",
    });
    // Only the cookie and the client address cross; the browser's
    // cross-site fetch metadata and referer do not.
    const headers = Object.fromEntries(new Headers(init?.headers));
    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      cookie: "better-auth.session_token=abc",
      "x-forwarded-for": "198.51.100.7",
      "x-real-ip": "198.51.100.7",
    });
  });

  it("forwards a provider error", async () => {
    const upstream = stubApi(() =>
      Response.json({ outcome: "denied", redirectTo: "/?oauth=denied" }),
    );
    const response = await relayOAuthCallback(
      browserRequest("?error=access_denied&state=s-1"),
      "google",
    );
    expectSeeOther(response, "/?oauth=denied");
    expect(JSON.parse(upstream.mock.calls[0]![1]?.body as string)).toEqual({
      state: "s-1",
      error: "access_denied",
    });
  });

  it("never redirects anywhere but a relative app path", async () => {
    for (const redirectTo of [
      "//evil.example/",
      "https://evil.example/",
      "/\\evil.example",
    ]) {
      stubApi(() => Response.json({ outcome: "connected", redirectTo }));
      expectSeeOther(
        await relayOAuthCallback(browserRequest("?state=s&code=c"), "google"),
        "/?oauth=failed",
      );
    }
  });

  it("sends signed-out users to the login page", async () => {
    stubApi(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expectSeeOther(
      await relayOAuthCallback(browserRequest("?state=s&code=c"), "google"),
      "/login",
    );
  });

  it("fails closed when the API errors or is unreachable", async () => {
    stubApi(() => Response.json({ error: "internal" }, { status: 500 }));
    expectSeeOther(
      await relayOAuthCallback(browserRequest("?state=s&code=c"), "google"),
      "/?oauth=failed",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expectSeeOther(
      await relayOAuthCallback(browserRequest("?state=s&code=c"), "google"),
      "/?oauth=failed",
    );
  });

  it("refuses a malformed provider without calling the API", async () => {
    const upstream = stubApi(() => Response.json({}));
    expectSeeOther(
      await relayOAuthCallback(browserRequest("?state=s"), "../admin"),
      "/?oauth=failed",
    );
    expect(upstream).not.toHaveBeenCalled();
  });
});
