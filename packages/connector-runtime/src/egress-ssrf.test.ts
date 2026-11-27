// The SSRF suite for the connector egress guard (#801): every address form a
// user-written custom API definition could use to reach this host, a private
// network or a metadata service, DNS rebinding, redirects, decompression
// bombs and slow providers. Each case fails on the guard before #801.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EgressDeniedError,
  EgressTimeoutError,
  createEgressFetch,
  isBlockedAddress,
  isMetadataAddress,
  broadPrivateHostEntries,
  parsePrivateHostEntries,
  privateHostPolicy,
  type EgressOptions,
} from "./egress.js";

const MIB = 1024 * 1024;

describe("isBlockedAddress (SSRF)", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.0.192",
    "100.100.100.200",
    "192.88.99.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::7f00:1",
    "::a00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2001::1",
    "2002:7f00:1::",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ])("blocks %s", (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "100:0:0:1::1",
    // Mapped and compatible forms of a public address stay that address.
    "::ffff:1.1.1.1",
    "::ffff:101:101",
    "::101:101",
  ])("allows public %s", (a) => expect(isBlockedAddress(a)).toBe(false));
});

describe("tunnelled and legacy IPv6 forms (each named, so a regression points at the form)", () => {
  it.each([
    ["IPv4-compatible loopback", "::7f00:1"],
    ["IPv4-compatible private", "::a00:1"],
    ["IPv4-compatible metadata", "::a9fe:a9fe"],
    ["6to4 of loopback", "2002:7f00:1::"],
    ["6to4 of a public address (whole 2002::/16 refused)", "2002:101:101::1"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["Teredo prefix", "2001::1"],
    ["site-local", "fec0::1"],
    ["site-local upper", "feff:ffff::1"],
    ["IPv4-translated loopback", "::ffff:0:7f00:1"],
    [
      "IPv4-translated public (whole ::ffff:0:0:0/96 refused)",
      "::ffff:0:101:101",
    ],
    ["IPv4-translated dotted", "::ffff:0:10.0.0.1"],
    ["reserved ::/8 outside the /96 ranges", "::ffff:1:7f00:1"],
    ["reserved ::/8, public-looking tail", "::1:0:0:101:101"],
    [
      "reserved ::/8, top of the range",
      "ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ],
  ])("blocks %s (%s)", (_name, a) => expect(isBlockedAddress(a)).toBe(true));
});

describe("isMetadataAddress", () => {
  it.each([
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::",
    "fd00:ec2::254",
    "100.100.100.200",
    "192.0.0.192",
    "fe80::1",
    "::ffff:0:a9fe:a9fe",
    "::ffff:0:169.254.169.254",
  ])("%s", (a) => expect(isMetadataAddress(a)).toBe(true));
  it("does not treat ordinary private addresses as metadata", () => {
    expect(isMetadataAddress("10.0.0.1")).toBe(false);
    expect(isMetadataAddress("127.0.0.1")).toBe(false);
    expect(isMetadataAddress("fd12::1")).toBe(false);
  });
});

describe("broadPrivateHostEntries", () => {
  it("names single-label wildcards and localhost", () =>
    expect(
      broadPrivateHostEntries([
        "*.com",
        "*.local",
        "*.co.uk",
        "*.com.au",
        "*.github.io",
        "localhost",
        "api.localhost",
        "*.corp.example",
        "*.example.co.uk",
        "intranet.example",
        "intranet",
        "10.20.0.0/16",
        "127.0.0.1",
      ]),
    ).toEqual([
      "*.com",
      "*.local",
      "*.co.uk",
      "*.com.au",
      "*.github.io",
      "localhost",
      "api.localhost",
    ]));
});

describe("private host entries", () => {
  it("accepts host patterns, addresses and ranges", () =>
    expect(
      parsePrivateHostEntries([
        " Intranet.Example ",
        "*.corp.example",
        "10.20.0.0/16",
        "fd12::/48",
        "127.0.0.1",
        "",
      ]),
    ).toEqual([
      "intranet.example",
      "*.corp.example",
      "10.20.0.0/16",
      "fd12::/48",
      "127.0.0.1",
    ]));
  it.each([
    "*",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/7",
    "fd00::/8",
    "10.0.0.0/33",
    "fd12::/129",
    "10.0.0.0/x",
    "http://x",
    "a b",
    "*.*.example",
    "intranet.example:8080",
  ])("refuses %s", (entry) =>
    expect(() => parsePrivateHostEntries([entry])).toThrow(
      /invalid private host entry/,
    ),
  );
  it("never allows metadata, even for a listed host or range", () => {
    const policy = privateHostPolicy(["intranet.example", "169.254.0.0/16"]);
    expect(policy.allows("intranet.example", "10.1.2.3")).toBe(true);
    expect(policy.allows("intranet.example", "169.254.169.254")).toBe(false);
    expect(policy.allows("other.example", "10.1.2.3")).toBe(false);
    expect(policy.allows("other.example", "169.254.1.1")).toBe(false);
  });
  it("matches addresses inside listed ranges, including IPv4-mapped forms", () => {
    const policy = privateHostPolicy(["10.20.0.0/16", "fd12::/48"]);
    expect(policy.allows("any.example", "10.20.3.4")).toBe(true);
    expect(policy.allows("any.example", "::ffff:10.20.3.4")).toBe(true);
    expect(policy.allows("any.example", "10.21.0.1")).toBe(false);
    expect(policy.allows("any.example", "fd12:0:0:1::1")).toBe(true);
    expect(policy.allows("any.example", "fd13::1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The suite's own fixture servers, reached under fake names via a lookup.

let server: Server;
let port: number;
let otherServer: Server;
let otherPort: number;
let tlsServer: Server;
let tlsPort: number;
let certPem: string;
let certDir: string;
let bomb: Buffer;
let chainedBomb: Buffer;
const BROTLI_BODY = Buffer.alloc(2 * MIB, "a");
const BROTLI = brotliCompressSync(BROTLI_BODY);
const timers = new Set<ReturnType<typeof setInterval>>();

function url(path: string, host = "api.fixture.test") {
  return `http://${host}:${port}${path}`;
}

function redirect(response: ServerResponse, location: string) {
  response.statusCode = 302;
  response.setHeader("location", location);
  response.end();
}

function route(request: IncomingMessage, response: ServerResponse) {
  // A fresh socket per request, so every request runs the lookup again.
  response.setHeader("connection", "close");
  switch (request.url?.split("?")[0]) {
    case "/ok":
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    case "/echo-auth":
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization ?? null,
          proxyAuthorization: request.headers["proxy-authorization"] ?? null,
          cookie: request.headers.cookie ?? null,
          custom: request.headers["x-custom"] ?? null,
        }),
      );
      return;
    case "/to-self":
      return redirect(response, "/echo-auth");
    case "/to-sibling":
      return redirect(
        response,
        `http://cdn.fixture.test:${port}/echo-auth?sig=secret-query`,
      );
    case "/to-sibling-then-self":
      return redirect(response, `http://cdn.fixture.test:${port}/to-self`);
    case "/to-sibling-then-back":
      return redirect(
        response,
        `http://cdn.fixture.test:${port}/to-api-echo-auth`,
      );
    case "/to-api-echo-auth":
      return redirect(response, `http://api.fixture.test:${port}/echo-auth`);
    case "/to-other-port":
      return redirect(response, `http://api.fixture.test:${otherPort}/ok`);
    case "/to-https":
      return redirect(response, `https://api.fixture.test:${port}/ok`);
    case "/to-metadata":
      return redirect(response, "http://169.254.169.254/latest/meta-data");
    case "/to-metadata-v6":
      return redirect(response, "http://[fd00:ec2::254]/latest/meta-data");
    case "/to-decimal":
      return redirect(response, "http://2130706433/");
    case "/to-mapped":
      return redirect(response, "http://[::ffff:7f00:1]/");
    case "/gzip-json":
      response.setHeader("content-type", "application/json");
      response.setHeader("content-encoding", "gzip");
      response.end(gzipSync(JSON.stringify({ ok: true })));
      return;
    case "/bomb":
      // No content-length: only the decoded count can stop it.
      response.setHeader("content-encoding", "gzip");
      response.write(bomb);
      response.end();
      return;
    case "/bomb-chained":
      response.setHeader("content-encoding", "gzip, gzip");
      response.write(chainedBomb);
      response.end();
      return;
    case "/brotli":
      response.setHeader("content-encoding", "br");
      response.end(BROTLI);
      return;
    case "/unknown-coding":
      response.setHeader("content-encoding", "x-custom");
      response.write(Buffer.alloc(2048, 0x8b));
      response.end();
      return;
    case "/identity-gzip":
      // undici leaves a body with an unknown coding in the chain raw, so it
      // must count against the wire limit.
      response.setHeader("content-encoding", "gzip, identity");
      response.write(Buffer.alloc(2048, 0x8b));
      response.end();
      return;
    case "/slow-headers": {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.end("late");
      }, 500);
      timers.add(timer);
      return;
    }
    case "/drip": {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (response.destroyed || sent > 20) {
          clearInterval(timer);
          timers.delete(timer);
          if (!response.destroyed) response.end();
          return;
        }
        response.write("x");
      }, 100);
      timers.add(timer);
      response.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
      return;
    }
    default:
      response.statusCode = 404;
      response.end();
  }
}

function listen(target: Server): Promise<number> {
  return new Promise((resolve) =>
    target.listen(0, "127.0.0.1", () =>
      resolve((target.address() as AddressInfo).port),
    ),
  );
}

beforeAll(async () => {
  bomb = gzipSync(Buffer.alloc(64 * MIB), { level: 9 });
  chainedBomb = gzipSync(bomb, { level: 9 });
  certDir = mkdtempSync(join(tmpdir(), "netrics-egress-ssrf-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  certPem = readFileSync(join(certDir, "cert.pem"), "utf8");
  server = createServer(route);
  otherServer = createServer(route);
  tlsServer = createHttpsServer(
    { cert: certPem, key: readFileSync(join(certDir, "key.pem")) },
    route,
  );
  [port, otherPort, tlsPort] = await Promise.all([
    listen(server),
    listen(otherServer),
    listen(tlsServer),
  ]);
});

afterAll(async () => {
  for (const timer of timers) clearInterval(timer);
  await Promise.all(
    [server, otherServer, tlsServer].map(
      (target) =>
        new Promise((resolve) => {
          target.closeAllConnections();
          target.close(resolve);
        }),
    ),
  );
  rmSync(certDir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function answer(
  callback: Parameters<LookupFunction>[2],
  all: boolean | undefined,
  addresses: readonly string[],
) {
  const list = addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  if (all) {
    (callback as unknown as (e: null, a: typeof list) => void)(null, list);
  } else {
    callback(null, list[0]!.address, list[0]!.family);
  }
}

const toLocalhost: LookupFunction = (_hostname, options, callback) =>
  answer(callback, options.all, ["127.0.0.1"]);

/** Answers the next scripted list per call (the last one repeats). */
function scriptedLookup(...answers: string[][]) {
  const lookup = ((_hostname, options, callback) => {
    const next = answers[Math.min(lookup.calls, answers.length - 1)]!;
    lookup.calls += 1;
    answer(callback, options.all, next);
  }) as LookupFunction & { calls: number };
  lookup.calls = 0;
  return lookup;
}

function fixtureGuard(overrides: Partial<EgressOptions> = {}) {
  // No allowPrivateAddresses: the private-host path is what is under test.
  return createEgressFetch({
    allowedDomains: ["api.fixture.test"],
    signal,
    lookup: toLocalhost,
    allowInsecureHttp: true,
    ...overrides,
  });
}

const privateFixture = { allowPrivateHosts: ["api.fixture.test"] };

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("addresses and DNS in the guard", () => {
  it("refuses encoded loopback literals after URL normalisation", async () => {
    const guard = createEgressFetch({
      allowedDomains: ["127.0.0.1", "::1", "::ffff:7f00:1", "::7f00:1"],
      signal,
    });
    for (const host of [
      "2130706433",
      "0x7f.1",
      "0177.0.0.1",
      "127.1",
      "[::ffff:127.0.0.1]",
      "[::1]",
      "[::7f00:1]",
    ]) {
      const error = await failure(guard(`https://${host}/ok`));
      expect(error).toBeInstanceOf(EgressDeniedError);
      expect(error.message).toMatch(/non-public address/);
    }
  });

  it("refuses metadata literals and names that resolve to them", async () => {
    const options = {
      allowedDomains: ["169.254.169.254", "fd00:ec2::254", "api.fixture.test"],
      // Listing them changes nothing: metadata is never reachable.
      allowPrivateHosts: [
        "api.fixture.test",
        "169.254.0.0/16",
        "fd00:ec2::/32",
      ],
    };
    const guard = fixtureGuard(options);
    for (const target of [
      "https://169.254.169.254/latest/meta-data",
      "https://[fd00:ec2::254]/",
    ]) {
      await expect(guard(target)).rejects.toThrow(/non-public address/);
    }
    for (const address of ["169.254.169.254", "fd00:ec2::254", "fe80::1"]) {
      const named = fixtureGuard({
        ...options,
        lookup: scriptedLookup([address]),
      });
      await expect(named(url("/ok"))).rejects.toThrow(
        /^egress denied: api\.fixture\.test resolves to a metadata address$/,
      );
      // Not even the tests-only escape hatch reaches metadata.
      const testsOnly = fixtureGuard({
        allowPrivateAddresses: true,
        lookup: scriptedLookup([address]),
      });
      await expect(testsOnly(url("/ok"))).rejects.toThrow(EgressDeniedError);
    }
  });

  it("refuses localhost and names that resolve to private addresses", async () => {
    const local = createEgressFetch({ allowedDomains: ["localhost"], signal });
    await expect(local("https://localhost/ok")).rejects.toThrow(
      /non-public address/,
    );
    for (const address of ["10.0.0.5", "::1", "192.168.1.1", "fd12::1"]) {
      const guard = fixtureGuard({ lookup: scriptedLookup([address]) });
      await expect(guard(url("/ok"))).rejects.toThrow(
        /^egress denied: api\.fixture\.test resolves to a non-public address$/,
      );
    }
  });

  it.each([
    ["IPv4-compatible", "::7f00:1"],
    ["6to4", "2002:7f00:1::"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["site-local", "fec0::1"],
    ["NAT64 local-use", "64:ff9b:1::1"],
  ])(
    "refuses a name resolving to a %s address, even with allowPrivateHosts for another host",
    async (_name, address) => {
      const guard = fixtureGuard({
        lookup: scriptedLookup([address]),
        allowPrivateHosts: ["other.test"],
      });
      await expect(guard(url("/ok"))).rejects.toThrow(/non-public address/);
    },
  );

  it("trusts a test certificate passed as tlsCa (tests only)", async () => {
    const options = {
      allowedDomains: ["127.0.0.1"],
      allowPrivateHosts: ["127.0.0.1"],
    };
    const target = `https://127.0.0.1:${tlsPort}/ok`;
    const untrusted = await failure(fixtureGuard(options)(target));
    expect(untrusted).not.toBeInstanceOf(EgressDeniedError);
    const trusted = await fixtureGuard({ ...options, tlsCa: certPem })(target);
    expect(trusted.status).toBe(200);
    expect(trusted.json()).toEqual({ ok: true });
  });

  it("pins the first validated answer for the rest of the call (DNS rebinding)", async () => {
    const lookup = scriptedLookup(["127.0.0.1"], ["169.254.169.254"]);
    const pinned = fixtureGuard({
      lookup,
      allowPrivateHosts: ["api.fixture.test"],
    });
    expect((await pinned(url("/ok"))).status).toBe(200);
    expect((await pinned(url("/ok"))).status).toBe(200);
    expect(lookup.calls).toBe(1);
    // Names are pinned case-insensitively.
    expect((await pinned(url("/ok", "API.Fixture.Test"))).status).toBe(200);
    expect(lookup.calls).toBe(1);
    const unpinned = fixtureGuard({
      lookup: scriptedLookup(["127.0.0.1"], ["169.254.169.254"]),
      allowPrivateHosts: ["api.fixture.test"],
      pinDns: false,
    });
    await unpinned(url("/ok"));
    await expect(unpinned(url("/ok"))).rejects.toThrow(/metadata address/);
  });

  it("does not share pins between egress instances (one per connector call)", async () => {
    const lookup = scriptedLookup(["127.0.0.1"], ["169.254.169.254"]);
    const options = { lookup, allowPrivateHosts: ["api.fixture.test"] };
    expect((await fixtureGuard(options)(url("/ok"))).status).toBe(200);
    await expect(fixtureGuard(options)(url("/ok"))).rejects.toThrow(
      /metadata address/,
    );
    expect(lookup.calls).toBe(2);
  });

  it("refuses a name with one private address among public ones and does not pin the refusal", async () => {
    const lookup = scriptedLookup(["1.1.1.1", "10.0.0.1"], ["127.0.0.1"]);
    const guard = fixtureGuard({ lookup, allowPrivateHosts: ["127.0.0.1"] });
    await expect(guard(url("/ok"))).rejects.toThrow(/non-public address/);
    expect((await guard(url("/ok"))).status).toBe(200);
    expect(lookup.calls).toBe(2);
  });

  it("lets a listed private host through, but no other host and never outside outboundDomains", async () => {
    expect((await fixtureGuard(privateFixture)(url("/ok"))).status).toBe(200);
    await expect(
      fixtureGuard({ ...privateFixture, allowedDomains: ["other.test"] })(
        url("/ok"),
      ),
    ).rejects.toThrow(/not in the connector's outboundDomains/);
    await expect(
      fixtureGuard({ allowPrivateHosts: ["other.test"] })(url("/ok")),
    ).rejects.toThrow(/non-public address/);
    // The C-G3 fixture-server setup: an IP literal listed as a private host.
    const local = fixtureGuard({
      allowedDomains: ["127.0.0.1"],
      allowPrivateHosts: ["127.0.0.1"],
    });
    expect((await local(`http://127.0.0.1:${port}/ok`)).status).toBe(200);
    await expect(
      fixtureGuard({ allowedDomains: ["127.0.0.1"] })(
        `http://127.0.0.1:${port}/ok`,
      ),
    ).rejects.toThrow(/non-public address/);
  });
});

describe("redirects", () => {
  const siblings = {
    allowedDomains: ["api.fixture.test", "cdn.fixture.test"],
    allowPrivateHosts: ["*.fixture.test"],
  };
  const credentials = {
    headers: {
      Authorization: "Bearer secret-token",
      "Proxy-Authorization": "Basic secret-proxy",
      COOKIE: "session=secret-cookie",
      "x-custom": "kept",
    },
  };

  it("drops credentials on a cross-origin hop and keeps them on the same origin", async () => {
    const guard = fixtureGuard(siblings);
    expect((await guard(url("/to-self"), credentials)).json()).toEqual({
      authorization: "Bearer secret-token",
      proxyAuthorization: "Basic secret-proxy",
      cookie: "session=secret-cookie",
      custom: "kept",
    });
    const stripped = {
      authorization: null,
      proxyAuthorization: null,
      cookie: null,
      custom: "kept",
    };
    expect((await guard(url("/to-sibling"), credentials)).json()).toEqual(
      stripped,
    );
    // Once dropped, they stay dropped: a later same-origin hop on the
    // other host, or a hop back, does not bring them back.
    expect(
      (await guard(url("/to-sibling-then-self"), credentials)).json(),
    ).toEqual(stripped);
    expect(
      (await guard(url("/to-sibling-then-back"), credentials)).json(),
    ).toEqual(stripped);
  });

  it("keeps same-host redirects on the first URL's host, port and scheme", async () => {
    const guard = fixtureGuard({ ...siblings, redirects: "same-host" });
    expect((await guard(url("/to-self"))).status).toBe(200);
    await expect(guard(url("/to-sibling"))).rejects.toThrow(
      /^egress denied: redirect to another host cdn\.fixture\.test:\d+$/,
    );
    for (const path of ["/to-other-port", "/to-https"]) {
      await expect(guard(url(path))).rejects.toThrow(
        /redirect to another host/,
      );
    }
    // The default mode follows allowlisted siblings as before.
    expect((await fixtureGuard(siblings)(url("/to-sibling"))).status).toBe(200);
  });

  it("refuses redirects to metadata and encoded private addresses in every mode", async () => {
    for (const redirects of ["allowlist", "same-host"] as const) {
      const guard = fixtureGuard({
        redirects,
        allowedDomains: [
          "api.fixture.test",
          "169.254.169.254",
          "fd00:ec2::254",
          "127.0.0.1",
          "::ffff:7f00:1",
        ],
        allowPrivateHosts: [
          "api.fixture.test",
          "169.254.0.0/16",
          "fd00:ec2::/32",
        ],
      });
      // The first hop is reachable, so a refusal is the redirect's own.
      expect((await guard(url("/to-self"))).status).toBe(200);
      for (const path of [
        "/to-metadata",
        "/to-metadata-v6",
        "/to-decimal",
        "/to-mapped",
      ]) {
        // Same-host mode refuses any other host first (#874 review): it
        // never gets as far as the address.
        await expect(guard(url(path))).rejects.toThrow(
          redirects === "same-host"
            ? /redirect to another host/
            : /non-public address/,
        );
      }
    }
  });

  it("never puts a header value or query string in a redirect error", async () => {
    for (const [overrides, path, reason] of [
      [{ redirects: "same-host" as const }, "/to-sibling", /another host/],
      [
        { allowedDomains: ["api.fixture.test"] },
        "/to-sibling",
        /cdn\.fixture\.test is not in/,
      ],
      [
        { allowedDomains: ["api.fixture.test", "169.254.169.254"] },
        "/to-metadata",
        /non-public address 169\.254\.169\.254$/,
      ],
    ] as const) {
      const error = await failure(
        fixtureGuard({ ...siblings, ...overrides })(url(path), credentials),
      );
      expect(error).toBeInstanceOf(EgressDeniedError);
      expect(error.message).toMatch(reason);
      for (const secret of ["secret-token", "secret-proxy", "secret-cookie"])
        expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("secret-query");
    }
  });
});

describe("body limits and time", () => {
  it("decodes a gzip JSON body as before", async () =>
    expect(
      (await fixtureGuard(privateFixture)(url("/gzip-json"))).json(),
    ).toEqual({ ok: true }));

  it("stops a decompression bomb at the decompressed limit", async () => {
    expect(bomb.byteLength).toBeLessThan(MIB);
    const guard = fixtureGuard({
      ...privateFixture,
      maxResponseBytes: 10 * MIB,
      maxDecompressedBytes: 1 * MIB,
    });
    for (const path of ["/bomb", "/bomb-chained"]) {
      await expect(guard(url(path))).rejects.toThrow(
        /^egress denied: response exceeds 1048576 bytes once decompressed$/,
      );
    }
  });

  it("defaults the decompressed limit to the response limit (bundled connectors unchanged)", async () => {
    expect(BROTLI.byteLength).toBeLessThan(1024);
    await expect(
      fixtureGuard({ ...privateFixture, maxResponseBytes: 1 * MIB })(
        url("/brotli"),
      ),
    ).rejects.toThrow(/^egress denied: response exceeds 1048576 bytes/);
    // The default response limit (10 MiB) bounds a bomb without options.
    await expect(fixtureGuard(privateFixture)(url("/bomb"))).rejects.toThrow(
      /^egress denied: response exceeds 10485760 bytes once decompressed$/,
    );
  });

  it("allows a larger decoded body when asked", async () => {
    const body = await fixtureGuard({
      ...privateFixture,
      maxResponseBytes: 1 * MIB,
      maxDecompressedBytes: 4 * MIB,
    })(url("/brotli"));
    expect(body.bytes().byteLength).toBe(2 * MIB);
  });

  it("counts an unknown content-encoding against the wire limit", async () => {
    for (const path of ["/unknown-coding", "/identity-gzip"]) {
      await expect(
        fixtureGuard({
          ...privateFixture,
          maxResponseBytes: 1024,
          maxDecompressedBytes: 1 * MIB,
        })(url(path)),
      ).rejects.toThrow(/^egress denied: response exceeds 1024 bytes$/);
    }
  });

  it("times out slow headers and a dripping body with a retryable error", async () => {
    const guard = fixtureGuard({ ...privateFixture, requestTimeoutMs: 200 });
    for (const path of ["/slow-headers", "/drip"]) {
      const started = Date.now();
      const error = await failure(guard(url(path)));
      expect(error).toBeInstanceOf(EgressTimeoutError);
      expect(error).not.toBeInstanceOf(EgressDeniedError);
      expect(error.message).toBe(
        "egress timeout: api.fixture.test did not answer within 200 ms",
      );
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  it("reports the caller's abort as an abort, not a timeout", async () => {
    const controller = new AbortController();
    const guard = fixtureGuard({
      ...privateFixture,
      signal: controller.signal,
      requestTimeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await failure(guard(url("/slow-headers")));
    expect(error).not.toBeInstanceOf(EgressTimeoutError);
    expect(error).not.toBeInstanceOf(EgressDeniedError);
    expect(error.name).toBe("AbortError");
  });
});

describe("per-request limits, HEAD and refusal reasons (SDK 0.2.21, #874)", () => {
  const siblings = {
    allowedDomains: ["api.fixture.test", "cdn.fixture.test"],
    allowPrivateHosts: ["*.fixture.test"],
  };

  it("names why a request was refused", async () => {
    const cases: Array<[Promise<unknown>, string]> = [
      [fixtureGuard(privateFixture)("not a url"), "url"],
      [
        createEgressFetch({ allowedDomains: ["api.fixture.test"], signal })(
          url("/ok"),
        ),
        "scheme",
      ],
      [fixtureGuard(privateFixture)(url("/ok", "other.fixture.test")), "host"],
      [fixtureGuard()(url("/ok")), "address"],
      [
        fixtureGuard({ ...siblings, redirects: "same-host" })(
          url("/to-sibling"),
        ),
        "redirect_host",
      ],
      [
        fixtureGuard({ ...privateFixture, maxResponseBytes: 1024 })(
          url("/unknown-coding"),
        ),
        "size",
      ],
    ];
    for (const [promise, reason] of cases) {
      const error = await failure(promise);
      expect(error).toBeInstanceOf(EgressDeniedError);
      expect((error as EgressDeniedError).reason, reason).toBe(reason);
    }
  });

  it("names a same-host redirect to a host outside the allowlist a redirect (#874 review)", async () => {
    const error = await failure(
      fixtureGuard({
        allowedDomains: ["api.fixture.test"],
        allowPrivateHosts: ["*.fixture.test"],
        redirects: "same-host",
      })(url("/to-sibling")),
    );
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as EgressDeniedError).reason).toBe("redirect_host");
    expect(error.message).toMatch(/redirect to another host/);
  });

  it("lowers the host's size limit for one request, never raises it", async () => {
    const guard = fixtureGuard({ ...privateFixture, maxResponseBytes: 4096 });
    const small = await failure(
      guard(url("/unknown-coding"), { maxResponseBytes: 1024 }),
    );
    expect(small.message).toBe("egress denied: response exceeds 1024 bytes");
    expect((await guard(url("/unknown-coding"))).bytes().byteLength).toBe(2048);
    const raised = await failure(
      fixtureGuard({ ...privateFixture, maxResponseBytes: 1024 })(
        url("/unknown-coding"),
        { maxResponseBytes: 1 * MIB },
      ),
    );
    expect(raised.message).toBe("egress denied: response exceeds 1024 bytes");
  });

  it("lowers the host's time limit for one request", async () => {
    const guard = fixtureGuard({ ...privateFixture, requestTimeoutMs: 5_000 });
    const started = Date.now();
    const error = await failure(
      guard(url("/slow-headers"), { timeoutMs: 100 }),
    );
    expect(error).toBeInstanceOf(EgressTimeoutError);
    expect(error.message).toBe(
      "egress timeout: api.fixture.test did not answer within 100 ms",
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("keeps the answer's status on a body refused or timed out after it came (SDK 0.2.23, #898)", async () => {
    const guard = fixtureGuard({ ...privateFixture, requestTimeoutMs: 5_000 });
    const big = await failure(
      guard(url("/unknown-coding"), { maxResponseBytes: 1024 }),
    );
    expect(big).toBeInstanceOf(EgressDeniedError);
    expect((big as EgressDeniedError).status).toBe(200);
    const dripping = await failure(guard(url("/drip"), { timeoutMs: 250 }));
    expect(dripping).toBeInstanceOf(EgressTimeoutError);
    expect((dripping as EgressTimeoutError).status).toBe(200);
    // No answer yet: no status.
    const silent = await failure(
      guard(url("/slow-headers"), { timeoutMs: 100 }),
    );
    expect((silent as EgressTimeoutError).status).toBeUndefined();
    const refused = await failure(
      fixtureGuard(privateFixture)(url("/ok", "other.fixture.test")),
    );
    expect((refused as EgressDeniedError).status).toBeUndefined();
  });

  it("discards a body it is told not to read, and every HEAD body", async () => {
    const guard = fixtureGuard({ ...privateFixture, maxResponseBytes: 1024 });
    const discarded = await guard(url("/unknown-coding"), {
      discardBody: true,
    });
    expect(discarded.status).toBe(200);
    expect(discarded.bytes().byteLength).toBe(0);
    const head = await guard(url("/ok"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text()).toBe("");
  });

  it("follows a HEAD request's same-host redirect, never another host", async () => {
    const guard = fixtureGuard({ ...siblings, redirects: "same-host" });
    expect((await guard(url("/to-self"), { method: "HEAD" })).status).toBe(200);
    await expect(guard(url("/to-sibling"), { method: "HEAD" })).rejects.toThrow(
      /redirect to another host/,
    );
  });
});
