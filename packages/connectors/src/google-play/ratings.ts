import type { ConnectorRuntime, DatasetRecord } from "@netrics/connector-sdk";
import { z } from "zod";

import { validPackage } from "./api.js";
import { reportDecimal } from "./tabular.js";

export const PLAY_STORE_HOST = "play.google.com";
export const PLAY_ARTWORK_HOST = "play-lh.googleusercontent.com";
const entrySchema = z.object({
  "@type": z.literal("SoftwareApplication"),
  name: z.string().max(1_000).optional(),
  url: z.url(),
  image: z.url().optional(),
  aggregateRating: z
    .object({
      "@type": z.literal("AggregateRating").optional(),
      ratingValue: z.union([z.string(), z.number().finite()]).optional(),
      ratingCount: z
        .union([
          z.string(),
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        ])
        .optional(),
    })
    .optional(),
});

export function listingScope(config: Record<string, unknown>): {
  country: string;
  locale: string;
} {
  const country =
    typeof config.ratingStorefront === "string"
      ? config.ratingStorefront.trim().toUpperCase()
      : "US";
  const locale =
    typeof config.ratingLanguage === "string"
      ? config.ratingLanguage.trim()
      : "en";
  if (!/^[A-Z]{2}$/.test(country))
    throw new Error(
      "Enter a two-letter country code for the Google Play listing.",
    );
  if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(locale))
    throw new Error("Enter a listing language such as en, de or pt-BR.");
  return { country, locale };
}

/** Read only structured public listing facts; never execute embedded scripts. */
export function listingFacts(
  html: string,
  appId: string,
): z.infer<typeof entrySchema> | undefined {
  const entries: z.infer<typeof entrySchema>[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  let visited = 0;
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[1]!);
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      if (++visited > 10_000) return undefined;
      const candidate = queue.pop();
      if (!candidate || typeof candidate !== "object") continue;
      const result = entrySchema.safeParse(candidate);
      if (result.success) {
        const url = new URL(result.data.url);
        if (
          url.protocol === "https:" &&
          url.hostname === PLAY_STORE_HOST &&
          url.pathname.startsWith("/store/apps/details") &&
          url.searchParams.get("id") === appId
        )
          entries.push(result.data);
      }
      for (const value of Object.values(candidate))
        if (value && typeof value === "object") queue.push(value);
    }
  }
  return entries.length === 1 ? entries[0] : undefined;
}

export interface ListingSnapshot {
  record: DatasetRecord;
  name?: string;
  artwork?: string;
}
export async function listingSnapshot(
  runtime: ConnectorRuntime,
  appId: string,
  scope: { country: string; locale: string },
  capturedAt: string,
): Promise<ListingSnapshot> {
  if (!validPackage(appId)) throw new Error("Invalid Android package name");
  const url = new URL(`https://${PLAY_STORE_HOST}/store/apps/details`);
  url.searchParams.set("id", appId);
  url.searchParams.set("gl", scope.country);
  url.searchParams.set("hl", scope.locale);
  let facts: z.infer<typeof entrySchema> | undefined,
    availability = "temporarily_unavailable",
    rating: string | null = null,
    count: number | null = null;
  try {
    const response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "text/html" },
    });
    if (response.status === 404) availability = "not_listed";
    else if (response.status === 200) {
      facts = listingFacts(response.text(), appId);
      if (facts) {
        const rawCount = String(facts.aggregateRating?.ratingCount ?? "");
        if (/^\d+$/.test(rawCount) && Number.isSafeInteger(Number(rawCount)))
          count = Number(rawCount);
        const rawRating = facts.aggregateRating?.ratingValue;
        if (rawRating !== undefined) {
          const parsed = reportDecimal(String(rawRating));
          if (parsed !== null && Number(parsed) > 0 && Number(parsed) <= 5)
            rating = parsed;
        }
        availability =
          count === 0 && rating === null
            ? "unrated"
            : count !== null && count > 0 && rating !== null
              ? "available"
              : "incomplete";
      }
    }
  } catch {
    if (runtime.signal.aborted)
      throw new Error("Google Play listing lookup cancelled");
    facts = undefined;
    rating = null;
    count = null;
    availability = "temporarily_unavailable";
  }
  let artwork: string | undefined;
  if (facts?.image) {
    const image = new URL(facts.image);
    if (
      image.protocol === "https:" &&
      image.hostname === PLAY_ARTWORK_HOST &&
      !image.username &&
      !image.password &&
      !image.port
    )
      artwork = image.toString();
  }
  return {
    record: {
      values: {
        app_id: appId,
        app_name: facts?.name ?? null,
        storefront: scope.country,
        locale: scope.locale,
        form_factor: "store_default",
        day: capturedAt.slice(0, 10),
        captured_at: capturedAt,
        rating,
        rating_count: count,
        availability,
        provider_fields: facts?.aggregateRating ?? null,
      },
    },
    ...(facts?.name ? { name: facts.name } : {}),
    ...(artwork ? { artwork } : {}),
  };
}
