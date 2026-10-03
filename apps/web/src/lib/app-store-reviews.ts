/**
 * Copy and small rules of the "App Store ratings and reviews" card (ADR
 * 0014 decision 2, #190): the optional second key with the Customer
 * Support role, its status line, its form fields and what is sent. Pure,
 * so the card and its tests share them.
 */

import type { AppStoreReviewsStatusResponse } from "@netrics/contracts";

import { APP_STORE_CONNECT_KEYS_URL } from "./app-store-analytics";
import { normalizeKeyValue, type SignedKeyStrategy } from "./signed-key";

export type ReviewsStatus = AppStoreReviewsStatusResponse["status"];

/** The fields of the reviews key: the issuer ID is shared with the Sales key. */
const REVIEWS_KEY_FIELDS = ["keyId", "privateKey"] as const;

/** The guide of the Customer Support key. */
export const REVIEWS_KEY_GUIDE = {
  summary: "How to create the Customer Support key",
  steps: [
    "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API.",
    "Under Team Keys, generate a key named “netrics reviews” with the Customer Support role. Developer or Marketing also work but grant more; Sales and Finance cannot read reviews, and netrics refuses Admin keys.",
    "Download the .p8 file right away (Apple offers it only once) and copy the Key ID from the key's row.",
    "Upload it below. netrics checks with Apple that it reads reviews and cannot read sales reports before it stores anything.",
  ],
  links: [
    {
      step: 0,
      label: "Open App Store Connect API keys",
      url: APP_STORE_CONNECT_KEYS_URL,
    },
  ],
} as const;

/** One line per status of the reviews key. */
export function reviewsStatusLabel(
  status: ReviewsStatus,
  keyId: string | null,
): string {
  const key = keyId ? ` (key ${keyId})` : "";
  switch (status) {
    case "not_configured":
      return "Not set up. Ratings and reviews are optional.";
    case "active":
      return `Reading ratings and reviews${key}.`;
    case "paused":
      return `App Store reviews paused — upload a new reviews key${key}.`;
    case "unknown":
      return `Status unknown right now${key}.`;
  }
}

/**
 * The form of the reviews key: the main key's Key ID and Private key
 * fields with copy about the Customer Support key. The issuer ID is not
 * asked again (it is team-wide).
 */
export function reviewsKeyStrategy(
  strategy: SignedKeyStrategy,
): SignedKeyStrategy {
  return {
    ...strategy,
    providerName: "Customer Support",
    fields: strategy.fields
      .filter((field) =>
        (REVIEWS_KEY_FIELDS as readonly string[]).includes(field.key),
      )
      .map((field) =>
        field.key === "keyId"
          ? {
              ...field,
              description:
                "The 10-character Key ID in the row of the Customer Support key.",
            }
          : {
              ...field,
              description:
                "The AuthKey_<Key ID>.p8 file of the Customer Support key. Apple lets you download it only once.",
            },
      ),
  };
}

/** What the PATCH sends: `{ reviews: { keyId, privateKey } }`. */
export function reviewsKeyCredentials(
  strategy: SignedKeyStrategy,
  values: Record<string, string>,
): { reviews: Record<string, string> } {
  return {
    reviews: Object.fromEntries(
      REVIEWS_KEY_FIELDS.map((key) => [
        key,
        normalizeKeyValue(strategy.provider, key, values[key] ?? ""),
      ]),
    ),
  };
}

/** Removing the reviews key: `{ reviews: null }`. */
export const REMOVE_REVIEWS_KEY = { reviews: null } as const;
