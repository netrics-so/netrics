import type {
  ConnectorResponse,
  ResourceIcon,
  ResourceIconsRequest,
} from "@netrics/connector-sdk";
import { RESOURCE_ICON_MAX_BYTES } from "@netrics/connector-sdk";
import { z } from "zod";

import {
  AppStoreConnectApiError,
  type AppStoreConnectClient,
  type AscFetch,
} from "./api.js";

// App icons (#226, ADR 0015 section 5). The primary source is Apple's
// public iTunes lookup: it needs no key role, so it works with the Sales
// key every connection already has. Its artwork URL is a resizable
// template on Apple's image CDN; asking for 1024x1024bb.png gives the
// square 1024 px PNG the App Store shows (no rounded corners, no alpha).
// Unreleased apps are not in the lookup: when the key may read builds, the
// newest build's iconAssetToken (same CDN) is the fallback; a key that may
// not (Sales, Customer Support) answers 403 and is not asked again in this
// call. Nothing is fetched from a host outside the pinned lists below, and
// the egress allowlist of the manifest enforces the same on every hop.

/** The public lookup endpoint (no authentication). */
export const ITUNES_LOOKUP_HOST = "itunes.apple.com";
export const ITUNES_LOOKUP_URL = `https://${ITUNES_LOOKUP_HOST}/lookup`;

/**
 * The image CDN hosts artwork and build icons are served from, exactly
 * (recorded from real lookups on 2026-10-04: is1-ssl answers, is2…is5-ssl
 * serve the same paths). No `*.mzstatic.com` wildcard.
 */
export const ARTWORK_HOSTS: readonly string[] = [
  "is1-ssl.mzstatic.com",
  "is2-ssl.mzstatic.com",
  "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com",
  "is5-ssl.mzstatic.com",
];

/** Apps per lookup request (Apple answers batches of comma-separated ids). */
export const LOOKUP_BATCH_SIZE = 50;
/**
 * Lookup requests per call at most: Apple asks for about 20 per minute,
 * and icons are refreshed at most daily, so a few per call is plenty.
 */
export const MAX_LOOKUP_REQUESTS = 6;
/** Storefronts tried per app beyond the default (US) one. */
const MAX_FALLBACK_TERRITORIES = 2;
/** Build icons read per call at most (one request each). */
const MAX_BUILD_PROBES = 10;
/** The size asked for: Apple's largest, capped at the source size. */
export const ICON_SIZE = 1024;

const lookupSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(
    z
      .object({
        trackId: z.number().int().optional(),
        wrapperType: z.string().optional(),
        artworkUrl512: z.string().optional(),
        artworkUrl100: z.string().optional(),
      })
      .loose(),
  ),
});

