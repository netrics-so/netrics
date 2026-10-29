/**
 * Small rules of the Apple Ads setup and connection page (ADR 0020, #375):
 * the ad accounts a key preview lists, and what a connection's config says
 * about its ad account. Pure, so the wizard, the page and tests share them.
 */

import type { DiscoveredResource } from "@netrics/contracts";

/** The resource kind the Apple Ads preview lists ad accounts as. */
export const AD_ACCOUNT_KIND = "ad_account";
const APPLE_MAPS_FEATURE = "BUSINESS_BRAND_MANUAL";

export interface AppleAdsAccount {
  id: string;
  name: string;
  currency: string | null;
  timeZone: string | null;
  selectable: boolean;
  /** Why it cannot be connected: Apple Maps, no API role, or otherwise. */
  unselectable: "maps" | "role" | "other" | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The ad accounts of a key preview, as the connector discovered them. */
export function appleAdsAccounts(
  resources: readonly DiscoveredResource[],
): AppleAdsAccount[] {
  return resources
    .filter((resource) => resource.kind === AD_ACCOUNT_KIND)
    .map((resource) => {
      const metadata = resource.metadata ?? {};
      const selectable = metadata.selectable === true;
      const features = Array.isArray(metadata.productFeatures)
        ? metadata.productFeatures
        : [];
      // Without an API role the connector cannot read the account's
      // details, so it has no product features.
      const unselectable = selectable
        ? null
        : features.includes(APPLE_MAPS_FEATURE)
          ? "maps"
          : features.length === 0
            ? "role"
            : "other";
      return {
        id: resource.id,
        name: resource.name,
        currency: text(metadata.currency),
        timeZone: text(metadata.timeZone),
        selectable,
        unselectable,
      };
    });
}

export interface AppleAdsConnectionAccount {
  id: string | null;
  name: string | null;
  currency: string | null;
  timeZone: string | null;
}

/** The ad account an Apple Ads connection's config names. */
export function appleAdsConnectionAccount(
  config: Readonly<Record<string, unknown>>,
): AppleAdsConnectionAccount {
  const id =
    typeof config.adAccountId === "number"
      ? String(config.adAccountId)
      : text(config.adAccountId);
  return {
    id,
    name: text(config.adAccountName),
    currency: text(config.currency),
    timeZone: text(config.timeZone),
  };
}

/** "A, B and C" in the user's language, for connection names. */
export function listNames(names: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(names.map((name) => (locale === "de" ? `„${name}“` : `“${name}”`)));
}
