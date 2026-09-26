/**
 * Focused tests for the web-side session guard. The milestone requires that
 * expired/revoked sessions fail consistently in web and API clients; the API
 * side is covered by the server suites, and getSessionUser is the web side's
 * single decision point (any non-ok/unparseable/empty answer from
 * /api/auth/get-session means "logged out"). next/headers and next/navigation
 * are mocked so this runs as a plain node test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Map([["cookie", "better-auth.session_token=abc"]]),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { getSessionUser, requireSession } from "./session";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sessionBody = {
  user: { id: "u1", email: "a@example.com", name: "A" },
  session: { id: "s1" },
};

describe("getSessionUser", () => {
  it("returns the user for a valid session", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionBody));
    const user = await getSessionUser("better-auth.session_token=abc");
    expect(user).toEqual(sessionBody.user);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/auth/get-session",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns null when the API rejects the session (401, e.g. revoked)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, null));
    expect(await getSessionUser("cookie")).toBeNull();
  });

  it("returns null when the API reports no session (200 with null body, e.g. expired)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    expect(await getSessionUser("cookie")).toBeNull();
  });

  it("returns null on malformed or unexpected payloads", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 42 } }));
    expect(await getSessionUser("cookie")).toBeNull();

    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await getSessionUser("cookie")).toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await getSessionUser("cookie")).toBeNull();
  });
});

describe("requireSession", () => {
  it("returns the forwarded cookie header and user when authenticated", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sessionBody));
    const result = await requireSession();
    expect(result.user).toEqual(sessionBody.user);
    expect(result.cookieHeader).toBe("better-auth.session_token=abc");
    // The incoming cookie header is forwarded verbatim to the API.
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({
      cookie: "better-auth.session_token=abc",
    });
  });

  it("redirects to /login when the session is expired or revoked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");

    fetchMock.mockResolvedValue(jsonResponse(401, null));
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });
});
