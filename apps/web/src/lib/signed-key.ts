/**
 * Small rules for signed-key connections (ADR 0014, App Store Connect):
 * the form's format hints, reading the `.p8` file, which field a server
 * message belongs to, and the connection page's copy. Pure, so the wizard,
 * the connection page and their tests share them.
 *
 * The server stays the judge: these checks only catch obvious mistakes
 * before a round trip, and never see more than the user typed or chose.
 */

import type {
  ConnectorAuthStrategy,
  ConnectorCatalogEntry,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/** The App Store Connect connector and its signed-key provider. */
export const APP_STORE_CONNECT_CONNECTOR_ID = "app-store-connect";
export const APP_STORE_CONNECT_PROVIDER = "app-store-connect";

/** Where this repository documents the App Store Connect connector. */
export const APP_STORE_CONNECT_DOCS_URL =
  "https://github.com/netrics-so/netrics/blob/main/docs/connectors/app-store-connect.md";

/** The Apple Ads connector and its signed-key provider (ADR 0020). */
export const APPLE_ADS_CONNECTOR_ID = "apple-ads";
export const APPLE_ADS_PROVIDER = "apple-ads";

/** Where this repository documents the Apple Ads connector. */
export const APPLE_ADS_DOCS_URL =
  "https://github.com/netrics-so/netrics/blob/main/docs/connectors/apple-ads.md";

/**
 * Apple Ads, where Account Settings → User Management and → API are in the
 * account menu. Apple documents no deep links into its UI; TO BE CONFIRMED
 * at the exit gate (#378).
 */
export const APPLE_ADS_URL = "https://ads.apple.com/";
/** Apple's help on inviting users, with the API roles. */
export const APPLE_ADS_INVITE_HELP_URL =
  "https://ads.apple.com/help/advanced/0011-invite-users-to-your-account/";

export type SignedKeyStrategy = ConnectorAuthStrategy & {
  strategy: "signed-key";
  provider: string;
  fields: NonNullable<ConnectorAuthStrategy["fields"]>;
};

export type SignedKeyField = SignedKeyStrategy["fields"][number];

/** The connector's signed-key strategy, when this server can sign for it. */
export function signedKeyStrategyOf(
  connector: Pick<ConnectorCatalogEntry, "authStrategies"> | undefined,
): SignedKeyStrategy | null {
  const strategy = connector?.authStrategies.find(
    (entry) => entry.strategy === "signed-key",
  );
  return strategy?.provider && strategy.fields && strategy.fields.length > 0
    ? (strategy as SignedKeyStrategy)
    : null;
}

const APP_STORE_CONNECT_FIELDS = ["issuerId", "keyId", "privateKey"] as const;

/**
 * The App Store Connect key form in the user's language. The provider's
 * labels, descriptions and setup steps are defined on the server in
 * English; the web app words them from its catalog by field key and step.
 * English, other providers and anything unexpected keep the server's text.
 * Server messages still match the server's labels (fieldOfMessage), so
 * callers match against the strategy they were given.
 */
export function localizeSignedKeyStrategy(
  strategy: SignedKeyStrategy,
  locale: Locale,
): SignedKeyStrategy {
  if (locale !== "en" && strategy.provider === APPLE_ADS_PROVIDER) {
    return localizeAppleAds(strategy, locale);
  }
  if (locale === "en" || strategy.provider !== APP_STORE_CONNECT_PROVIDER) {
    return strategy;
  }
  const t = webTranslator(locale, "connections.signedKey.appStoreConnect");
  // The main key's descriptions; the reviews key brings its own.
  const mainKey = strategy.providerName === "App Store Connect";
  const fields = strategy.fields.map((field) => {
    const key = APP_STORE_CONNECT_FIELDS.find((entry) => entry === field.key);
    if (!key) {
      return field;
    }
    return {
      ...field,
      label: t(`labels.${key}`),
      ...(mainKey ? { description: t(`descriptions.${key}`) } : {}),
    };
  });
  const setup = strategy.setup;
  const steps = [
    t("steps.1"),
    t("steps.2"),
    t("steps.3"),
    t("steps.4"),
    t("steps.5"),
  ];
  return {
    ...strategy,
    fields,
    ...(setup && setup.steps.length === steps.length
      ? {
          setup: {
            ...setup,
            steps,
            links: setup.links?.map((link) =>
              link.step === 0
                ? { ...link, label: t("links.keys") }
                : link.step === 3
                  ? { ...link, label: t("links.payments") }
                  : link,
            ),
          },
        }
      : {}),
  };
}

const APPLE_ADS_FIELDS = ["clientId", "teamId", "keyId", "privateKey"] as const;

/** The Apple Ads key form in German (see localizeSignedKeyStrategy). */
function localizeAppleAds(
  strategy: SignedKeyStrategy,
  locale: Locale,
): SignedKeyStrategy {
  const t = webTranslator(locale, "connections.signedKey.appleAds");
  const fields = strategy.fields.map((field) => {
    const key = APPLE_ADS_FIELDS.find((entry) => entry === field.key);
    return key
      ? {
          ...field,
          label: t(`labels.${key}`),
          description: t(`descriptions.${key}`),
        }
      : field;
  });
  const setup = strategy.setup;
  const steps = [t("steps.1"), t("steps.2"), t("steps.3"), t("steps.4")];
  return {
    ...strategy,
    fields,
    ...(setup && setup.steps.length === steps.length
      ? {
          setup: {
            ...setup,
            steps,
            links: setup.links?.map((link) =>
              link.step === 0
                ? { ...link, label: t("links.invite") }
                : link.step === 1
                  ? { ...link, label: t("links.open") }
                  : link,
            ),
          },
        }
      : {}),
  };
}

/** A field's label in the user's language (see localizeSignedKeyStrategy). */
export function localizedFieldLabel(
  strategy: SignedKeyStrategy,
  field: Pick<SignedKeyField, "key" | "label">,
  locale: Locale,
): string {
  return (
    localizeSignedKeyStrategy(strategy, locale).fields.find(
      (entry) => entry.key === field.key,
    )?.label ?? field.label
  );
}

/** Empty values for every field of the strategy. */
export function emptyKeyValues(
  strategy: SignedKeyStrategy,
): Record<string, string> {
  return Object.fromEntries(strategy.fields.map((field) => [field.key, ""]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{10}$/;

/**
 * What a typed value becomes before it is checked and sent: trimmed, and
 * an App Store Connect key ID upper-cased (Apple shows it upper-case).
 */
export function normalizeKeyValue(
  provider: string,
  key: string,
  value: string,
): string {
  if (provider === APP_STORE_CONNECT_PROVIDER && key === "keyId") {
    return value.trim().toUpperCase();
  }
  return key === "privateKey" ? value : value.trim();
}

/** Apple Ads client ID and team ID: `SEARCHADS.` and an ID (lenient). */
const SEARCHADS_ID = /^SEARCHADS\.[0-9a-z]+(?:-[0-9a-z]+){2,}$/i;
/** An Apple Ads key ID: a UUID-like ID. */
const APPLE_ADS_KEY_ID = /^[0-9a-z]+(?:-[0-9a-z]+){2,}$/i;
const SEARCHADS_PREFIX = "SEARCHADS.";

/**
 * An Apple Ads field's hint (#375). While typing (`partial`), only what
 * can no longer become valid is flagged; once the field is left, the full
 * format. Same rules as the server's provider definition.
 */
function appleAdsHint(
  key: string,
  value: string,
  partial: boolean,
  t: (
    key:
      | "appleAdsClientId"
      | "appleAdsTeamId"
      | "appleAdsKeyId"
      | "appleAdsKeyIdSearchAds",
  ) => string,
): string | null {
  const upper = value.toUpperCase();
  if (key === "clientId" || key === "teamId") {
    const prefixOk =
      upper.startsWith(SEARCHADS_PREFIX) || SEARCHADS_PREFIX.startsWith(upper);
    const restOk = /^[0-9a-z-]*$/i.test(
      value.slice(Math.min(value.length, SEARCHADS_PREFIX.length)),
    );
    if (partial ? prefixOk && restOk : SEARCHADS_ID.test(value)) {
      return null;
    }
    return t(key === "clientId" ? "appleAdsClientId" : "appleAdsTeamId");
  }
  if (key === "keyId") {
    if (upper.startsWith("SEARCHADS")) {
      return t("appleAdsKeyIdSearchAds");
    }
    if (partial ? /^[0-9a-z-]*$/i.test(value) : APPLE_ADS_KEY_ID.test(value)) {
      return null;
    }
    return t("appleAdsKeyId");
  }
  return null;
}

/**
 * The clientId, teamId and keyId in text pasted from Apple Ads' credentials
 * block ("clientId SEARCHADS.…", one per line, or as JSON). Null unless
 * at least two of them are found, so one ID pasted into its field stays as
 * it is. TO BE CONFIRMED at #378: the block's exact layout.
 */
export function appleAdsCredentialsBlock(
  text: string,
): Partial<Record<"clientId" | "teamId" | "keyId", string>> | null {
  const found: Partial<Record<"clientId" | "teamId" | "keyId", string>> = {};
  for (const key of ["clientId", "teamId", "keyId"] as const) {
    const match = new RegExp(
      `["']?${key}["']?\\s*[:=]?\\s*["']?([0-9A-Za-z.-]{6,80})`,
    ).exec(text);
    if (match) {
      found[key] = match[1]!;
    }
  }
  return Object.keys(found).length >= 2 ? found : null;
}

/**
 * A format hint for a text field, or null when it looks right (or is still
 * empty). Same rules as the server's provider definition. `partial`: the
 * user is still typing (Apple Ads checks as you type).
 */
export function keyFieldHint(
  provider: string,
  key: string,
  value: string,
  locale: Locale,
  options: { partial?: boolean } = {},
): string | null {
  const t = webTranslator(locale, "connections.signedKey.hints");
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (provider === APPLE_ADS_PROVIDER) {
    return appleAdsHint(key, trimmed, options.partial ?? false, t);
  }
  if (provider !== APP_STORE_CONNECT_PROVIDER) {
    return null;
  }
  if (key === "issuerId" && !UUID.test(trimmed)) {
    return t("issuerId");
  }
  if (key === "keyId" && !KEY_ID.test(trimmed.toUpperCase())) {
    return t("keyId");
  }
  return null;
}

/** The key ID in Apple's file name `AuthKey_<Key ID>.p8`, if it is one. */
export function keyIdFromFileName(name: string): string | null {
  const match = /^AuthKey_([A-Za-z0-9]{10})(?: \(\d+\))?\.p8$/.exec(
    name.trim(),
  );
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * A hint for the private key's text (from the file or pasted), or null
 * when it looks like a PEM PKCS#8 private key within the size limit.
 */
export function privateKeyHint(
  text: string,
  maxBytes: number,
  locale: Locale,
): string | null {
  if (text.trim() === "") {
    return null;
  }
  const t = webTranslator(locale, "connections.signedKey.hints");
  if (new TextEncoder().encode(text).length > maxBytes) {
    return t("tooLarge", { kib: Math.round(maxBytes / 1024) });
  }
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    return t("certificate");
  }
  if (text.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return t("rsaKey");
  }
  if (text.includes("-----BEGIN PUBLIC KEY-----")) {
    return t("publicKey");
  }
  // PKCS#8 (.p8), or SEC1 as openssl ecparam writes it (ADR 0020 §3).
  if (
    !text.includes("-----BEGIN PRIVATE KEY-----") &&
    !text.includes("-----BEGIN EC PRIVATE KEY-----")
  ) {
    return t("notPem");
  }
  return null;
}

/**
 * Which form field a server message is about, so it can be shown next to
 * the field: a key field when the message starts with its label ("Issuer
 * ID must be a UUID…", "Private key: …"), a config field when it names the
 * field ("…vendor number…"). Null for messages about the key as a whole
 * (wrong combination, role, agreements, rate limit).
 */
export function fieldOfMessage(
  message: string,
  keyFields: readonly Pick<SignedKeyField, "key" | "label">[],
  configFields: readonly { key: string; label: string }[] = [],
): string | null {
  const keyField = keyFields.find((field) =>
    message.toLowerCase().startsWith(field.label.toLowerCase()),
  );
  if (keyField) {
    return keyField.key;
  }
  const lower = message.toLowerCase();
  const configField = configFields.find((field) =>
    lower.includes(field.label.toLowerCase()),
  );
  return configField?.key ?? null;
}

/** Whether the strategy's form is complete enough to send. */
export function missingKeyField(
  strategy: SignedKeyStrategy,
  values: Record<string, string>,
): SignedKeyField | null {
  return (
    strategy.fields.find((field) => (values[field.key] ?? "").trim() === "") ??
    null
  );
}

/** The provider's private key field. */
export function privateKeyField(
  strategy: SignedKeyStrategy,
): SignedKeyField | undefined {
  return strategy.fields.find((field) => field.input === "file");
}

/**
 * The first required field that is still empty. With a generated key pair
 * (ADR 0020 §3) the private key stays on the server and is not asked for.
 */
export function missingKeyFieldWith(
  strategy: SignedKeyStrategy,
  values: Record<string, string>,
  generated: boolean,
): SignedKeyField | null {
  const privateKey = generated ? privateKeyField(strategy) : undefined;
  return missingKeyField(
    {
      ...strategy,
      fields: strategy.fields.filter((field) => field !== privateKey),
    },
    values,
  );
}

/**
 * What a key form sends: every field normalized, or, with a key pair
 * netrics generated, the fields without the private key and the pending
 * key's id.
 */
export function keyPayload(
  strategy: SignedKeyStrategy,
  values: Record<string, string>,
  pendingKeyId: string | null,
): { credentials: Record<string, string>; pendingKeyId?: string } {
  const credentials = keyCredentials(strategy, values);
  if (pendingKeyId === null) {
    return { credentials };
  }
  const privateKey = privateKeyField(strategy);
  if (privateKey) {
    delete credentials[privateKey.key];
  }
  return { credentials, pendingKeyId };
}

/** The credentials to send: every field, normalized. */
export function keyCredentials(
  strategy: SignedKeyStrategy,
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    strategy.fields.map((field) => [
      field.key,
      normalizeKeyValue(strategy.provider, field.key, values[field.key] ?? ""),
    ]),
  );
}

/**
 * The newest reporting day among a connection's report observations, as
 * YYYY-MM-DD, or null without any. App Store reporting days are days in
 * Pacific Time, stored as that day's date.
 */
export function latestReportingDay(
  observations: readonly { sourceTimestamp: string; metricKey?: string }[],
): string | null {
  let latest: string | null = null;
  for (const observation of observations) {
    // Review metrics (#190) run through today and say nothing about when
    // Apple's reports arrived.
    if (/^app_store_connect\.review/.test(observation.metricKey ?? "")) {
      continue;
    }
    const day = observation.sourceTimestamp.slice(0, 10);
    if (latest === null || day > latest) {
      latest = day;
    }
  }
  return latest;
}

/** The query the workspace page reads after a signed-key connection is deleted. */
export function keyRemovedQuery(provider: string, shared = false): string {
  return new URLSearchParams({
    keyRemoved: provider,
    ...(shared ? { keyShared: "1" } : {}),
  }).toString();
}

/** The provider of a deleted signed-key connection, from the query. */
export function parseKeyRemoved(query: {
  keyRemoved?: string | string[];
}): string | null {
  const provider = query.keyRemoved;
  return typeof provider === "string" && /^[a-z0-9-]{1,40}$/.test(provider)
    ? provider
    : null;
}
