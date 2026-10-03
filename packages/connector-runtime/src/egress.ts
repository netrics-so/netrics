import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";
import { Agent, fetch } from "undici";

/**
 * Outbound HTTP for connector code. This constrains the sanctioned path; it
 * is not a sandbox (connectors run in-process and are trusted through review,
 * architecture: "Connector trust and distribution").
 */
export class EgressDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressDeniedError";
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
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blocked.check(address, "ipv4");
  }
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by its IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) {
      return blocked.check(mapped[1]!, "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return true;
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
  /** manifest.outboundDomains */
  allowedDomains: readonly string[];
  signal: AbortSignal;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** Tests only: resolve names differently and permit private addresses. */
  lookup?: LookupFunction;
  allowPrivateAddresses?: boolean;
  /** Tests only: plain http to a local fixture server. */
  allowInsecureHttp?: boolean;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Builds the runtime.fetch handed to one connector call. Address checks run
 * inside the socket's DNS lookup, so the address that is checked is the
 * address that is connected to (no DNS-rebinding window).
 */
export function createEgressFetch(options: EgressOptions) {
  const baseLookup: LookupFunction = options.lookup ?? dnsLookup;
  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
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
        ) as Array<{ address: string; family: number }>;
        const denied = list.find((entry) => isBlockedAddress(entry.address));
        if (!options.allowPrivateAddresses && denied) {
          callback(
            new EgressDeniedError(
              `egress denied: ${hostname} resolves to a non-public address`,
            ),
            "",
            0,
          );
          return;
        }
        const first = list[0];
        if (!first) {
          callback(new Error(`no address for ${hostname}`), "", 0);
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (e: null, a: typeof list) => void)(
            null,
            list,
          );
        } else {
          callback(null, first.address, first.family);
        }
      },
    );
  };
  const dispatcher = new Agent({ connect: { lookup: guardedLookup } });
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressDeniedError(`egress denied: invalid URL`);
    }
    const insecureOk = options.allowInsecureHttp && url.protocol === "http:";
    if (url.protocol !== "https:" && !insecureOk) {
      throw new EgressDeniedError(`egress denied: only https is allowed`);
    }
    if (url.username || url.password) {
      throw new EgressDeniedError(`egress denied: credentials in URL`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!hostAllowed(host, options.allowedDomains)) {
      throw new EgressDeniedError(
        `egress denied: ${host} is not in the connector's outboundDomains`,
      );
    }
    if (
      isIP(host) &&
      isBlockedAddress(host) &&
      !options.allowPrivateAddresses
    ) {
      throw new EgressDeniedError(`egress denied: non-public address ${host}`);
    }
    return url;
  }

  return async function egressFetch(
    rawUrl: string,
    init: ConnectorFetchInit = {},
  ): Promise<ConnectorResponse> {
    let url = checkUrl(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(url, {
          method: init.method ?? "GET",
          headers: init.headers ?? {},
          ...(init.body !== undefined ? { body: init.body } : {}),
          redirect: "manual",
          signal: options.signal,
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
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (redirects >= maxRedirects) {
          throw new EgressDeniedError(`egress denied: too many redirects`);
        }
        url = checkUrl(new URL(location, url).toString());
        continue;
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new EgressDeniedError(
          `egress denied: response exceeds ${maxBytes} bytes`,
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += (chunk as Uint8Array).byteLength;
        if (size > maxBytes) {
          throw new EgressDeniedError(
            `egress denied: response exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(chunk as Uint8Array);
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return bufferedResponse(response.status, headers, Buffer.concat(chunks));
    }
  };
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
