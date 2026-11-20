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
      reason:
        | "invalid_url"
        | "host_not_allowed"
        | "fetch_failed"
        | "too_large"
        | "unsupported_type";
    };

/**
 * Content types whose bodies are worth reading: images, and the generic
 * binary types object stores answer with. The host passes them to the egress
 * guard (`bodyContentTypes`), so any other answer (an HTML or JSON page) is
 * not read at all; the magic bytes still decide what an image is.
 */
export const ITEM_IMAGE_BODY_TYPES: readonly string[] = [
  "image/*",
  "application/octet-stream",
  "binary/octet-stream",
];

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

/** Whether a Content-Type header names a type in ITEM_IMAGE_BODY_TYPES; no header passes. */
function imageBodyType(contentType: string | undefined): boolean {
  if (contentType === undefined) return true;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return ITEM_IMAGE_BODY_TYPES.some((entry) =>
    entry.endsWith("/*") ? type.startsWith(entry.slice(0, -1)) : type === entry,
  );
}

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
    // Decided by the header before the body is touched (the egress guard
    // did not read it either); the magic bytes decide the rest.
    const contentType = response.headers["content-type"];
    if (!imageBodyType(contentType))
      return { url: raw, ok: false, reason: "unsupported_type" };
    // bytes() is already a copy of its own: wrap it, do not copy again.
    const body = response.bytes();
    if (body.byteLength > input.maxBytes)
      return { url: raw, ok: false, reason: "too_large" };
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return { url: raw, ok: true, bytes, contentType: contentType ?? null };
  } catch (error) {
    return {
      url: raw,
      ok: false,
      reason: isSizeRefusal(error) ? "too_large" : "fetch_failed",
    };
  }
}

/**
 * Downloads `urls` and hands each result to `onResult` as soon as it
 * arrives, at most `concurrency` at once; a worker takes its next URL only
 * after `onResult` returned, so at most `concurrency` bodies are alive. A
 * URL must parse, be https and carry no user info (`invalid_url`); its host
 * must be one of the definition's image hosts, or without an `images` block
 * the environment host (`host_not_allowed`). A non-image Content-Type is
 * `unsupported_type`, a body over `maxBytes` is `too_large`, anything else
 * that goes wrong on the way is `fetch_failed`. Never throws for one URL;
 * an error `onResult` throws ends the call.
 */
export async function forEachItemImage(
  input: FetchItemImagesInput,
  onResult: (result: ItemImageFetch, index: number) => Promise<void>,
): Promise<void> {
  const base = new URL(
    customApiEnvironment(input.definition, input.environmentId).baseUrl,
  );
  let next = 0;
  const worker = async () => {
    while (next < input.urls.length) {
      const index = next;
      next += 1;
      await onResult(await fetchOne(input, input.urls[index]!, base), index);
    }
  };
  const workers = Math.max(
    1,
    Math.min(input.concurrency ?? 4, input.urls.length),
  );
  await Promise.all(Array.from({ length: workers }, worker));
}

/** forEachItemImage, collected: every result (with its bytes) in `urls` order. */
export async function fetchItemImages(
  input: FetchItemImagesInput,
): Promise<ItemImageFetch[]> {
  const results: ItemImageFetch[] = new Array(input.urls.length);
  await forEachItemImage(input, async (result, index) => {
    results[index] = result;
  });
  return results;
}
