/**
 * Copy and small rules for connections authorized at a provider (ADR 0012):
 * the outcome messages after an OAuth callback, the reconnect banner, the
 * disconnect result, and the Search Console setup choices. Pure, so the
 * pages and their tests share one wording.
 */

import type {
  ConnectionAuthReason,
  ConnectionRevocation,
  ConnectorCatalogEntry,
  ConnectorUnavailable,
  DiscoveredResource,
  OAuthCallbackOutcome,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/** Where self-hosters learn to register a Google OAuth app. */
export const GOOGLE_OAUTH_SETUP_GUIDE =
  "https://github.com/netrics-so/netrics/blob/main/deploy/compose/google-oauth.md";

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  "app-store-connect": "App Store Connect",
};

/** "Google" for "google"; unknown providers keep their id, capitalized. */
export function providerName(provider: string): string {
  return (
    PROVIDER_NAMES[provider] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/** The connector's OAuth provider, if it connects through one. */
export function oauthProviderOf(
  connector: Pick<ConnectorCatalogEntry, "authStrategies">,
): string | null {
  const strategy = connector.authStrategies.find(
    (entry) => entry.strategy === "oauth2" && entry.provider,
  );
  return strategy?.provider ?? null;
}

/**
 * Why a connector cannot be connected here, for the marketplace card. Only
 * an administrator can change it; the guide link is for self-hosters.
 */
export function unavailableCopy(
  unavailable: ConnectorUnavailable,
  locale: Locale,
): {
  summary: string;
  detail: string;
  guideUrl: string | null;
} {
  const t = webTranslator(locale, "connections.oauth.unavailable");
  const name = providerName(unavailable.provider);
  if (unavailable.reason === "signed_key_provider_unsupported") {
    return {
      summary: t("summary"),
      detail: t("signedKeyUnsupported", { name }),
      guideUrl: null,
    };
  }
  if (unavailable.reason === "oauth_provider_unsupported") {
    return {
      summary: t("summary"),
      detail: t("oauthUnsupported", { name }),
      guideUrl: null,
    };
  }
  const env = `NETRICS_OAUTH_${unavailable.provider.toUpperCase().replace(/-/g, "_")}`;
  return {
    summary: t("notConfiguredSummary", { name }),
    detail: t("notConfiguredDetail", { name, env }),
    guideUrl:
      unavailable.provider === "google" ? GOOGLE_OAUTH_SETUP_GUIDE : null,
  };
}

export interface OutcomeMessage {
  tone: "notice" | "error";
  text: string;
}

const OUTCOMES = new Set<string>([
  "connected",
  "reauthorized",
  "denied",
  "invalid_state",
  "forbidden",
  "scope_missing",
  "account_mismatch",
  "failed",
]);

/** The `oauth` query value of a return path, if it is an outcome. */
export function parseOAuthOutcome(
  value: string | string[] | undefined,
): OAuthCallbackOutcome | null {
  const single = Array.isArray(value) ? value[0] : value;
  return single !== undefined && OUTCOMES.has(single)
    ? (single as OAuthCallbackOutcome)
    : null;
}

/**
 * What the user reads after coming back from the provider. "connected" has
 * no message: the finish-setup screen follows instead.
 */
export function oauthOutcomeMessage(
  outcome: OAuthCallbackOutcome | null,
  locale: Locale,
  provider = "google",
): OutcomeMessage | null {
  if (outcome === null || outcome === "connected") {
    return null;
  }
  const t = webTranslator(locale, "connections.oauth.outcome");
  return {
    tone: outcome === "reauthorized" ? "notice" : "error",
    text: t(outcome, { name: providerName(provider) }),
  };
}

/** The banner of a connection in needs_reauthorization. */
export function reauthorizationCopy(
  reason: ConnectionAuthReason | null,
  locale: Locale,
  provider = "google",
): { title: string; detail: string } {
  const t = webTranslator(locale, "connections.oauth.reauthorize");
  const name = providerName(provider);
  if (reason === "scope_missing") {
    return {
      title: t("scopeTitle", { name }),
      detail: t("scopeDetail", { name }),
    };
  }
  return { title: t("title", { name }), detail: t("detail", { name }) };
}

/**
 * Where users review the access they granted, per provider. The workspace
 * page links here after a disconnect; it never takes a URL from the query.
 */
const ACCOUNT_PERMISSIONS_URLS: Record<string, string> = {
  google: "https://myaccount.google.com/permissions",
};

/** The disconnect outcome carried to the workspace page in its query. */
export function disconnectQuery(revocation: ConnectionRevocation): string {
  return new URLSearchParams({
    disconnected: revocation.status,
    provider: revocation.provider,
  }).toString();
}

/** The disconnect outcome from the workspace page's query, if any. */
export function parseDisconnected(query: {
  disconnected?: string | string[];
  provider?: string | string[];
}): ConnectionRevocation | null {
  const status = query.disconnected;
  const provider = query.provider;
  if (
    (status !== "revoked" && status !== "kept" && status !== "failed") ||
    typeof provider !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(provider)
  ) {
    return null;
  }
  return {
    provider,
    status,
    accountPermissionsUrl: ACCOUNT_PERMISSIONS_URLS[provider] ?? null,
  };
}

/** What the disconnect did with the access at the provider. */
export function revocationMessage(
  revocation: ConnectionRevocation,
  locale: Locale,
): OutcomeMessage {
  const t = webTranslator(locale, "connections.oauth.revocation");
  return {
    tone: revocation.status === "failed" ? "error" : "notice",
    text: t(revocation.status, { name: providerName(revocation.provider) }),
  };
}

// ─── Google Search Console setup ───────────────────────────────────────────

export const SEARCH_CONSOLE_CONNECTOR_ID = "google-search-console";
/** Breakdown dimensions in the connector's order (its enum lists pairs so). */
export const SEARCH_CONSOLE_DIMENSIONS = [
  "page",
  "query",
  "country",
  "device",
] as const;
export type SearchConsoleDimension = (typeof SEARCH_CONSOLE_DIMENSIONS)[number];
export const MAX_BREAKDOWN_DIMENSIONS = 2;
export const DEFAULT_ROW_LIMIT = 1_000;
export const MAX_ROW_LIMIT = 5_000;

/** "Page", "Query", … in the user's language. */
export function dimensionLabel(
  dimension: SearchConsoleDimension,
  locale: Locale,
): string {
  return webTranslator(
    locale,
    "connections.searchConsole.dimensions",
  )(dimension);
}

/** The config value for a set of dimensions: "none", "query", "page,query". */
export function toDimensionsValue(
  selected: Iterable<SearchConsoleDimension>,
): string {
  const chosen = new Set(selected);
  const ordered = SEARCH_CONSOLE_DIMENSIONS.filter((dimension) =>
    chosen.has(dimension),
  );
  return ordered.length === 0 ? "none" : ordered.join(",");
}

/** The dimensions of a stored config value; unknown entries are dropped. */
export function fromDimensionsValue(value: unknown): SearchConsoleDimension[] {
  if (typeof value !== "string") {
    return [];
  }
  const parts = value.split(",").map((part) => part.trim());
  return SEARCH_CONSOLE_DIMENSIONS.filter((dimension) =>
    parts.includes(dimension),
  );
}

/** A whole number of rows per day within the connector's limits, or null. */
export function parseRowLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  return value >= 1 && value <= MAX_ROW_LIMIT ? value : null;
}

export interface PropertyView {
  siteUrl: string;
  /** example.com for a domain property, the URL for a URL-prefix one. */
  name: string;
  /** "Domain property" or "URL-prefix property", in words. */
  kind: string;
  permission: string | null;
}

/** A discovered Search Console property, as the picker shows it. */
export function propertyView(
  resource: DiscoveredResource,
  locale: Locale,
): PropertyView {
  const t = webTranslator(locale, "connections.searchConsole");
  const domain = resource.id.startsWith("sc-domain:");
  const level = resource.metadata?.permissionLevel;
  const permissionKey = `permissions.${String(level)}`;
  return {
    siteUrl: resource.id,
    name: domain ? resource.id.slice("sc-domain:".length) : resource.id,
    kind: t(domain ? "domainProperty" : "urlPrefixProperty"),
    permission:
      typeof level === "string"
        ? t.has(permissionKey)
          ? t(permissionKey)
          : level
        : null,
  };
}
