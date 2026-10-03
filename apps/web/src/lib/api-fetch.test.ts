import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch,
  apiUrl,
  isSingleIp,
  outboundHeaders,
  proxySecret,
} from "./api-fetch";

// The one web→API fetch (#155): every call site relies on these defaults.

function stubFetch() {
  const upstream = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("apiFetch", () => {
  it("reads NETRICS_API_URL on every call, not at import", async () => {
    const upstream = stubFetch();
    vi.stubEnv("NETRICS_API_URL", "http://api.internal:3001");
    await apiFetch("/v1/me");
    vi.stubEnv("NETRICS_API_URL", "https://api.example.com/");
    await apiFetch("/v1/workspaces?limit=5");
    expect(upstream.mock.calls.map(([url]) => String(url))).toEqual([
      "http://api.internal:3001/v1/me",
      "https://api.example.com/v1/workspaces?limit=5",
    ]);
  });

  it("defaults to the local API", () => {
    vi.stubEnv("NETRICS_API_URL", undefined);
    expect(apiUrl("/health/live")).toBe("http://localhost:3001/health/live");
  });

  it("never caches and does not follow redirects by default", async () => {
    const upstream = stubFetch();
    await apiFetch("/v1/me", { headers: { cookie: "a=1" } });
    const init = upstream.mock.calls[0]![1]!;
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      cookie: "a=1",
    });
  });

  it("passes method, body and an explicit redirect mode through", async () => {
    const upstream = stubFetch();
    await apiFetch("/v1/echo", {
      method: "POST",
      body: "{}",
      redirect: "follow",
    });
    const init = upstream.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.redirect).toBe("follow");
  });

  it.each(["http://evil.example/v1/me", "//evil.example/v1/me", "v1/me", ""])(
    "refuses %j instead of a path on the API",
    async (path) => {
      const upstream = stubFetch();
      await expect(apiFetch(path)).rejects.toThrow(TypeError);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("passes the API's answer back untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "x" }, { status: 409 })),
    );
    const response = await apiFetch("/v1/me");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "x" });
  });
});

describe("outbound headers", () => {
  it("drops forwarding headers a caller copied, without a client", () => {
    const headers = outboundHeaders(
      {
        cookie: "a=1",
        "x-forwarded-for": "203.0.113.66",
        "x-real-ip": "203.0.113.66",
        forwarded: "for=203.0.113.66",
      },
      undefined,
    );
    expect(Object.fromEntries(headers)).toEqual({ cookie: "a=1" });
  });

  it("forwards the client address the trusted proxy saw", () => {
    const headers = outboundHeaders(
      { "x-forwarded-for": "192.0.2.1" },
      new Headers({ "x-forwarded-for": "203.0.113.66, 198.51.100.7" }),
    );
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(headers.get("x-real-ip")).toBe("198.51.100.7");
  });

  it("honours NETRICS_TRUSTED_PROXY_HOPS and NETRICS_CLIENT_IP_HEADER", () => {
    const client = new Headers({
      "x-forwarded-for": "203.0.113.66, 198.51.100.7, 192.0.2.10",
      "x-vercel-forwarded-for": "198.51.100.99",
    });
    vi.stubEnv("NETRICS_TRUSTED_PROXY_HOPS", "2");
    expect(outboundHeaders(undefined, client).get("x-real-ip")).toBe(
      "198.51.100.7",
    );
    vi.stubEnv("NETRICS_CLIENT_IP_HEADER", " X-Vercel-Forwarded-For ");
    expect(outboundHeaders(undefined, client).get("x-real-ip")).toBe(
      "198.51.100.99",
    );
  });

  it("sends no address when the client request has none", () => {
    const headers = outboundHeaders(undefined, new Headers());
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
  });
});

