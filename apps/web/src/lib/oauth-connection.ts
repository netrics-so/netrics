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
export function unavailableCopy(unavailable: ConnectorUnavailable): {
  summary: string;
  detail: string;
  guideUrl: string | null;
} {
  const name = providerName(unavailable.provider);
  if (unavailable.reason === "signed_key_provider_unsupported") {
    return {
      summary: "Not available on this instance",
      detail: `This netrics server cannot use ${name} keys yet. An administrator has to update netrics.`,
      guideUrl: null,
    };
  }
  if (unavailable.reason === "oauth_provider_unsupported") {
    return {
      summary: "Not available on this instance",
      detail: `This netrics server cannot sign in with ${name}. An administrator has to update netrics.`,
      guideUrl: null,
    };
  }
  const env = `NETRICS_OAUTH_${unavailable.provider.toUpperCase().replace(/-/g, "_")}`;
  return {
    summary: `Needs ${name} sign-in set up by an administrator`,
    detail: `Connecting with ${name} is not set up on this instance yet. An administrator registers a ${name} OAuth app for it and sets ${env}_CLIENT_ID and ${env}_CLIENT_SECRET; then this connector becomes available.`,
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
  provider = "google",
): OutcomeMessage | null {
  const name = providerName(provider);
  switch (outcome) {
    case null:
    case "connected":
      return null;
    case "reauthorized":
      return {
        tone: "notice",
        text: `${name} is reconnected. Syncing resumes right away; the data collected so far is kept.`,
      };
    case "denied":
      return {
        tone: "error",
        text: `You cancelled at ${name}, so nothing was changed. Start again whenever you are ready.`,
      };
    case "invalid_state":
      return {
        tone: "error",
        text: `That ${name} sign-in expired or was already used. Sign-ins are valid for 10 minutes; start again.`,
      };
    case "forbidden":
      return {
        tone: "error",
        text: `This ${name} sign-in was started by a different netrics user, or your role no longer allows it. Nothing was connected.`,
      };
    case "scope_missing":
      return {
        tone: "error",
        text: `netrics needs every permission it asked for. Start again and leave all boxes ticked on ${name}'s consent screen.`,
      };
    case "account_mismatch":
      return {
        tone: "error",
        text: `You signed in with a different ${name} account than the one this connection uses, so nothing was changed. Reconnect with the same account, or choose “Use a different ${name} account”.`,
      };
    case "failed":
      return {
        tone: "error",
        text: `${name} could not complete the connection, and nothing was stored. Try again in a moment.`,
      };
  }
}

/** The banner of a connection in needs_reauthorization. */
export function reauthorizationCopy(
  reason: ConnectionAuthReason | null,
  provider = "google",
): { title: string; detail: string } {
  const name = providerName(provider);
  if (reason === "scope_missing") {
    return {
      title: `Syncing is paused: netrics needs one more ${name} permission.`,
      detail: `This connector now reads data the earlier authorization did not cover. Reconnect ${name} and allow the access it asks for.`,
    };
  }
  return {
    title: `Syncing is paused: the ${name} authorization stopped working.`,
    detail: `Access was removed in the ${name} account, its password changed, or the authorization expired (while an instance's ${name} app is in testing, ${name} ends authorizations after 7 days). Reconnect ${name} to continue; the data collected so far is kept.`,
  };
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
): OutcomeMessage {
  const name = providerName(revocation.provider);
  switch (revocation.status) {
    case "revoked":
      return {
        tone: "notice",
        text: `Disconnected. netrics no longer has access to your ${name} account.`,
      };
    case "kept":
      return {
        tone: "notice",
        text: `Disconnected. ${name} access stays listed in your ${name} account while other netrics connections use it; removing it there would stop those connections too.`,
      };
    case "failed":
      return {
        tone: "error",
        text: `Disconnected, but ${name} did not confirm that access was removed. To be sure, remove netrics from the apps with access to your ${name} account.`,
      };
  }
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

export const DIMENSION_LABELS: Record<SearchConsoleDimension, string> = {
  page: "Page",
  query: "Query",
  country: "Country",
  device: "Device",
};

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

const PERMISSION_LABELS: Record<string, string> = {
  siteOwner: "Owner",
  siteFullUser: "Full user",
  siteRestrictedUser: "Restricted user",
};

export interface PropertyView {
  siteUrl: string;
  /** example.com for a domain property, the URL for a URL-prefix one. */
  name: string;
  kind: "Domain property" | "URL-prefix property";
  permission: string | null;
}

/** A discovered Search Console property, as the picker shows it. */
export function propertyView(resource: DiscoveredResource): PropertyView {
  const domain = resource.id.startsWith("sc-domain:");
  const level = resource.metadata?.permissionLevel;
  return {
    siteUrl: resource.id,
    name: domain ? resource.id.slice("sc-domain:".length) : resource.id,
    kind: domain ? "Domain property" : "URL-prefix property",
    permission:
      typeof level === "string" ? (PERMISSION_LABELS[level] ?? level) : null,
  };
}
