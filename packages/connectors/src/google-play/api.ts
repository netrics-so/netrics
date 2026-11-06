import type {
  ConnectionContext,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { z } from "zod";

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
  size: z.string().regex(/^\d+$/),
});
export type ReportObject = z.infer<typeof objectSchema>;
const listSchema = z.object({
  items: z.array(objectSchema).optional(),
  nextPageToken: z.string().min(1).optional(),
});

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
      "Paste the Google Cloud Storage report URI from Play Console, beginning with gs://pubsite_prod_rev_.",
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
  const get = async (url: URL, accept = "application/json") => {
    const response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept },
    });
    if (response.status !== 200) throw new PlayReportError(response.status);
    return response;
  };
  return {
    async sample(prefix: string): Promise<ReportObject | undefined> {
      const url = new URL(base);
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("maxResults", "1");
      url.searchParams.set("fields", "items(name,generation,updated,size)");
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
        url.searchParams.set(
          "fields",
          "items(name,generation,updated,size),nextPageToken",
        );
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
      url.searchParams.set("fields", "name,generation,updated,size");
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
    async bytes(object: ReportObject): Promise<Uint8Array> {
      const url = new URL(base + "/" + encodeURIComponent(object.name));
      url.searchParams.set("alt", "media");
      url.searchParams.set("generation", object.generation);
      const response = await get(url, "*/*");
      const generation = response.headers["x-goog-generation"];
      if (generation !== undefined && generation !== object.generation)
        throw new Error(
          "Google Play report changed while it was read. Retry sync.",
        );
      const bytes = response.bytes();
      if (BigInt(bytes.byteLength) !== BigInt(object.size))
        throw new Error(
          "Google Play report size changed while it was read. Retry sync.",
        );
      return bytes;
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