const buildsSchema = z.object({
  data: z.array(
    z
      .object({
        attributes: z
          .object({
            iconAssetToken: z
              .object({ templateUrl: z.string().optional() })
              .loose()
              .nullable()
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
});

/** An artwork or icon URL outside ARTWORK_HOSTS (never fetched). */
export class ArtworkHostError extends Error {
  constructor(host: string) {
    super(
      `App icon is hosted on ${host.slice(0, 120)}, which netrics does not allow (allowed: ${ARTWORK_HOSTS.join(", ")})`,
    );
    this.name = "ArtworkHostError";
  }
}

/** The URL, if it is https on one of ARTWORK_HOSTS; else throws. */
export function checkArtworkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtworkHostError("an invalid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !ARTWORK_HOSTS.includes(url.hostname.toLowerCase())
  ) {
    throw new ArtworkHostError(
      url.protocol === "https:"
        ? url.hostname
        : `${url.protocol}//${url.hostname}`,
    );
  }
  return url;
}

const SIZE_SEGMENT = /^\d{1,4}x\d{1,4}[a-z]{0,4}\.(?:png|jpe?g|webp)$/i;

/**
 * The artwork URL resized to ICON_SIZE in the given format, by replacing
 * its last path segment (`512x512bb.jpg` → `1024x1024bb.png`). Null when
 * the URL does not end in a size segment (Apple changed the template).
 */
export function resizeArtworkUrl(
  raw: string,
  format: "png" | "jpg" = "png",
): string | null {
  const url = checkArtworkUrl(raw);
  const segments = url.pathname.split("/");
  const last = segments.at(-1) ?? "";
  if (!SIZE_SEGMENT.test(last)) {
    return null;
  }
  segments[segments.length - 1] = `${ICON_SIZE}x${ICON_SIZE}bb.${format}`;
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * A build icon's template URL filled in (`{w}x{h}bb.{f}`; the placeholders
 * are undocumented and come from Apple's own clients). Null when it has
 * none of them.
 */
export function fillIconTemplate(
  template: string,
  format: "png" | "jpg" = "png",
): string | null {
  if (!/\{w\}/.test(template) || !/\{h\}/.test(template)) {
    return null;
  }
  const filled = template
    .replaceAll("{w}", String(ICON_SIZE))
    .replaceAll("{h}", String(ICON_SIZE))
    .replaceAll("{f}", format)
    .replaceAll("{c}", "bb");
  return checkArtworkUrl(filled).toString();
}

/**
 * Looks up apps on the App Store: Apple ID → artwork URL. Apps that are
 * not sold in the storefront (or not released) are left out.
 */
export async function lookupArtwork(
  fetch: AscFetch,
  appIds: readonly string[],
  country?: string,
): Promise<Map<string, string>> {
  const url = new URL(ITUNES_LOOKUP_URL);
  url.searchParams.set("id", appIds.join(","));
  url.searchParams.set("entity", "software");
  if (country) {
    url.searchParams.set("country", country.toLowerCase());
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (response.status !== 200) {
    throw new Error(
      `The App Store lookup answered ${response.status}; app icons are tried again later.`,
    );
  }
  const body = lookupSchema.parse(response.json());
  const wanted = new Set(appIds);
  const artwork = new Map<string, string>();
  for (const result of body.results) {
    const id = result.trackId === undefined ? "" : String(result.trackId);
    const url = result.artworkUrl512 ?? result.artworkUrl100;
    if (wanted.has(id) && url && !artwork.has(id)) {
      artwork.set(id, url);
    }
  }
  return artwork;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniff(bytes: Uint8Array): ResourceIcon["contentType"] | null {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/**
 * Downloads one icon: the PNG, or the JPEG of the same artwork when the
 * PNG is larger than the host's image limit. The host is checked before
 * each request; no App Store Connect token is ever sent to the CDN.
 */
export async function downloadIcon(
  fetch: AscFetch,
  urlFor: (format: "png" | "jpg") => string | null,
): Promise<Pick<ResourceIcon, "contentType" | "data"> | null> {
  for (const format of ["png", "jpg"] as const) {
    const url = urlFor(format);
    if (!url) {
      return null;
    }
    checkArtworkUrl(url);
    let response: ConnectorResponse;
    try {
      response = await fetch(url, { method: "GET" });
    } catch (error) {
      // The egress cap (10 MiB) or a network failure: no icon this time.
      if (error instanceof Error && /exceeds/.test(error.message)) {
        continue;
      }
      throw error;
    }
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      throw new Error(
        `The App Store image server answered ${response.status}; app icons are tried again later.`,
      );
    }
    const bytes = response.bytes();
    if (bytes.length > RESOURCE_ICON_MAX_BYTES) {
      continue;
    }
    const contentType = sniff(bytes);
    if (!contentType) {
      return null;
    }
    return { contentType, data: Buffer.from(bytes).toString("base64") };
  }
  return null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/**
 * Where to find each app's artwork: the default (US) storefront first,
 * then, for apps it does not list, the territories the host hinted (the
 * app's largest sales territories), batched per storefront. At most
 * MAX_LOOKUP_REQUESTS requests.
 */
export async function findArtwork(
  fetch: AscFetch,
  resources: ResourceIconsRequest["resources"],
): Promise<Map<string, string>> {
  const ids = [...new Set(resources.map((resource) => resource.id))].filter(
    (id) => /^\d+$/.test(id),
  );
  const artwork = new Map<string, string>();
  let requests = 0;
  for (const batch of chunks(ids, LOOKUP_BATCH_SIZE)) {
    if (requests >= MAX_LOOKUP_REQUESTS) break;
    requests += 1;
    for (const [id, url] of await lookupArtwork(fetch, batch)) {
      artwork.set(id, url);
    }
  }
  // Missing apps, grouped by the storefronts to try next.
  for (let round = 0; round < MAX_FALLBACK_TERRITORIES; round += 1) {
    const byCountry = new Map<string, string[]>();
    for (const resource of resources) {
      if (artwork.has(resource.id) || !/^\d+$/.test(resource.id)) continue;
      const country = (resource.territories ?? []).filter(
        (territory) => territory !== "US",
      )[round];
      if (!country) continue;
      byCountry.set(country, [...(byCountry.get(country) ?? []), resource.id]);
    }
    for (const [country, missing] of [...byCountry].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const batch of chunks(missing, LOOKUP_BATCH_SIZE)) {
        if (requests >= MAX_LOOKUP_REQUESTS) return artwork;
        requests += 1;
        for (const [id, url] of await lookupArtwork(fetch, batch, country)) {
          artwork.set(id, url);
        }
      }
    }
  }
  return artwork;
}

/**
 * The newest build's icon template, when the key may read builds. Returns
 * "forbidden" on Apple's 403 (Sales and Customer Support keys), so the
 * caller stops asking; null when the app has no build with an icon.
 */
export async function buildIconTemplate(
  client: AppStoreConnectClient,
  appId: string,
): Promise<string | null | "forbidden"> {
  let body: unknown;
  try {
    body = await client.getJson("/v1/builds", {
      "filter[app]": appId,
      sort: "-uploadedDate",
      limit: "1",
      "fields[builds]": "iconAssetToken",
    });
  } catch (error) {
    if (
      error instanceof AppStoreConnectApiError &&
      (error.status === 403 || error.status === 401)
    ) {
      return "forbidden";
    }
    if (error instanceof AppStoreConnectApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
  const parsed = buildsSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.data[0]?.attributes?.iconAssetToken?.templateUrl ?? null;
}

/**
 * Icons of the requested apps: the App Store artwork, else (when `client`
 * is given and its key may read builds) the newest build's icon. Apps
 * without either are left out.
 */
export async function appIcons(
  fetch: AscFetch,
  resources: ResourceIconsRequest["resources"],
  client?: AppStoreConnectClient,
): Promise<ResourceIcon[]> {
  const icons: ResourceIcon[] = [];
  let hostError: ArtworkHostError | undefined;
  // An icon on a host outside ARTWORK_HOSTS is skipped (never fetched);
  // when no icon at all could be read, that is reported as the failure.
  const guarded = async (
    download: () => Promise<Pick<ResourceIcon, "contentType" | "data"> | null>,
  ) => {
    try {
      return await download();
    } catch (error) {
      if (error instanceof ArtworkHostError) {
        hostError ??= error;
        return null;
      }
      throw error;
    }
  };
  const artwork = await findArtwork(fetch, resources);
  const missing: string[] = [];
  for (const resource of resources) {
    const url = artwork.get(resource.id);
    const icon = url
      ? await guarded(() =>
          downloadIcon(fetch, (format) => resizeArtworkUrl(url, format)),
        )
      : null;
    if (icon) {
      icons.push({ resourceId: resource.id, ...icon });
    } else if (/^\d+$/.test(resource.id)) {
      missing.push(resource.id);
    }
  }
  if (client) {
    for (const appId of missing.slice(0, MAX_BUILD_PROBES)) {
      const template = await buildIconTemplate(client, appId);
      if (template === "forbidden") {
        // The key's role cannot read builds: skip silently, every app alike.
        break;
      }
      if (!template) continue;
      const icon = await guarded(() =>
        downloadIcon(fetch, (format) => fillIconTemplate(template, format)),
      );
      if (icon) {
        icons.push({ resourceId: appId, ...icon });
      }
    }
  }
  if (icons.length === 0 && hostError) {
    throw hostError;
  }
  return icons;
}
