import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { rootCertificates } from "node:tls";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  EgressRefusalReason,
} from "@netrics/connector-sdk";
import { Agent, fetch } from "undici";

/**
 * Outbound HTTP for connector code. This constrains the sanctioned path; it
 * is not a sandbox (connectors run in-process and are trusted through review,
 * architecture: "Connector trust and distribution").
 */
export class EgressDeniedError extends Error {
  /** Why (SDK 0.2.21): connector code may read it, never a host value. */
  readonly reason: EgressRefusalReason;
  constructor(message: string, reason: EgressRefusalReason) {
    super(message);
    this.name = "EgressDeniedError";
    this.reason = reason;
  }
}

/**
 * The provider did not answer within the per-request time budget. Not a
 * denial: a slow provider is a retryable failure, never a broken connector.
 */
export class EgressTimeoutError extends Error {
  constructor(host: string, timeoutMs: number) {
    super(`egress timeout: ${host} did not answer within ${timeoutMs} ms`);
    this.name = "EgressTimeoutError";
  }
}

// Addresses a connector must never reach: this host, private networks, cloud
// metadata services, and reserved ranges.
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT); not routed, refused whole
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // NAT64 local use
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

// Never reachable, not even for a self-hoster's private hosts: cloud
// metadata services and link-local addresses.
const metadata = new BlockList();
metadata.addSubnet("169.254.0.0", 16, "ipv4");
metadata.addAddress("100.100.100.200", "ipv4");
metadata.addAddress("192.0.0.192", "ipv4");
metadata.addSubnet("fe80::", 10, "ipv6");
metadata.addAddress("fd00:ec2::254", "ipv6");

/** The 16 bytes of an IPv6 address (zone id dropped), or null. */
function ipv6Bytes(address: string): Uint8Array | null {
  let text = address.replace(/%.*$/, "");
  if (isIP(text) !== 6) return null;
  const bytes = new Uint8Array(16);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (dotted) {
    tail = dotted[1]!.split(".").map(Number);
    text = text.slice(0, -dotted[1]!.length) + "0:0";
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const left = parse(head);
  const right = parse(rest);
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  if (dotted) bytes.set(tail, 12);
  return bytes;
}

function ipv4At(bytes: Uint8Array, offset: number, xor = 0): string {
  return Array.from(bytes.subarray(offset, offset + 4), (b) => b ^ xor).join(
    ".",
  );
}

const zero = (bytes: Uint8Array, from: number, to: number) =>
  bytes.subarray(from, to).every((b) => b === 0);

/**
 * IPv4 addresses an IPv6 address stands for: IPv4-mapped (::ffff:a.b.c.d)
 * and IPv4-compatible (::a.b.c.d) forms are that IPv4 address; NAT64,
 * 6to4 and Teredo addresses embed IPv4 addresses they lead to.
 */
function embeddedIpv4(bytes: Uint8Array): { exact?: string; via: string[] } {
  if (zero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { exact: ipv4At(bytes, 12), via: [] };
  }
  if (zero(bytes, 0, 12)) {
    // :: and ::1 are judged as IPv6 (unspecified, loopback).
    return zero(bytes, 12, 15) && bytes[15]! <= 1
      ? { via: [] }
      : { exact: ipv4At(bytes, 12), via: [] };
  }
  if (zero(bytes, 0, 8) && bytes[8] === 0xff && bytes[9] === 0xff) {
    return zero(bytes, 10, 12) ? { via: [ipv4At(bytes, 12)] } : { via: [] }; // IPv4-translated ::ffff:0:a.b.c.d
  }
  const prefix32 = (bytes[0]! << 8) | bytes[1]!;
  if (prefix32 === 0x0064 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return { via: [ipv4At(bytes, 12)] }; // NAT64 64:ff9b::/96
  }
  if (prefix32 === 0x2002) return { via: [ipv4At(bytes, 2)] }; // 6to4
  if (prefix32 === 0x2001 && bytes[2] === 0 && bytes[3] === 0) {
    // Teredo: server, and the client obfuscated with all ones.
    return { via: [ipv4At(bytes, 4), ipv4At(bytes, 12, 0xff)] };
  }
  return { via: [] };
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blocked.check(address, "ipv4");
  }
  const bytes = ipv6Bytes(address);
  if (bytes) {
    // IPv4-mapped and IPv4-compatible forms are judged by their IPv4
    // address; NAT64, 6to4 and Teredo ranges are refused whole.
    const { exact } = embeddedIpv4(bytes);
    if (exact !== undefined) return blocked.check(exact, "ipv4");
    // IETF-reserved ::/8 as a whole: nothing in it is routed globally
    // (global unicast is 2000::/3). Checked by hand: an IPv6 range over
    // ::ffff:0:0/96 in a BlockList also matches every IPv4 address.
    if (bytes[0] === 0) return true;
    return blocked.check(address.replace(/%.*$/, ""), "ipv6");
  }
  return true;
}

