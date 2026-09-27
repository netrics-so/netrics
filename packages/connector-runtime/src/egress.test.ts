import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EgressDeniedError,
  createEgressFetch,
  hostAllowed,
  isBlockedAddress,
} from "./egress.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "76.76.21.21", "2606:4700:4700::1111"])(
    "allows public %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("hostAllowed", () => {
  const allowed = ["api.vercel.com", "*.example.com"];
  it("matches exact hosts and wildcard subdomains only", () => {
    expect(hostAllowed("api.vercel.com", allowed)).toBe(true);
    expect(hostAllowed("API.Vercel.com.", allowed)).toBe(true);
    expect(hostAllowed("a.b.example.com", allowed)).toBe(true);
    expect(hostAllowed("example.com", allowed)).toBe(false);
    expect(hostAllowed("evilexample.com", allowed)).toBe(false);
    expect(hostAllowed("api.vercel.com.evil.test", allowed)).toBe(false);
    expect(hostAllowed("vercel.com", allowed)).toBe(false);
  });
});

// A local fixture server reached under fake public names via a custom lookup.
let server: Server;
let port: number;
const toLocalhost: LookupFunction = (_hostname, options, callback) => {
  const entry = { address: "127.0.0.1", family: 4 };
  if (options.all) {
    (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [
      entry,
    ]);
  } else {
    callback(null, entry.address, entry.family);
  }
};

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/ok") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ hello: "world" }));
    } else if (request.url === "/redirect-out") {
      response.statusCode = 302;
      response.setHeader("location", "http://evil.test/steal");
      response.end();
    } else if (request.url === "/loop") {
      response.statusCode = 302;
      response.setHeader("location", "/loop");
      response.end();
    } else if (request.url === "/big") {
      response.end("x".repeat(2048));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function fixtureFetch(
  overrides: Partial<Parameters<typeof createEgressFetch>[0]> = {},
) {
  return createEgressFetch({
    allowedDomains: ["api.fixture.test"],
    signal: new AbortController().signal,
    lookup: toLocalhost,
    allowPrivateAddresses: true,
    allowInsecureHttp: true,
    ...overrides,
  });
}

describe("createEgressFetch", () => {
  it("fetches from a declared host", async () => {
    const response = await fixtureFetch()(`http://api.fixture.test:${port}/ok`);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ hello: "world" });
  });

  it("refuses plain http, undeclared hosts, private IP literals and URL credentials", async () => {
    const strict = createEgressFetch({
      allowedDomains: ["api.fixture.test", "10.0.0.1"],
      signal: new AbortController().signal,
    });
    for (const url of [
      "http://api.fixture.test/ok",
      "https://undeclared.test/ok",
      "https://10.0.0.1/ok",
      "https://user:pass@api.fixture.test/ok",
    ]) {
      await expect(strict(url)).rejects.toThrow(EgressDeniedError);
    }
  });

  it("checks resolved addresses at connect time (no DNS rebinding)", async () => {
    // The name is declared, but resolves to 127.0.0.1.
    const guarded = fixtureFetch({ allowPrivateAddresses: false });
    await expect(guarded(`http://api.fixture.test:${port}/ok`)).rejects.toThrow(
      /non-public address/,
    );
  });

  it("re-checks every redirect and caps them", async () => {
    await expect(
      fixtureFetch()(`http://api.fixture.test:${port}/redirect-out`),
    ).rejects.toThrow(/evil\.test is not in the connector's outboundDomains/);
    await expect(
      fixtureFetch()(`http://api.fixture.test:${port}/loop`),
    ).rejects.toThrow(/too many redirects/);
  });

  it("bounds the response size", async () => {
    await expect(
      fixtureFetch({ maxResponseBytes: 1024 })(
        `http://api.fixture.test:${port}/big`,
      ),
    ).rejects.toThrow(/exceeds 1024 bytes/);
  });
});
