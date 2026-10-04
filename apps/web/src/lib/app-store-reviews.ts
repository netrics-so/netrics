/**
 * Copy and small rules of the "App Store ratings and reviews" card (ADR
 * 0014 decision 2, #190): the optional second key with the Customer
 * Support role, its status line, its form fields and what is sent. Pure,
 * so the card and its tests share them.
 */

import type { AppStoreReviewsStatusResponse } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  APP_STORE_CONNECT_KEYS_URL,
  type KeyGuide,
} from "./app-store-analytics";
import { webTranslator } from "./i18n/catalogs";
import { normalizeKeyValue, type SignedKeyStrategy } from "./signed-key";

export type ReviewsStatus = AppStoreReviewsStatusResponse["status"];

/** The fields of the reviews key: the issuer ID is shared with the Sales key. */
const REVIEWS_KEY_FIELDS = ["keyId", "privateKey"] as const;

/** The guide of the Customer Support key. */
export function reviewsKeyGuide(locale: Locale): KeyGuide {
  const t = webTranslator(locale, "connections.appStoreReviews.guide");
  return {
    summary: t("summary"),
    steps: [t("step1"), t("step2"), t("step3"), t("step4")],
    links: [
      {
        step: 0,
        label: webTranslator(locale, "connections.signedKey")("openKeys"),
        url: APP_STORE_CONNECT_KEYS_URL,
      },
    ],
  };
}

/** One line per status of the reviews key. */
export function reviewsStatusLabel(
  status: ReviewsStatus,
  keyId: string | null,
  locale: Locale,
): string {
  const t = webTranslator(locale, "connections.appStoreReviews.status");
  return t(status, { key: keyId ? t("keySuffix", { keyId }) : "" });
}

/**
 * The form of the reviews key: the main key's Key ID and Private key
 * fields with copy about the Customer Support key. The issuer ID is not
 * asked again (it is team-wide).
 */
export function reviewsKeyStrategy(
  strategy: SignedKeyStrategy,
  locale: Locale,
): SignedKeyStrategy {
  const t = webTranslator(locale, "connections.appStoreReviews.fields");
  return {
    ...strategy,
    providerName: t("providerName"),
    fields: strategy.fields
      .filter((field) =>
        (REVIEWS_KEY_FIELDS as readonly string[]).includes(field.key),
      )
      .map((field) =>
        field.key === "keyId"
          ? {
              ...field,
              description: t("keyId"),
            }
          : {
              ...field,
              description: t("privateKey"),
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
