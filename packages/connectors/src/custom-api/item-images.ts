// Downloads the images of a custom API stream's newest items (milestone 13,
// spec section 8). Host-trusted code of the bundled custom-api connector: the
// server runs it inside the connector boundary (egress guard with same-host
// redirects, a size cap and a timeout), never connector-authored code.
// Credentials go only to the connection's environment host; every other
// image host gets a request without any credential. One URL never fails
// the others: each answers a result or a skip reason.

import type { ConnectorRuntime } from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";

import type { CustomApiCredentials } from "./credentials.js";
import { customApiEnvironment } from "./manifest.js";
import { applyCustomApiAuth } from "./request.js";

export type ItemImageFetch =
  | { url: string; ok: true; bytes: Buffer; contentType: string | null }
  | {
      url: string;
      ok: false;
      reason: "invalid_url" | "host_not_allowed" | "fetch_failed" | "too_large";
    };

export interface FetchItemImagesInput {
  definition: CustomApiDefinition;
  /** The pin's environment. */
  environmentId: string;
  credentials: CustomApiCredentials;
  /** The connection's non-secret variable values (rendered auth headers). */
  config?: Record<string, unknown>;
  runtime: ConnectorRuntime;
  urls: readonly string[];
  /** CUSTOM_API_IMAGE_MAX_BYTES. */
  maxBytes: number;
  /** Requests at once; default 4. */
  concurrency?: number;
  /** Tests only, mirroring the egress option: accept http image URLs. */
  allowInsecureHttp?: boolean;
}

const ACCEPT = "image/png, image/jpeg, image/webp";

/** Exact host or a "*.example.com" pattern, case-insensitive (as egress reads outboundDomains). */
function hostMatches(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return name.endsWith(suffix) && name.length > suffix.length;
    }
    return name === pattern;
  });
}

/** A body the egress guard refused for its size. */
function isSizeRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "EgressDeniedError" &&
    /response exceeds/.test(error.message)
  );
}

async function fetchOne(
  input: FetchItemImagesInput,
  raw: string,
  base: URL,
): Promise<ItemImageFetch> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: raw, ok: false, reason: "invalid_url" };
  }
  const schemeOk =
    url.protocol === "https:" ||
    (input.allowInsecureHttp === true && url.protocol === "http:");
  if (!schemeOk || url.username || url.password)
    return { url: raw, ok: false, reason: "invalid_url" };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = input.definition.images
    ? hostMatches(hostname, input.definition.images.hosts)
    : url.host === base.host;
  if (!allowed) return { url: raw, ok: false, reason: "host_not_allowed" };
  const request = { url, headers: { accept: ACCEPT } };
  try {
    // Credentials only for the environment host (scheme, host and port).
    if (url.protocol === base.protocol && url.host === base.host)
      applyCustomApiAuth(
        request,
        input.definition,
        customApiEnvironment(input.definition, input.environmentId),
        input.credentials,
        input.config ?? {},
      );
    const response = await input.runtime.fetch(request.url.href, {
      headers: request.headers,
    });
    if (response.status < 200 || response.status >= 300)
      return { url: raw, ok: false, reason: "fetch_failed" };
    const bytes = Buffer.from(response.bytes());
    if (bytes.length > input.maxBytes)
      return { url: raw, ok: false, reason: "too_large" };
    const contentType = response.headers["content-type"] ?? null;
    return { url: raw, ok: true, bytes, contentType };
  } catch (error) {
    return {
      url: raw,
      ok: false,
      reason: isSizeRefusal(error) ? "too_large" : "fetch_failed",
    };
  }
}

/**
 * Downloads `urls` (same order in the result). A URL must parse, be https
 * and carry no user info (`invalid_url`); its host must be one of the
 * definition's image hosts, or without an `images` block the environment
 * host (`host_not_allowed`). Anything that goes wrong on the way is
 * `fetch_failed`, a body over `maxBytes` is `too_large`. Never throws for
 * one URL.
 */
export async function fetchItemImages(
  input: FetchItemImagesInput,
): Promise<ItemImageFetch[]> {
  const base = new URL(
    customApiEnvironment(input.definition, input.environmentId).baseUrl,
  );
  const results: ItemImageFetch[] = new Array(input.urls.length);
  let next = 0;
  const worker = async () => {
    while (next < input.urls.length) {
      const index = next;
      next += 1;
      results[index] = await fetchOne(input, input.urls[index]!, base);
    }
  };
  const workers = Math.max(
    1,
    Math.min(input.concurrency ?? 4, input.urls.length),
  );
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
