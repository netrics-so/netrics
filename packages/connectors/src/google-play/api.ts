import type {
  ConnectionContext,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  REPORT_MAX_BYTES,
  ReportTooLargeError,
  type ReportSource,
} from "./tabular.js";

export const STORAGE_HOST = "storage.googleapis.com";
export const STORAGE_SCOPE =
  "https://www.googleapis.com/auth/devstorage.read_only";
export const REPORTING_HOST = "playdeveloperreporting.googleapis.com";
export const REPORTING_SCOPE =
  "https://www.googleapis.com/auth/playdeveloperreporting";
const objectSchema = z.object({
  name: z.string().min(1),
  generation: z.string().regex(/^\d+$/),
  updated: z.iso.datetime(),
  /** Bytes as stored: for a gzip-encoded object, the compressed size. */
  size: z.string().regex(/^\d+$/),
  /**
   * Play Console stores some reports with Content-Encoding: gzip. Such an
   * object reaches connector code decompressed (runtime.fetch decodes gzip,
   * and Cloud Storage transcodes for clients that do not accept it), so its
   * body length is not `size`, and Range headers are ignored for it.
   */
  contentEncoding: z.string().optional(),
});
export type ReportObject = z.infer<typeof objectSchema>;
const OBJECT_FIELDS = "name,generation,updated,size,contentEncoding";
/** Whether the object is served decompressed and only whole. */
export function gzipEncoded(object: ReportObject): boolean {
  return (object.contentEncoding ?? "")
    .split(",")
    .some((coding) => coding.trim().toLowerCase() === "gzip");
}
const listSchema = z.object({
  items: z.array(objectSchema).optional(),
  nextPageToken: z.string().min(1).optional(),
});

/**
 * Largest report body requested at once. runtime.fetch buffers each response
 * under the host limit (10 MiB by default), so larger objects are read as
 * generation-pinned byte ranges of this size.
 */
export const REPORT_RANGE_BYTES = 8 * 1024 * 1024;

export class PlayReportError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Reconnect Google to refresh report access."
        : status === 403
          ? "This Google account cannot read these Play reports. Check Play Console app and financial permissions."
          : status === 404
            ? "This Google Play report is not available yet."
            : status === 429
              ? "Google Play reports are temporarily rate limited. Sync will retry."
              : "Google Play reports are temporarily unavailable. Sync will retry.",
    );
    this.name = "PlayReportError";
  }
}

export function bucketName(config: Readonly<Record<string, unknown>>): string {
  const raw =
    typeof config.reportBucket === "string" ? config.reportBucket.trim() : "";
  const match =
    /^(?:gs:\/\/)?(pubsite_prod_(?:rev_)?[A-Za-z0-9_-]+)(?:\/[^?#]*)?$/.exec(
      raw,
    );
  if (!match)
    throw new Error(
      "Paste the Google Cloud Storage report URI from Play Console, beginning with gs://pubsite_prod_.",
    );
  return match[1]!;
}

export function manualPackages(
  config: Readonly<Record<string, unknown>>,
): string[] {
  const raw = config.packageNames;
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string")
    throw new Error("Enter package names separated by commas or new lines.");
  const values = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.some((value) => !validPackage(value)))
    throw new Error("Enter Android package names such as com.example.app.");
  return values.sort();
}
export function validPackage(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
}

