import { describe, expect, it } from "vitest";

import { proxyRequestHeaders, proxyResponseHeaders } from "./api-proxy";

describe("api proxy headers", () => {
  it("forwards end-to-end request headers and drops hop-by-hop ones", () => {
    const headers = proxyRequestHeaders(
      new Headers({
        cookie: "better-auth.session_token=abc",
        origin: "https://netrics.example.com",
        "content-type": "application/json",
        connection: "keep-alive",
        host: "netrics.example.com",
        "transfer-encoding": "chunked",
        "content-length": "12",
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({
      cookie: "better-auth.session_token=abc",
      origin: "https://netrics.example.com",
      "content-type": "application/json",
    });
  });

  it("keeps every Set-Cookie and drops encodings fetch already undid", () => {
    const upstream = new Headers({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "99",
    });
    upstream.append("set-cookie", "a=1; Path=/; HttpOnly");
    upstream.append("set-cookie", "b=2; Path=/; Secure");
    const headers = proxyResponseHeaders(upstream);
    expect(headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; Secure",
    ]);
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });
});
