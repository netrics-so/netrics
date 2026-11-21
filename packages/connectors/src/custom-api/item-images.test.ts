import type {
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  fetchItemImages,
  forEachItemImage,
  type FetchItemImagesInput,
} from "./item-images.js";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  fixturePng,
  fixtureRuntime,
  startCustomApiFixtureServer,
} from "./testing/index.js";

// Item image downloads (#809): credentials only to the environment host, no
// redirect followed, hosts outside images.hosts refused before any request,
// and every failure a per-URL reason. The fixture runtime stands in for the
// egress guard (no automatic redirects, a size cap, a timeout); the server
// tests run the same function through the real guard.

const fixture = await startCustomApiFixtureServer();
afterAll(() => fixture.close());
const api = fixture.origin;
const other = `http://localhost:${fixture.port}`;
const MAX_BYTES = 2_097_152;

beforeEach(() => fixture.reset());

function input(
  overrides: {
    images?: CustomApiDefinition["images"] | null;
    urls?: readonly string[];
    runtime?: ConnectorRuntime;
    concurrency?: number;
  } = {},
): FetchItemImagesInput {
  const base = fixtureDefinition("photos_bearer", api);
  const definition: CustomApiDefinition = { ...base };
  if (overrides.images === null) delete definition.images;
  else if (overrides.images) definition.images = overrides.images;
  return {
    definition,
    environmentId: "production",
    credentials: {
      host: `127.0.0.1:${fixture.port}`,
      token: FIXTURE_SECRETS.token,
    },
    runtime:
      overrides.runtime ??
      fixtureRuntime(["127.0.0.1", "localhost"], {
        maxBytes: MAX_BYTES,
        timeoutMs: 500,
      }),
    urls: overrides.urls ?? [],
    maxBytes: MAX_BYTES,
    allowInsecureHttp: true,
    ...(overrides.concurrency ? { concurrency: overrides.concurrency } : {}),
  };
}

