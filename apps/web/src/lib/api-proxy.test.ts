import { describe, expect, it } from "vitest";

import {
  clientIp,
  proxyRequestHeaders,
  proxyResponseHeaders,
} from "./api-proxy";

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

  it("forwards only the client address the trusted proxy saw", () => {
    // The client sent a forged chain; the proxy in front of the web server
    // appended the address it really received the request from.
    const headers = proxyRequestHeaders(
      new Headers({
        "x-forwarded-for": "203.0.113.66, 10.0.0.9, 198.51.100.7",
        "x-real-ip": "203.0.113.66",
        forwarded: "for=203.0.113.66",
      }),
      1,
    );
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(headers.get("x-real-ip")).toBe("198.51.100.7");
    expect(headers.get("forwarded")).toBeNull();
  });

  it("walks back one entry per configured proxy hop", () => {
    const incoming = new Headers({
      "x-forwarded-for": "203.0.113.66, 198.51.100.7, 192.0.2.10",
    });
    expect(clientIp(incoming, 1)).toBe("192.0.2.10");
    expect(clientIp(incoming, 2)).toBe("198.51.100.7");
    // More hops than entries: the leftmost address is all there is.
    expect(clientIp(incoming, 5)).toBe("203.0.113.66");
  });

  it("sends no forwarding headers when there is no address", () => {
    const headers = proxyRequestHeaders(
      new Headers({ "x-real-ip": "1.2.3.4" }),
    );
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
  });

  it("can take the client address from a header the edge sets", () => {
    const incoming = new Headers({
      "x-forwarded-for": "203.0.113.66, 100.64.0.3, 100.64.0.4",
      "x-real-ip": "198.51.100.7",
    });
    expect(clientIp(incoming, 1, "x-real-ip")).toBe("198.51.100.7");
    const headers = proxyRequestHeaders(incoming, 1, "x-real-ip");
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
  });
});
