import { readFileSync } from "node:fs";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

export const TEST_BUCKET = "pubsite_prod_rev_0000000000";
export const ALPHA = "com.example.alpha",
  BETA = "com.example.beta";
export const TEST_NOW = Date.parse("2026-11-05T12:00:00.000Z");
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  );
}
export function jsonResponse(status: number, body: unknown): ConnectorResponse {
  return byteResponse(
    status,
    new TextEncoder().encode(JSON.stringify(body)),
    "application/json",
  );
}
export function byteResponse(
  status: number,
  bytes: Uint8Array,
  type = "application/octet-stream",
  headers: Record<string, string> = {},
): ConnectorResponse {
  return {
    status,
    headers: { "content-type": type, ...headers },
    bytes: () => new Uint8Array(bytes),
    text: () => new TextDecoder().decode(bytes),
    json: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  };
}
export interface FakeReportObject {
  name: string;
  generation: string;
  updated: string;
  size: string;
  bytes: Uint8Array;
}
export function fakePlay(
  options: {
    acceptToken?: (token: string) => boolean | Promise<boolean>;
    pageSize?: number;
  } = {},
) {
  const objects = new Map<string, FakeReportObject>();
  const calls: Array<{ url: URL; init?: ConnectorFetchInit }> = [];
  const apps = new Map([
    [ALPHA, "Alpha Notes"],
    [BETA, "Beta Tracker"],
  ]);
  const privateStatus = new Map<string, number>();
  const publicStatus = new Map<string, number>();
  const publicFacts = new Map<string, unknown>();
  let rejectNext = 0;
  const put = (
    name: string,
    bytes: Uint8Array,
    generation = "1",
    updated = "2026-11-04T12:00:00.000Z",
  ) =>
    objects.set(name, {
      name,
      bytes,
      generation,
      updated,
      size: String(bytes.byteLength),
    });
  put(
    `stats/installs/installs_${ALPHA}_202610_country.csv`,
    fixtureBytes("installs-alpha.csv"),
  );
  put(
    `stats/installs/installs_${BETA}_202610_country.csv`,
    fixtureBytes("installs-beta.csv"),
  );
  put("earnings/earnings_202610.zip", fixtureBytes("earnings_202610.zip"));
  put(
    "earnings/earnings_202610_adjustment.zip",
    fixtureBytes("earnings_202610_adjustment.zip"),
  );
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const fetch: ConnectorRuntime["fetch"] = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, init });
    const authorization = init?.headers?.authorization;
    if (
      [
        "storage.googleapis.com",
        "playdeveloperreporting.googleapis.com",
      ].includes(url.hostname)
    ) {
      const token = authorization?.replace(/^Bearer /, "") ?? "";
      if (rejectNext > 0) {
        rejectNext--;
        return jsonResponse(401, { error: "synthetic expired access token" });
      }
      if (
        !token ||
        !(await (options.acceptToken?.(token) ??
          token === "synthetic-access-token"))
      )
        return jsonResponse(401, { error: "synthetic invalid access token" });
      if (url.hostname === "playdeveloperreporting.googleapis.com") {
        const status = privateStatus.get("apps");
        if (status)
          return jsonResponse(status, { error: "private provider diagnostic" });
        const offset = Number(url.searchParams.get("pageToken") ?? 0),
          size = Math.min(
            options.pageSize ?? 1000,
            Number(url.searchParams.get("pageSize") ?? 50),
          );
        const all = [...apps].map(([packageName, displayName]) => ({
          name: `apps/${packageName}`,
          packageName,
          displayName,
        }));
        return jsonResponse(200, {
          apps: all.slice(offset, offset + size),
          ...(offset + size < all.length
            ? { nextPageToken: String(offset + size) }
            : {}),
        });
      }
      const base = `/storage/v1/b/${TEST_BUCKET}/o`;
      if (!url.pathname.startsWith(base)) return jsonResponse(404, {});
      const prefix = url.searchParams.get("prefix");
      if (prefix !== null) {
        const status = privateStatus.get(prefix);
        if (status)
          return jsonResponse(status, { error: "private provider diagnostic" });
        const offset = Number(url.searchParams.get("pageToken") ?? 0),
          size = Math.min(
            options.pageSize ?? 1000,
            Number(url.searchParams.get("maxResults") ?? 1000),
          );
        const all = [...objects.values()]
          .filter((object) => object.name.startsWith(prefix))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ bytes: _bytes, ...metadata }) => metadata);
        return jsonResponse(200, {
          items: all.slice(offset, offset + size),
          ...(offset + size < all.length
            ? { nextPageToken: String(offset + size) }
            : {}),
        });
      }
      const name = decodeURIComponent(url.pathname.slice(base.length + 1));
      const status = privateStatus.get(name);
      if (status)
        return jsonResponse(status, { error: "private provider diagnostic" });
      const object = objects.get(name);
      if (!object || object.generation !== url.searchParams.get("generation"))
        return jsonResponse(404, {});
      return byteResponse(200, object.bytes, "application/octet-stream", {
        "x-goog-generation": object.generation,
      });
    }
    if (authorization !== undefined)
      throw new Error("Credentials reached a public host");
    if (url.hostname === "play.google.com") {
      const appId = url.searchParams.get("id") ?? "";
      const status = publicStatus.get(appId);
      if (status)
        return byteResponse(
          status,
          new TextEncoder().encode("Unavailable"),
          "text/html",
        );
      if (!apps.has(appId))
        return byteResponse(404, new Uint8Array(), "text/html");
      const facts = publicFacts.get(appId) ?? {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: apps.get(appId),
        url: `https://play.google.com/store/apps/details?id=${appId}`,
        image: `https://play-lh.googleusercontent.com/${appId}`,
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: appId === ALPHA ? "4.25" : "0",
          ratingCount: appId === ALPHA ? "123456" : "0",
        },
      };
      return byteResponse(
        200,
        new TextEncoder().encode(
          `<html><script type="application/ld+json">${JSON.stringify(facts)}</script></html>`,
        ),
        "text/html",
      );
    }
    if (url.hostname === "play-lh.googleusercontent.com")
      return byteResponse(200, png, "image/png");
    throw new Error("Fake Google Play refuses an undeclared host");
  };
  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch,
  };
  return {
    runtime,
    fetch,
    calls,
    objects,
    put,
    apps,
    privateStatus,
    publicStatus,
    publicFacts,
    png,
    reject(count: number) {
      rejectNext = count;
    },
  };
}