describe("fetchItemImages", () => {
  it("sends the bearer token to the API host and to no other host", async () => {
    const results = await fetchItemImages(
      input({
        images: { hosts: ["127.0.0.1", "localhost"], newestItems: 12 },
        urls: [`${api}/images/auth-required.png`, `${other}/images/plain.png`],
      }),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const onApi = fixture.requests.find((r) => r.host.startsWith("127.0.0.1"));
    const onOther = fixture.requests.find((r) =>
      r.host.startsWith("localhost"),
    );
    expect(onApi!.headers.authorization).toBe(
      `Bearer ${FIXTURE_SECRETS.token}`,
    );
    expect(onOther!.headers.authorization).toBeUndefined();
    expect(onOther!.headers.accept).toBe("image/png, image/jpeg, image/webp");
    expect(Object.values(onOther!.headers).join(" ")).not.toContain(
      FIXTURE_SECRETS.token,
    );
  });

  it("does not follow a redirect to another host with credentials", async () => {
    // This shows only that fetchItemImages itself follows nothing: the
    // fixture runtime answers the 302 as it is (redirect: "manual"), a
    // non-2xx fetch_failed. The redirect policy (same-host redirects, no
    // credentials elsewhere) belongs to the egress guard and is covered by
    // the server test on real egress (custom-api-images.test.ts, "sends
    // credentials to the API host and never follows a redirect to another
    // image host").
    const [result] = await fetchItemImages(
      input({
        images: { hosts: ["127.0.0.1", "localhost"], newestItems: 12 },
        urls: [`${api}/images/redirect-other-host`],
      }),
    );
    expect(result).toEqual({
      url: expect.any(String),
      ok: false,
      reason: "fetch_failed",
    });
    expect(
      fixture.requests.filter((r) => r.host.startsWith("localhost")),
    ).toHaveLength(0);
  });

  it("refuses hosts outside images.hosts without a request", async () => {
    const [result] = await fetchItemImages(
      input({ urls: ["https://cdn.example.net/a.png", `${other}/x.png`] }),
    );
    expect(result).toMatchObject({ reason: "host_not_allowed" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("allows only the environment host without an images block", async () => {
    const results = await fetchItemImages(
      input({
        images: null,
        urls: [`${api}/images/plain.png`, `${other}/images/plain.png`],
      }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "ok",
      "host_not_allowed",
    ]);
  });

  it("matches a *.example.com pattern but not the bare domain", async () => {
    const results = await fetchItemImages(
      input({
        images: { hosts: ["*.example.net"], newestItems: 12 },
        urls: ["https://example.net/a.png", "ftp://cdn.example.net/a.png"],
      }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "host_not_allowed",
      "invalid_url",
    ]);
  });

  it.each([
    "http://x.example/a.png",
    "https://u:p@x.example/a.png",
    "not a url",
    "javascript:alert(1)",
  ])("calls %s invalid_url", async (url) => {
    const [result] = await fetchItemImages({
      ...input({ urls: [url] }),
      allowInsecureHttp: false,
    });
    expect(result).toMatchObject({ reason: "invalid_url" });
  });

  it("returns the bytes and content type of each image", async () => {
    const [png, webp] = await fetchItemImages(
      input({ urls: [`${api}/images/n/7.png`, `${api}/images/lossy.webp`] }),
    );
    expect(png).toEqual({
      url: `${api}/images/n/7.png`,
      ok: true,
      bytes: fixturePng(7),
      contentType: "image/png",
    });
    expect(webp).toMatchObject({ ok: true, contentType: "image/webp" });
  });

  it("reports too_large above maxBytes and fetch_failed on a timeout", async () => {
    const results = await fetchItemImages(
      input({
        urls: [
          `${api}/images/big.png`,
          `${api}/images/slow`,
          `${api}/images/missing.png`,
        ],
      }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "too_large",
      "fetch_failed",
      "fetch_failed",
    ]);
  });

  it("counts a body over maxBytes as too_large even when the runtime passes it", async () => {
    const [result] = await fetchItemImages({
      ...input({
        urls: [`${api}/images/plain.png`],
        runtime: fixtureRuntime(["127.0.0.1"]),
      }),
      maxBytes: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("keeps the order of urls and runs at most `concurrency` requests at once", async () => {
    let active = 0;
    let peak = 0;
    const runtime: ConnectorRuntime = {
      signal: new AbortController().signal,
      async fetch(url): Promise<ConnectorResponse> {
        active += 1;
        peak = Math.max(peak, active);
        const n = Number(/(\d+)\.png$/.exec(url)![1]);
        await new Promise((resolve) => setTimeout(resolve, (n % 3) * 5));
        active -= 1;
        const bytes = fixturePng(n);
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          text: () => "",
          json: () => null,
          bytes: () => new Uint8Array(bytes),
        };
      },
    };
    const urls = Array.from(
      { length: 9 },
      (_, i) => `${api}/images/n/${i + 1}.png`,
    );
    const results = await fetchItemImages(
      input({ urls, runtime, concurrency: 2 }),
    );
    expect(results.map((r) => r.url)).toEqual(urls);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });

  it("skips a non-image content type without reading its body", async () => {
    let read = 0;
    const runtime: ConnectorRuntime = {
      signal: new AbortController().signal,
      async fetch(url): Promise<ConnectorResponse> {
        const html = url.endsWith("/page");
        return {
          status: 200,
          headers: {
            "content-type": html
              ? "text/html; charset=utf-8"
              : "binary/octet-stream",
          },
          text: () => "",
          json: () => null,
          bytes: () => {
            read += 1;
            return new Uint8Array(fixturePng(1));
          },
        };
      },
    };
    const results = await fetchItemImages(
      input({ urls: [`${api}/page`, `${api}/object`], runtime }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "unsupported_type",
      "ok",
    ]);
    expect(read).toBe(1);
    // The real fixture route: an HTML answer is not an image either.
    const [html] = await fetchItemImages(
      input({ urls: [`${api}/images/html`] }),
    );
    expect(html).toMatchObject({ ok: false, reason: "unsupported_type" });
  });

  it("hands each image over before fetching the next, so at most `concurrency` bodies are alive", async () => {
    let alive = 0;
    let peak = 0;
    const runtime: ConnectorRuntime = {
      signal: new AbortController().signal,
      async fetch(url): Promise<ConnectorResponse> {
        await new Promise((resolve) => setTimeout(resolve, 2));
        alive += 1;
        peak = Math.max(peak, alive);
        const bytes = fixturePng(Number(/(\d+)\.png$/.exec(url)![1]));
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          text: () => "",
          json: () => null,
          bytes: () => new Uint8Array(bytes),
        };
      },
    };
    const urls = Array.from(
      { length: 12 },
      (_, i) => `${api}/images/n/${i + 1}.png`,
    );
    const seen: number[] = [];
    await forEachItemImage(
      input({ urls, runtime, concurrency: 3 }),
      async (result, index) => {
        expect(result.ok).toBe(true);
        seen.push(index);
        await new Promise((resolve) => setTimeout(resolve, 5));
        alive -= 1;
      },
    );
    expect(seen.sort((a, b) => a - b)).toEqual(urls.map((_, i) => i));
    expect(peak).toBeLessThanOrEqual(3);
  });
});