/** Never reachable, even for allowPrivateHosts: metadata services and link-local. */
export function isMetadataAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return metadata.check(address, "ipv4");
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const { exact, via } = embeddedIpv4(bytes);
  return (
    metadata.check(address.replace(/%.*$/, ""), "ipv6") ||
    [...(exact === undefined ? [] : [exact]), ...via].some((v4) =>
      metadata.check(v4, "ipv4"),
    )
  );
}

const HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Validates self-host private-host entries: host patterns as hostAllowed
 * reads them ("intranet.example", "*.corp.example"), IP addresses, or CIDR
 * ranges ("10.20.0.0/16", "fd12::/48"). Throws Error("invalid private host
 * entry: <entry>") for "*", "0.0.0.0/0", "::/0", prefixes shorter than /8
 * (IPv4) or /16 (IPv6), and anything else malformed. Trims, lowercases,
 * drops empty entries.
 */
export function parsePrivateHostEntries(entries: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const invalid = () => new Error(`invalid private host entry: ${entry}`);
    const range = /^([^/]+)\/(\d{1,3})$/.exec(entry);
    if (range) {
      const family = isIP(range[1]!);
      const prefix = Number(range[2]);
      const [min, max] = family === 4 ? [8, 32] : [16, 128];
      if (!family || prefix < min || prefix > max) throw invalid();
    } else if (!isIP(entry) && !HOST_PATTERN.test(entry)) {
      throw invalid();
    }
    result.push(entry);
  }
  return result;
}

/**
 * Common public suffixes of more than one label, under which anyone can
 * register a domain. Not the whole Public Suffix List (no dependency for a
 * startup warning): the second-level suffixes most often seen.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "id.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "ne.kr",
  "com.br",
  "net.br",
  "org.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.my",
  "com.ph",
  "com.vn",
  "co.in",
  "net.in",
  "org.in",
  "co.id",
  "co.th",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.uy",
  "com.ve",
  "com.ec",
  "co.za",
  "com.ng",
  "co.ke",
  "com.eg",
  "com.tr",
  "com.ua",
  "com.pl",
  "co.il",
  "github.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
]);

/**
 * Valid entries that reach further than an operator likely means: a
 * wildcard over a public suffix (`*.com`, `*.local`, `*.co.uk`,
 * `*.github.io`) and `localhost` (or `*.localhost`). A listed name may
 * resolve to any address except metadata ones, loopback included. The
 * server warns about them at startup; they stay allowed, the setting is
 * the operator's.
 */
export function broadPrivateHostEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    const name = entry.trim().toLowerCase();
    if (isIP(name) || name.includes("/")) return false;
    if (name === "localhost" || name.endsWith(".localhost")) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(2);
    return !suffix.includes(".") || MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix);
  });
}

export interface PrivateHostPolicy {
  /** host: the URL hostname; address: the literal or resolved address. */
  allows(host: string, address: string): boolean;
}

/** IPv4-mapped IPv6 addresses as their IPv4 form, for range checks. */
function unmapped(address: string): { address: string; family: 4 | 6 } {
  if (isIP(address) === 4) return { address, family: 4 };
  const bytes = ipv6Bytes(address);
  if (bytes && zero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { address: ipv4At(bytes, 12), family: 4 };
  }
  return { address: address.replace(/%.*$/, ""), family: 6 };
}

