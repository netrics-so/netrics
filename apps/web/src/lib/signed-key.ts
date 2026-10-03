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

/** The App Store Connect connector and its signed-key provider. */
export const APP_STORE_CONNECT_CONNECTOR_ID = "app-store-connect";
export const APP_STORE_CONNECT_PROVIDER = "app-store-connect";

/** Where this repository documents the App Store Connect connector. */
export const APP_STORE_CONNECT_DOCS_URL =
  "https://github.com/netrics-so/netrics/blob/main/docs/connectors/app-store-connect.md";

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

/**
 * A format hint for a text field, or null when it looks right (or is still
 * empty). Same rules as the server's provider definition.
 */
export function keyFieldHint(
  provider: string,
  key: string,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || provider !== APP_STORE_CONNECT_PROVIDER) {
    return null;
  }
  if (key === "issuerId" && !UUID.test(trimmed)) {
    return "The issuer ID is a UUID with dashes, like 57246542-96fe-1a63-e053-0824d011072a. It is shown above the list of team keys.";
  }
  if (key === "keyId" && !KEY_ID.test(trimmed.toUpperCase())) {
    return "The key ID has 10 letters and digits, like 2X9R4HXF34. It is in the key's row, and in the file name AuthKey_<Key ID>.p8.";
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
export function privateKeyHint(text: string, maxBytes: number): string | null {
  if (text.trim() === "") {
    return null;
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return `This is larger than ${Math.round(maxBytes / 1024)} KiB, so it is not an API key. Choose the AuthKey_<Key ID>.p8 file.`;
  }
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    return "This is a certificate, not a private key. Choose the AuthKey_<Key ID>.p8 file you downloaded with the API key.";
  }
  if (text.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return "This is an RSA private key. The API key is an EC key in the AuthKey_<Key ID>.p8 file.";
  }
  if (text.includes("-----BEGIN PUBLIC KEY-----")) {
    return "This is a public key. Choose the AuthKey_<Key ID>.p8 file, which holds the private key.";
  }
  if (!text.includes("-----BEGIN PRIVATE KEY-----")) {
    return "This does not look like a .p8 private key: it should start with -----BEGIN PRIVATE KEY-----.";
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
export function keyRemovedQuery(provider: string): string {
  return new URLSearchParams({ keyRemoved: provider }).toString();
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