export function createPlayReportsClient(
  context: ConnectionContext,
  runtime: ConnectorRuntime,
) {
  const bucket = bucketName(context.config);
  const token = context.credentials.accessToken;
  if (typeof token !== "string" || !token.trim())
    throw new Error("Connect your Google account to read Play reports.");
  const base = `https://${STORAGE_HOST}/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  const get = async (url: URL, accept = "application/json", range?: string) => {
    const response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        ...(range ? { range } : {}),
      },
    });
    if (response.status !== (range ? 206 : 200))
      throw new PlayReportError(response.status);
    return response;
  };
  const media = (object: ReportObject) => {
    const url = new URL(base + "/" + encodeURIComponent(object.name));
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", object.generation);
    return url;
  };
  const changed = () =>
    new Error("Google Play report changed while it was read. Retry sync.");
  const resized = () =>
    new Error("Google Play report size changed while it was read. Retry sync.");
  const pinned = (
    object: ReportObject,
    response: Awaited<ReturnType<typeof get>>,
  ) => {
    const generation = response.headers["x-goog-generation"];
    if (generation !== undefined && generation !== object.generation)
      throw changed();
  };
  /** One byte range [start, end] of the pinned generation. */
  const range = async (object: ReportObject, start: number, end: number) => {
    const response = await get(media(object), "*/*", `bytes=${start}-${end}`);
    pinned(object, response);
    const bytes = response.bytes();
    if (
      response.headers["content-range"] !==
        `bytes ${start}-${end}/${object.size}` ||
      bytes.byteLength !== end - start + 1
    )
      throw resized();
    return bytes;
  };
  const whole = async (object: ReportObject): Promise<Uint8Array> => {
    let response: Awaited<ReturnType<typeof get>>;
    try {
      response = await get(media(object), "*/*");
    } catch (error) {
      // runtime.fetch bounds the body it hands over, decompressed included.
      if (
        gzipEncoded(object) &&
        error instanceof Error &&
        /^egress denied: response exceeds\b/.test(error.message)
      )
        throw new ReportTooLargeError(
          "Google Play report exceeds the read limit once decompressed",
        );
      throw error;
    }
    pinned(object, response);
    const bytes = response.bytes();
    const stored = response.headers["x-goog-stored-content-encoding"];
    if (
      gzipEncoded(object) &&
      (stored === undefined || stored.trim().toLowerCase() === "gzip")
    ) {
      // The body is the decompressed report, so its length cannot be checked
      // against the stored size; the stored length still must match, and the
      // generation pin above ties the body to the listed object.
      const storedLength = response.headers["x-goog-stored-content-length"];
      if (storedLength !== undefined && storedLength !== object.size)
        throw resized();
      if (bytes.byteLength > REPORT_MAX_BYTES) throw new ReportTooLargeError();
      return bytes;
    }
    if (BigInt(bytes.byteLength) !== BigInt(object.size)) throw resized();
    return bytes;
  };
  return {
    async sample(prefix: string): Promise<ReportObject | undefined> {
      const url = new URL(base);
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("maxResults", "1");
      url.searchParams.set("fields", `items(${OBJECT_FIELDS})`);
      const page = listSchema.parse((await get(url)).json());
      const object = page.items?.[0];
      if (object && !object.name.startsWith(prefix))
        throw new Error(
          "Google Play returned a report outside the requested directory.",
        );
      return object;
    },
    async list(prefix: string): Promise<ReportObject[]> {
      const objects: ReportObject[] = [],
        visited = new Set<string>();
      let next: string | undefined;
      do {
        const url = new URL(base);
        url.searchParams.set("prefix", prefix);
        url.searchParams.set("maxResults", "1000");
        url.searchParams.set("fields", `items(${OBJECT_FIELDS}),nextPageToken`);
        if (next) {
          if (visited.has(next))
            throw new Error("Google Play report listing repeated a page.");
          visited.add(next);
          url.searchParams.set("pageToken", next);
        }
        const page = listSchema.parse((await get(url)).json());
        for (const object of page.items ?? []) {
          if (!object.name.startsWith(prefix))
            throw new Error(
              "Google Play returned a report outside the requested directory.",
            );
          objects.push(object);
        }
        next = page.nextPageToken;
      } while (next);
      const unique = new Map<string, ReportObject>();
      for (const object of objects) {
        const prior = unique.get(object.name);
        if (prior && prior.generation !== object.generation)
          throw new Error(
            "Google Play report listing changed while it was read. Retry sync.",
          );
        unique.set(object.name, object);
      }
      return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Re-authorize a cached generation without transferring its report body. */
    async validate(object: ReportObject): Promise<void> {
      const url = new URL(base + "/" + encodeURIComponent(object.name));
      url.searchParams.set("generation", object.generation);
      url.searchParams.set("fields", OBJECT_FIELDS);
      const current = objectSchema.parse((await get(url)).json());
      if (
        current.name !== object.name ||
        current.generation !== object.generation ||
        current.size !== object.size
      )
        throw new Error(
          "Google Play report changed while it was read. Retry sync.",
        );
    },
    bytes: whole,
    /**
     * Random access to the pinned generation. An object of at most one range
     * is fetched whole, as `bytes` does; a larger one is read in aligned
     * ranges, and only the most recently fetched range is kept. A
     * gzip-encoded object cannot be read by range and its decompressed size
     * is only known once read, so it is fetched whole (bounded by the fetch
     * limit) and served from memory.
     */
    async source(object: ReportObject): Promise<ReportSource> {
      if (gzipEncoded(object)) {
        const bytes = await whole(object);
        return {
          size: bytes.byteLength,
          async read(offset, length) {
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(length) ||
              offset < 0 ||
              length < 0 ||
              offset + length > bytes.byteLength
            )
              throw new Error("Google Play report read is outside the object");
            return bytes.slice(offset, offset + length);
          },
        };
      }
      const size = Number(object.size);
      let block: { start: number; bytes: Uint8Array } | undefined;
      const load = async (index: number) => {
        const start = index * REPORT_RANGE_BYTES;
        if (block?.start === start) return block.bytes;
        block = undefined;
        const bytes =
          size <= REPORT_RANGE_BYTES
            ? await whole(object)
            : await range(
                object,
                start,
                Math.min(size, start + REPORT_RANGE_BYTES) - 1,
              );
        block = { start, bytes };
        return bytes;
      };
      return {
        size,
        async read(offset, length) {
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            offset + length > size
          )
            throw new Error("Google Play report read is outside the object");
          const first = Math.floor(offset / REPORT_RANGE_BYTES);
          const last = Math.floor(
            (offset + Math.max(length, 1) - 1) / REPORT_RANGE_BYTES,
          );
          if (length === 0 || first === last) {
            const bytes = await load(first);
            const at = offset - first * REPORT_RANGE_BYTES;
            return bytes.slice(at, at + length);
          }
          const out = new Uint8Array(length);
          for (let index = first; index <= last; index++) {
            const bytes = await load(index),
              start = index * REPORT_RANGE_BYTES;
            const from = Math.max(offset, start),
              to = Math.min(offset + length, start + bytes.byteLength);
            out.set(bytes.subarray(from - start, to - start), from - offset);
          }
          return out;
        },
      };
    },
  };
}
export type PlayReportsClient = ReturnType<typeof createPlayReportsClient>;

/** The read-only Reporting API supplies names; downloads/earnings use GCS. */
export async function accessibleApps(
  context: ConnectionContext,
  runtime: ConnectorRuntime,
): Promise<Array<{ id: string; name: string }>> {
  const token = context.credentials.accessToken;
  if (typeof token !== "string" || !token.trim())
    throw new Error("Connect your Google account to list Play apps.");
  const schema = z.object({
    apps: z
      .array(
        z.object({
          packageName: z.string().refine(validPackage),
          displayName: z.string().min(1),
        }),
      )
      .optional(),
    nextPageToken: z.string().min(1).optional(),
  });
  const apps = new Map<string, string>(),
    visited = new Set<string>();
  let next: string | undefined;
  do {
    const url = new URL(`https://${REPORTING_HOST}/v1beta1/apps:search`);
    url.searchParams.set("pageSize", "1000");
    if (next) {
      if (visited.has(next))
        throw new Error("Google Play app discovery repeated a page.");
      visited.add(next);
      url.searchParams.set("pageToken", next);
    }
    const response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (response.status !== 200) throw new PlayReportError(response.status);
    const page = schema.parse(response.json());
    for (const app of page.apps ?? [])
      apps.set(app.packageName, app.displayName);
    next = page.nextPageToken;
  } while (next);
  return [...apps]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
