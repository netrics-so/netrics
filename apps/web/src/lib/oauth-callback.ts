/**
 * The web half of the OAuth callback (ADR 0012). The provider redirects the
 * browser here with `state` and `code` (or `error`); this forwards them with
 * the session cookie to the API (through apiFetch, like the /v1 proxy), which
 * validates the state, exchanges the code and stores the grant. The browser
 * gets a 303 to the relative app path the API returns, never a token.
 *
 * The query is never logged, and the response carries `Referrer-Policy:
 * no-referrer` and `Cache-Control: no-store`, so the single-use values do
 * not leak through a Referer header or a cache.
 */

import { oauthCallbackResponseSchema } from "@netrics/contracts";

import { apiFetch } from "./api-fetch";

const PROVIDER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Bounds of the forwarded values (the API's contract checks them again).
const MAX_LENGTH = { state: 512, code: 4096, error: 256 } as const;

/** A 303 to a relative app path, uncacheable and without a Referer. */
export function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: path,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function queryValues(url: URL): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ["state", "code", "error"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "" && value.length <= MAX_LENGTH[key]) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * The headers of the call to the API: the session cookie, nothing else
 * (apiFetch adds the client address). The browser's own headers are not
 * forwarded: it
 * arrives from the provider's site (Sec-Fetch-Site: cross-site), and the
 * state, bound to the user who started the flow, is what protects this call.
 */
export function callbackHeaders(incoming: Headers): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
  });
  const cookie = incoming.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  return headers;
}

export async function relayOAuthCallback(
  request: Request,
  provider: string,
): Promise<Response> {
  if (!PROVIDER.test(provider)) {
    return seeOther("/?oauth=failed");
  }
  let upstream: Response;
  try {
    upstream = await apiFetch(`/v1/oauth/${provider}/callback`, {
      method: "POST",
      headers: callbackHeaders(request.headers),
      client: request.headers,
      body: JSON.stringify(queryValues(new URL(request.url))),
      redirect: "manual",
    });
  } catch {
    return seeOther("/?oauth=failed");
  }
  if (upstream.status === 401) {
    // Signed out meanwhile: the state stays unused and expires.
    return seeOther("/login");
  }
  if (upstream.status !== 200) {
    return seeOther("/?oauth=failed");
  }
  const parsed = oauthCallbackResponseSchema.safeParse(
    await upstream.json().catch(() => null),
  );
  return seeOther(parsed.success ? parsed.data.redirectTo : "/?oauth=failed");
}