describe("proxy secret (ADR 0013, #156)", () => {
  const SECRET = "proxy-secret-current-0123456789abcdef";

  it("sends neither header without NETRICS_PROXY_SECRET, and drops forged ones", () => {
    vi.stubEnv("NETRICS_PROXY_SECRET", undefined);
    const headers = outboundHeaders(
      {
        "x-netrics-proxy-secret": "forged",
        "X-Netrics-Client-Ip": "192.0.2.1",
      },
      new Headers({ "x-forwarded-for": "198.51.100.7" }),
    );
    expect(headers.get("x-netrics-proxy-secret")).toBeNull();
    expect(headers.get("x-netrics-client-ip")).toBeNull();
    expect(headers.get("x-real-ip")).toBe("198.51.100.7");
  });

  it("sends the secret and the resolved client address", () => {
    vi.stubEnv("NETRICS_PROXY_SECRET", SECRET);
    vi.stubEnv("NETRICS_CLIENT_IP_HEADER", "x-vercel-forwarded-for");
    const headers = outboundHeaders(
      {
        "x-netrics-proxy-secret": "forged",
        "x-netrics-client-ip": "192.0.2.1",
      },
      new Headers({
        "x-vercel-forwarded-for": "2001:db8::7",
        "x-netrics-client-ip": "192.0.2.2",
      }),
    );
    expect(headers.get("x-netrics-proxy-secret")).toBe(SECRET);
    expect(headers.get("x-netrics-client-ip")).toBe("2001:db8::7");
  });

  it("sends the secret without an address on calls with no client request", () => {
    vi.stubEnv("NETRICS_PROXY_SECRET", SECRET);
    const headers = outboundHeaders({ cookie: "a=1" }, undefined);
    expect(Object.fromEntries(headers)).toEqual({
      cookie: "a=1",
      "x-netrics-proxy-secret": SECRET,
    });
  });

  it.each(["198.51.100.1, 198.51.100.2", "198.51.100.1:443", "unknown"])(
    "sends no client address for %j",
    (value) => {
      vi.stubEnv("NETRICS_PROXY_SECRET", SECRET);
      vi.stubEnv("NETRICS_CLIENT_IP_HEADER", "x-vercel-forwarded-for");
      const headers = outboundHeaders(
        undefined,
        new Headers({ "x-vercel-forwarded-for": value }),
      );
      expect(headers.get("x-netrics-proxy-secret")).toBe(SECRET);
      expect(headers.get("x-netrics-client-ip")).toBeNull();
    },
  );

  it("sends the first value of a rotation list", () => {
    vi.stubEnv("NETRICS_PROXY_SECRET", ` ${SECRET} , previous-value`);
    expect(proxySecret()).toBe(SECRET);
    vi.stubEnv("NETRICS_PROXY_SECRET", " ");
    expect(proxySecret()).toBeNull();
  });

  it("carries the headers on every apiFetch call", async () => {
    const upstream = stubFetch();
    vi.stubEnv("NETRICS_PROXY_SECRET", SECRET);
    await apiFetch("/v1/me", {
      client: new Headers({ "x-forwarded-for": "198.51.100.8" }),
    });
    const sent = new Headers(upstream.mock.calls[0]![1]!.headers);
    expect(sent.get("x-netrics-proxy-secret")).toBe(SECRET);
    expect(sent.get("x-netrics-client-ip")).toBe("198.51.100.8");
  });
});

describe("isSingleIp", () => {
  it.each([
    "192.0.2.1",
    "0.0.0.0",
    "255.255.255.255",
    "2001:db8::1",
    "::1",
    "::ffff:192.0.2.1",
  ])("accepts %j", (value) => {
    expect(isSingleIp(value)).toBe(true);
  });

  it.each([
    "",
    "256.0.0.1",
    "192.0.2",
    "01.2.3.4",
    "192.0.2.1,192.0.2.2",
    "192.0.2.1:80",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "2001:db8::1::2",
    "example.com",
    "gggg::1",
  ])("refuses %j", (value) => {
    expect(isSingleIp(value)).toBe(false);
  });
});
