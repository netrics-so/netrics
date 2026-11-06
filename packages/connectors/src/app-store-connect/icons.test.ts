import { crc32, deflateSync } from "node:zlib";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { createAppStoreConnectConnector } from "./index.js";
import {
  ArtworkHostError,
  checkArtworkUrl,
  fillIconTemplate,
  resizeArtworkUrl,
} from "./icons.js";
import { fixture, jsonResponse } from "./test-helpers.js";

// App icons (#226), offline. `itunes-lookup-us.json` is a real lookup of
// three apps (2026-10-04, `?id=6767935139,6758914712,6788250340&country=us
// &entity=software`), trimmed to the fields netrics reads plus names;
// `itunes-lookup-empty.json` is Apple's answer shape for ids it does not
// list. Icons are synthetic PNGs.

const WURFEL = "6767935139";
const VOILA = "6758914712";
const PAPERSTAND = "6788250340";
const TOKEN = "signed-token-for-icons";

/** A valid 1 × 1 PNG of one colour (the host parses it strictly later). */
function png(rgb: [number, number, number], padding = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = deflateSync(Buffer.from([0, ...rgb]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      ...(padding > 0 ? [chunk("tEXt", Buffer.alloc(padding, 0x41))] : []),
      chunk("IDAT", pixels),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

function bytesResponse(
  bytes: Uint8Array,
  contentType = "image/png",
): ConnectorResponse {
  return {
    status: 200,
    headers: { "content-type": contentType },
    text: () => new TextDecoder().decode(bytes),
    json: () => {
      throw new Error("not JSON");
    },
    bytes: () => new Uint8Array(bytes),
  };
}

interface Seen {
  url: URL;
  init: ConnectorFetchInit | undefined;
}

/**
 * runtime.fetch over a route table: lookups by storefront, CDN paths by
 * path, App Store Connect builds by app. Every request is recorded.
 */
function fakeApple(routes: {
  lookup?: (ids: string[], country: string | null) => unknown;
  cdn?: Record<string, Uint8Array>;
  builds?: (appId: string) => { status: number; body: unknown };
}) {
  const seen: Seen[] = [];
  const fetch: ConnectorRuntime["fetch"] = async (raw, init) => {
    const url = new URL(raw);
    seen.push({ url, init });
    if (url.hostname === "itunes.apple.com" && url.pathname === "/lookup") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return jsonResponse(
        200,
        routes.lookup?.(ids, url.searchParams.get("country")) ??
          fixture("itunes-lookup-empty"),
      );
    }
    if (url.hostname.endsWith(".mzstatic.com")) {
      const bytes = routes.cdn?.[url.pathname];
      return bytes
        ? bytesResponse(bytes)
        : jsonResponse(404, { error: "not found" });
    }
    if (
      url.hostname === "api.appstoreconnect.apple.com" &&
      url.pathname === "/v1/builds"
    ) {
      const answer = routes.builds?.(
        url.searchParams.get("filter[app]") ?? "",
      ) ?? { status: 200, body: { data: [] } };
      return jsonResponse(answer.status, answer.body);
    }
    throw new Error(`unexpected request ${url.toString()}`);
  };
  const runtime: ConnectorRuntime = {
    fetch,
    signal: new AbortController().signal,
  };
  return { runtime, seen };
}

/** The lookup fixture restricted to `ids`. */
function realLookup(ids: string[]) {
  const all = fixture("itunes-lookup-us") as {
    results: Array<{ trackId: number }>;
  };
  const results = all.results.filter((entry) =>
    ids.includes(String(entry.trackId)),
  );
  return { resultCount: results.length, results };
}

function cdnPath(appId: string, size = "1024x1024bb.png"): string {
  const entry = realLookup([appId]).results[0] as unknown as {
    artworkUrl512: string;
  };
  const url = new URL(entry.artworkUrl512);
  return url.pathname.replace(/[^/]+$/, size);
}

const context = (token?: string) => ({
  connectionId: "connection-1",
  config: { vendorNumber: "85012345" },
  credentials: token ? { accessToken: token } : {},
});

const connector = createAppStoreConnectConnector();

describe("App Store Connect app icons (#226)", () => {
  it("looks all apps up in one batch and fetches each 1024 px PNG from the pinned CDN", async () => {
    const icons = {
      [WURFEL]: png([20, 120, 220]),
      [VOILA]: png([240, 80, 40]),
      [PAPERSTAND]: png([30, 30, 30]),
    };
    const apple = fakeApple({
      lookup: (ids) => realLookup(ids),
      cdn: Object.fromEntries(
        Object.entries(icons).map(([id, bytes]) => [cdnPath(id), bytes]),
      ),
    });
    const result = await connector.resourceIcons!(
      context(TOKEN),
      { resources: [{ id: WURFEL }, { id: VOILA }, { id: PAPERSTAND }] },
      apple.runtime,
    );
    expect(result.icons.map((icon) => icon.resourceId).sort()).toEqual(
      [PAPERSTAND, VOILA, WURFEL].sort(),
    );
    for (const icon of result.icons) {
      expect(icon.contentType).toBe("image/png");
      expect(Buffer.from(icon.data, "base64")).toEqual(
        Buffer.from(icons[icon.resourceId as keyof typeof icons]),
      );
    }
    const lookups = apple.seen.filter(
      (request) => request.url.hostname === "itunes.apple.com",
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.url.searchParams.get("id")).toBe(
      `${WURFEL},${VOILA},${PAPERSTAND}`,
    );
    expect(lookups[0]!.url.searchParams.get("entity")).toBe("software");
    expect(lookups[0]!.url.searchParams.has("country")).toBe(false);
    const images = apple.seen.filter((request) =>
      request.url.hostname.endsWith("mzstatic.com"),
    );
    expect(images.map((request) => request.url.hostname)).toEqual([
      "is1-ssl.mzstatic.com",
      "is1-ssl.mzstatic.com",
      "is1-ssl.mzstatic.com",
    ]);
    expect(
      images.every((request) =>
        request.url.pathname.endsWith("/1024x1024bb.png"),
      ),
    ).toBe(true);
    // The signed token goes to App Store Connect only.
    for (const request of apple.seen) {
      expect(JSON.stringify(request.init ?? {})).not.toContain(TOKEN);
    }
    // Released apps need no build probe.
    expect(
      apple.seen.some((request) => request.url.pathname === "/v1/builds"),
    ).toBe(false);
  });

  it("tries the app's sales territories when the US storefront does not list it", async () => {
    const apple = fakeApple({
      lookup: (ids, country) =>
        country === "jp" ? realLookup(ids) : fixture("itunes-lookup-empty"),
      cdn: { [cdnPath(WURFEL)]: png([1, 2, 3]) },
    });
    const result = await connector.resourceIcons!(
      context(),
      { resources: [{ id: WURFEL, territories: ["US", "DE", "JP"] }] },
      apple.runtime,
    );
    expect(result.icons.map((icon) => icon.resourceId)).toEqual([WURFEL]);
    const countries = apple.seen
      .filter((request) => request.url.hostname === "itunes.apple.com")
      .map((request) => request.url.searchParams.get("country"));
    expect(countries).toEqual([null, "de", "jp"]);
  });

  it("leaves out apps nobody lists and that have no readable build", async () => {
    const apple = fakeApple({});
    const result = await connector.resourceIcons!(
      context(),
      { resources: [{ id: WURFEL }] },
      apple.runtime,
    );
    expect(result.icons).toEqual([]);
  });

  it("falls back to the JPEG of the same artwork when the PNG is above 1 MiB", async () => {
    const apple = fakeApple({
      lookup: (ids) => realLookup(ids),
      cdn: {
        [cdnPath(WURFEL)]: png([9, 9, 9], 1_048_576),
        [cdnPath(WURFEL, "1024x1024bb.jpg")]: JPEG,
      },
    });
    const result = await connector.resourceIcons!(
      context(),
      { resources: [{ id: WURFEL }] },
      apple.runtime,
    );
    expect(result.icons).toEqual([
      {
        resourceId: WURFEL,
        contentType: "image/jpeg",
        data: Buffer.from(JPEG).toString("base64"),
      },
    ]);
  });

  it("never fetches artwork on a host outside the pinned list", async () => {
    const apple = fakeApple({
      lookup: () => ({
        resultCount: 1,
        results: [
          {
            trackId: Number(WURFEL),
            artworkUrl512:
              "https://images.evil.test/thumb/AppIcon.png/512x512bb.jpg",
          },
        ],
      }),
    });
    await expect(
      connector.resourceIcons!(
        context(),
        { resources: [{ id: WURFEL }] },
        apple.runtime,
      ),
    ).rejects.toThrow(ArtworkHostError);
    expect(
      apple.seen.some((request) => request.url.hostname === "images.evil.test"),
    ).toBe(false);
  });

  it("uses the newest build's icon for an unreleased app when the key may read builds", async () => {
    const template =
      "https://is3-ssl.mzstatic.com/image/thumb/Purple/v4/aa/bb/AppIcon.png/{w}x{h}bb.{f}";
    const apple = fakeApple({
      builds: (appId) => ({
        status: 200,
        body: {
          data:
            appId === WURFEL
              ? [
                  {
                    type: "builds",
                    id: "build-1",
                    attributes: {
                      iconAssetToken: {
                        templateUrl: template,
                        width: 1024,
                        height: 1024,
                      },
                    },
                  },
                ]
              : [],
        },
      }),
      cdn: {
        "/image/thumb/Purple/v4/aa/bb/AppIcon.png/1024x1024bb.png": png([
          5, 6, 7,
        ]),
      },
    });
    const result = await connector.resourceIcons!(
      context(TOKEN),
      { resources: [{ id: WURFEL }] },
      apple.runtime,
    );
    expect(result.icons.map((icon) => icon.resourceId)).toEqual([WURFEL]);
    const builds = apple.seen.find(
      (request) => request.url.pathname === "/v1/builds",
    )!;
    expect(builds.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(builds.url.searchParams.get("fields[builds]")).toBe(
      "iconAssetToken",
    );
    const image = apple.seen.find(
      (request) => request.url.hostname === "is3-ssl.mzstatic.com",
    )!;
    expect(image.init?.headers?.authorization).toBeUndefined();
  });

  it("skips build icons silently when the key's role may not read builds (403)", async () => {
    const apple = fakeApple({
      builds: () => ({
        status: 403,
        body: fixture("error-forbidden-role"),
      }),
    });
    const result = await connector.resourceIcons!(
      context(TOKEN),
      { resources: [{ id: WURFEL }, { id: VOILA }] },
      apple.runtime,
    );
    expect(result.icons).toEqual([]);
    // Asked once, not once per app.
    expect(
      apple.seen.filter((request) => request.url.pathname === "/v1/builds"),
    ).toHaveLength(1);
  });
});

describe("artwork URLs", () => {
  it("rewrites the size segment to 1024 px and keeps the CDN path", () => {
    const url = (
      fixture("itunes-lookup-us") as {
        results: Array<{ artworkUrl512: string }>;
      }
    ).results[2]!.artworkUrl512;
    expect(resizeArtworkUrl(url)).toBe(
      url.replace(/512x512bb\.jpg$/, "1024x1024bb.png"),
    );
    expect(resizeArtworkUrl(url, "jpg")).toBe(
      url.replace(/512x512bb\.jpg$/, "1024x1024bb.jpg"),
    );
    expect(
      resizeArtworkUrl("https://is2-ssl.mzstatic.com/image/thumb/a/b/icon"),
    ).toBeNull();
  });

  it("accepts exactly is1-ssl … is5-ssl.mzstatic.com over https", () => {
    for (const host of [1, 2, 3, 4, 5].map((n) => `is${n}-ssl.mzstatic.com`)) {
      expect(checkArtworkUrl(`https://${host}/x/1x1bb.png`).hostname).toBe(
        host,
      );
    }
    for (const raw of [
      "https://is6-ssl.mzstatic.com/x/1x1bb.png",
      "https://mzstatic.com/x/1x1bb.png",
      "https://is1-ssl.mzstatic.com.evil.test/x/1x1bb.png",
      "http://is1-ssl.mzstatic.com/x/1x1bb.png",
      "https://user:pw@is1-ssl.mzstatic.com/x/1x1bb.png",
      "https://is1-ssl.mzstatic.com:8443/x/1x1bb.png",
      "not a url",
    ]) {
      expect(() => checkArtworkUrl(raw)).toThrow(ArtworkHostError);
    }
  });

  it("fills a build icon template and refuses one on another host", () => {
    expect(
      fillIconTemplate(
        "https://is1-ssl.mzstatic.com/image/thumb/p/AppIcon.png/{w}x{h}bb.{f}",
      ),
    ).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/p/AppIcon.png/1024x1024bb.png",
    );
    expect(
      fillIconTemplate("https://is1-ssl.mzstatic.com/image/AppIcon.png"),
    ).toBeNull();
    expect(() =>
      fillIconTemplate("https://cdn.evil.test/{w}x{h}bb.{f}"),
    ).toThrow(ArtworkHostError);
  });
});