/**
 * Self-host only: lets listed hosts (by name) or listed addresses and ranges
 * be private. Metadata and link-local addresses are never allowed.
 */
export function privateHostPolicy(
  entries: readonly string[],
): PrivateHostPolicy {
  const hosts: string[] = [];
  const ranges = new BlockList();
  for (const entry of parsePrivateHostEntries(entries)) {
    const [network, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(network);
    if (!family) {
      hosts.push(entry);
    } else if (prefix === undefined) {
      const single = unmapped(network);
      ranges.addAddress(single.address, single.family === 4 ? "ipv4" : "ipv6");
    } else {
      ranges.addSubnet(network, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    }
  }
  return {
    allows(host, address) {
      if (!isIP(address) || isMetadataAddress(address)) return false;
      if (hostAllowed(host, hosts)) return true;
      const { address: plain, family } = unmapped(address);
      return ranges.check(plain, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

/** "api.example.com" matches exactly; "*.example.com" matches subdomains. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return name.endsWith(suffix) && name.length > suffix.length;
    }
    return name === pattern;
  });
}

export interface EgressOptions {
  /** manifest.outboundDomains (or a custom definition's hosts) */
  allowedDomains: readonly string[];
  signal: AbortSignal;
  /** Wire bytes, and the whole body when it is not content-encoded. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Decoded bytes of a content-encoded body. Default: maxResponseBytes. */
  maxDecompressedBytes?: number;
  /** Default 3. */
  maxRedirects?: number;
  /**
   * "allowlist": every hop must be in allowedDomains (default).
   * "same-host": every hop keeps the first URL's scheme, host and port,
   * and only GET requests follow redirects: any other request's 3xx is
   * answered as it is (ADR 0030: a custom API POST follows none).
   */
  redirects?: "allowlist" | "same-host";
  /** Whole request: connect, every hop, headers and body. Default 60_000. */
  requestTimeoutMs?: number;
  /** Resolve each host once per egress instance and reuse the validated addresses. Default true. */
  pinDns?: boolean;
  /**
   * Self-host only: hosts/ranges that may resolve to private addresses
   * (never metadata). Already validated by parsePrivateHostEntries. Never
   * widens allowedDomains.
   */
  allowPrivateHosts?: readonly string[];
  /** Tests only: resolve names differently and permit private addresses. */
  lookup?: LookupFunction;
  allowPrivateAddresses?: boolean;
  /** Tests only: plain http to a local fixture server. */
  allowInsecureHttp?: boolean;
  /** Tests only: an extra trusted CA (PEM), added to the default roots. */
  tlsCa?: string;
  /**
   * Media types whose bodies are read ("image/*" matches a whole type). A
   * response that names another Content-Type comes back with its status
   * and headers but an empty body, unread. A response without one is read.
   * Default: every body is read.
   */
  bodyContentTypes?: readonly string[];
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
// Equal to the connector call budget (DEFAULT_TIMEOUT_MS in execute.ts).
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Content codings undici's fetch decodes; anything else arrives raw.
const DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);
// Never carried to another origin on a redirect (WHATWG fetch).
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

type LookupEntry = { address: string; family: number };

/**
 * Builds the runtime.fetch handed to one connector call. Address checks run
 * inside the socket's DNS lookup, so the address that is checked is the
 * address that is connected to; with pinDns, the first validated answer for
 * a name is reused for the rest of the call, so a name cannot rebind to
 * another address between requests.
 */
export function createEgressFetch(options: EgressOptions) {
  const baseLookup: LookupFunction = options.lookup ?? dnsLookup;
  const policy = privateHostPolicy(options.allowPrivateHosts ?? []);
  const pinDns = options.pinDns ?? true;
  const pins = new Map<string, LookupEntry[]>();

  /** Why an address is refused for this host, or null when it may be reached. */
  function refusal(
    host: string,
    address: string,
  ): "metadata" | "private" | null {
    if (isMetadataAddress(address)) return "metadata";
    if (!isBlockedAddress(address)) return null;
    if (options.allowPrivateAddresses || policy.allows(host, address)) {
      return null;
    }
    return "private";
  }

  function answer(
    lookupOptions: Parameters<LookupFunction>[1],
    callback: Parameters<LookupFunction>[2],
    list: LookupEntry[],
  ) {
    if (lookupOptions.all) {
      (callback as unknown as (e: null, a: LookupEntry[]) => void)(null, list);
    } else {
      callback(null, list[0]!.address, list[0]!.family);
    }
  }

  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    const key = hostname.toLowerCase().replace(/\.$/, "");
    const pinned = pinDns ? pins.get(key) : undefined;
    if (pinned) {
      answer(lookupOptions, callback, pinned);
      return;
    }
    baseLookup(
      hostname,
      { ...lookupOptions, all: true },
      (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        const list = (
          Array.isArray(addresses)
            ? addresses
            : [{ address: addresses, family: 4 }]
        ) as LookupEntry[];
        // One refused address refuses the whole answer, and a refusal is
        // never pinned.
        const reasons = list.map((entry) => refusal(key, entry.address));
        if (reasons.includes("metadata") || reasons.includes("private")) {
          const what = reasons.includes("metadata")
            ? "a metadata address"
            : "a non-public address";
          callback(
            new EgressDeniedError(
              `egress denied: ${hostname} resolves to ${what}`,
              "address",
            ),
            "",
            0,
          );
          return;
        }
        if (list.length === 0) {
          callback(new Error(`no address for ${hostname}`), "", 0);
          return;
        }
        if (pinDns) pins.set(key, list);
        answer(lookupOptions, callback, list);
      },
    );
  };
  const dispatcher = new Agent({
    connect: {
      lookup: guardedLookup,
      ...(options.tlsCa ? { ca: [...rootCertificates, options.tlsCa] } : {}),
    },
  });
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressDeniedError(`egress denied: invalid URL`, "url");
    }
    const insecureOk = options.allowInsecureHttp && url.protocol === "http:";
    if (url.protocol !== "https:" && !insecureOk) {
      throw new EgressDeniedError(
        `egress denied: only https is allowed`,
        "scheme",
      );
    }
    if (url.username || url.password) {
      throw new EgressDeniedError(
        `egress denied: credentials in URL`,
        "credentials",
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!hostAllowed(host, options.allowedDomains)) {
      throw new EgressDeniedError(
        `egress denied: ${host} is not in the connector's outboundDomains`,
        "host",
      );
    }
    if (isIP(host) && refusal(host, host) !== null) {
      throw new EgressDeniedError(
        `egress denied: non-public address ${host}`,
        "address",
      );
    }
    return url;
  }

  function bodyWanted(contentType: string | null): boolean {
    const wanted = options.bodyContentTypes;
    if (!wanted || contentType === null) return true;
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    return wanted.some((entry) => {
      const pattern = entry.toLowerCase();
      return pattern.endsWith("/*")
        ? type.startsWith(pattern.slice(0, -1))
        : type === pattern;
    });
  }

  async function readBody(
    response: Awaited<ReturnType<typeof fetch>>,
    request: { maxBytes: number; discard: boolean },
  ): Promise<Buffer> {
    if (request.discard || !bodyWanted(response.headers.get("content-type"))) {
      await response.body?.cancel();
      return Buffer.alloc(0);
    }
    const codings = (response.headers.get("content-encoding") ?? "")
      .split(",")
      .map((coding) => coding.trim().toLowerCase())
      .filter(Boolean);
    // Only a body undici decodes gets the decoded limit; anything it leaves
    // raw (an unknown coding anywhere in the chain) counts as wire bytes.
    const decoded =
      codings.length > 0 &&
      codings.every((coding) => DECODED_CODINGS.has(coding));
    const wireLimit = Math.min(maxBytes, request.maxBytes);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > wireLimit) {
      await response.body?.cancel();
      throw new EgressDeniedError(
        `egress denied: response exceeds ${wireLimit} bytes`,
        "size",
      );
    }
    const limit = Math.min(
      decoded ? maxDecompressedBytes : maxBytes,
      request.maxBytes,
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    // Throwing inside the loop cancels the body stream.
    for await (const chunk of response.body ?? []) {
      size += (chunk as Uint8Array).byteLength;
      if (size > limit) {
        throw new EgressDeniedError(
          decoded
            ? `egress denied: response exceeds ${limit} bytes once decompressed`
            : `egress denied: response exceeds ${limit} bytes`,
          "size",
        );
      }
      chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks);
  }

  return async function egressFetch(
    rawUrl: string,
    init: ConnectorFetchInit = {},
  ): Promise<ConnectorResponse> {
    let url = checkUrl(rawUrl);
    const first = url;
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...init.headers };
    // A connector's own limits only ever lower the host's (SDK 0.2.21).
    const timeoutMs = lowered(requestTimeoutMs, init.timeoutMs);
    const request = {
      maxBytes: lowered(Number.POSITIVE_INFINITY, init.maxResponseBytes),
      discard: init.discardBody === true || method === "HEAD",
    };
    const timeout = AbortSignal.timeout(timeoutMs);
    // One signal per request: every hop and the whole body read.
    const signal = AbortSignal.any([options.signal, timeout]);
    try {
      for (let redirects = 0; ; redirects += 1) {
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
          response = await fetch(url, {
            method,
            headers,
            ...(init.body !== undefined ? { body: init.body } : {}),
            redirect: "manual",
            signal,
            dispatcher,
          });
        } catch (error) {
          // undici reports connect-time failures as TypeError("fetch failed")
          // with the real reason as cause; surface an egress denial as itself.
          if (
            error instanceof Error &&
            error.cause instanceof EgressDeniedError
          ) {
            throw error.cause;
          }
          throw error;
        }
        const location = response.headers.get("location");
        // "same-host" (custom APIs) follows redirects of GET and HEAD
        // requests only: a POST stays on the endpoint its definition names
        // (ADR 0030 §2), so its 3xx comes back to the connector, unfollowed.
        const follows =
          options.redirects !== "same-host" ||
          method === "GET" ||
          method === "HEAD";
        if (
          follows &&
          response.status >= 300 &&
          response.status < 400 &&
          location
        ) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) {
            throw new EgressDeniedError(
              `egress denied: too many redirects`,
              "redirects",
            );
          }
          const next = checkUrl(new URL(location, url).toString());
          if (
            options.redirects === "same-host" &&
            (next.protocol !== first.protocol || next.host !== first.host)
          ) {
            throw new EgressDeniedError(
              `egress denied: redirect to another host ${next.host}`,
              "redirect_host",
            );
          }
          if (next.origin !== url.origin) {
            // Once dropped, credentials stay dropped for later hops.
            for (const name of Object.keys(headers)) {
              if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
                delete headers[name];
              }
            }
          }
          url = next;
          continue;
        }
        const body = await readBody(response, request);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return bufferedResponse(response.status, responseHeaders, body);
      }
    } catch (error) {
      if (
        !(error instanceof EgressDeniedError) &&
        timeout.aborted &&
        !options.signal.aborted
      ) {
        throw new EgressTimeoutError(
          url.hostname.replace(/^\[|\]$/g, ""),
          timeoutMs,
        );
      }
      throw error;
    }
  };
}

/** The host's limit, or a connector's own when it is a lower positive number. */
function lowered(host: number, own: number | undefined): number {
  return typeof own === "number" && Number.isFinite(own) && own > 0
    ? Math.min(host, Math.floor(own))
    : host;
}

/**
 * A ConnectorResponse over a body that was read within the size limit. The
 * body is decoded as UTF-8 only when text() or json() asks for it, and
 * bytes() hands out a copy so connector code cannot alter what the next
 * call sees.
 */
function bufferedResponse(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): ConnectorResponse {
  let text: string | undefined;
  const decoded = () => (text ??= body.toString("utf8"));
  return {
    status,
    headers,
    text: decoded,
    json: () => JSON.parse(decoded()) as unknown,
    bytes: () => new Uint8Array(body),
  };
}
