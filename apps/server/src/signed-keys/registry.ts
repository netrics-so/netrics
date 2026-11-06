import { createHash, createPublicKey, type KeyObject } from "node:crypto";

import {
  createEgressFetch,
  redactCredentialValues,
} from "@netrics/connector-runtime";
import type {
  ConnectorFetchInit,
  ConnectorManifest,
  ConnectorResponse,
  SignedKeyAuthStrategy,
} from "@netrics/connector-sdk";

import {
  parseP256PrivateKey,
  SignedKeyFormatError,
  signEs256Jwt,
} from "./keys.js";
import {
  SIGNED_KEY_PROVIDER_DEFINITIONS,
  type SignedKeyField,
  type SignedKeyFieldValues,
  type SignedKeyProbe,
  type SignedKeyProviderDefinition,
} from "./providers/index.js";

// The host's signed-key providers (ADR 0014): credential validation before
// persistence, per-call token signing, and the probe hook. The private key
// stays in this module's objects; connectors receive `{ accessToken }`.
// Providers with a token exchange (ADR 0020 §2) sign a short-lived client
// secret per exchange instead and hand connectors the exchanged token,
// cached per connection by the token store (token-store.ts).

/** One HTTP call of a validation probe. */
export type SignedKeyHttp = (
  url: string,
  init?: ConnectorFetchInit,
) => Promise<ConnectorResponse>;

/** The HTTP client for one provider's probes. */
export type SignedKeyHttpFactory = (
  provider: SignedKeyProviderDefinition,
) => SignedKeyHttp;

const PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

/**
 * Probe calls go through the same guarded fetch as connector code (https
 * only, public addresses, no redirects), limited to the provider's server
 * domains, with a short timeout.
 */
export const signedKeyProviderHttp: SignedKeyHttpFactory =
  (provider) => (url, init) =>
    createEgressFetch({
      allowedDomains: provider.serverDomains,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      maxResponseBytes: MAX_PROBE_RESPONSE_BYTES,
      maxRedirects: 0,
    })(url, init ?? {});

/**
 * A token exchange that did not yield a token. `rejected`: the provider
 * refused the client (`invalid_client`: key removed, or the IDs do not
 * match the key), the connection is auth_failed and the message is the
 * provider's fixed text. `transient`: network, timeout, 429 or 5xx; a
 * retry may help. `configuration`: any other refusal (our request is
 * wrong). Messages carry the status and the OAuth error code only: never
 * the client secret, a token or the response body.
 */
export class SignedKeyExchangeError extends Error {
  readonly kind: "rejected" | "transient" | "configuration";

  constructor(
    kind: "rejected" | "transient" | "configuration",
    message: string,
  ) {
    super(message);
    this.name = "SignedKeyExchangeError";
    this.kind = kind;
  }
}

/** An access token from one exchange, with its lifetime. */
export interface ExchangedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Where a connection's exchanged access token is cached (token-store.ts):
 * reused while valid for long enough, otherwise exchanged once under a
 * per-connection lock.
 */
export interface SignedKeyTokenCache {
  /**
   * A valid access token for the key. `cached` is false only when this
   * call exchanged it.
   */
  get(key: SignedKey): Promise<{ accessToken: string; cached: boolean }>;
  /** Drops a token the provider refused, if it is still the stored one. */
  invalidate(rejectedAccessToken: string): Promise<void>;
}

/** The credentials of one connector call and where the main token came from. */
export interface AcquiredSignedKeyTokens {
  credentials: { accessToken: string } & Record<string, string>;
  /** True when the access token came from the cache, not a fresh signature or exchange. */
  cached: boolean;
}

/** The OAuth `error` code of a token response, or a placeholder. */
function oauthErrorCode(body: unknown): string {
  const code =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
    ? code
    : "unknown_error";
}

/** Codes that mean the key or its IDs are not (or no longer) accepted. */
const REJECTED_CLIENT_CODES = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_grant",
]);

/**
 * Validated credentials of one provider. The key object and the PEM never
 * leave this class except through `stored()` (for the envelope) and signed
 * tokens. JSON serialization and inspection show no key material.
 *
 * Optional additional keys (#190, e.g. App Store Connect's reviews key)
 * are SignedKeys of their own, with the main key's shared fields merged in
 * (the issuer ID), held under their id.
 */
export class SignedKey {
  readonly #provider: SignedKeyProviderDefinition;
  readonly #values: SignedKeyFieldValues;
  readonly #key: KeyObject;
  readonly #now: () => number;
  readonly #additional: ReadonlyMap<string, SignedKey>;
  /** For an additional key: its own field keys (stored under its id). */
  readonly #ownFields: readonly string[] | undefined;
  /** Guarded HTTP to the provider's server domains, for the exchange. */
  readonly #http: SignedKeyHttp | undefined;
  #fingerprint: string | undefined;

  constructor(
    provider: SignedKeyProviderDefinition,
    values: SignedKeyFieldValues,
    key: KeyObject,
    now: () => number,
    options: {
      additional?: ReadonlyMap<string, SignedKey>;
      ownFields?: readonly string[];
      http?: SignedKeyHttp;
    } = {},
  ) {
    this.#provider = provider;
    this.#values = values;
    this.#key = key;
    this.#now = now;
    this.#additional = options.additional ?? new Map();
    this.#ownFields = options.ownFields;
    this.#http = options.http;
  }

  /** Whether connectors get an exchanged token rather than the signed JWT. */
  get exchanges(): boolean {
    return this.#provider.exchange !== undefined;
  }

  /**
   * A non-secret digest of the key pair's public key and the public fields
   * (client ID, key ID). A cached token is used only with the key it was
   * exchanged for.
   */
  get fingerprint(): string {
    this.#fingerprint ??= createHash("sha256")
      .update(
        createPublicKey(this.#key).export({ format: "der", type: "spki" }),
      )
      .update(JSON.stringify(this.publicFields))
      .digest("base64url");
    return this.#fingerprint;
  }

  get provider(): SignedKeyProviderDefinition {
    return this.#provider;
  }

  /** The non-secret fields (e.g. issuer ID and key ID). */
  get publicFields(): SignedKeyFieldValues {
    return Object.fromEntries(
      this.#provider.fields
        .filter((field) => !field.secret)
        .flatMap((field) => {
          const value = this.#values[field.key];
          return value === undefined ? [] : [[field.key, value]];
        }),
    );
  }

  /** An additional key by id (e.g. "reviews"), if the credentials hold one. */
  additional(id: string): SignedKey | undefined {
    return this.#additional.get(id);
  }

  /** The ids of the additional keys held. */
  get additionalIds(): string[] {
    return [...this.#additional.keys()];
  }

  /**
   * The same main key with an additional key set (a SignedKey from
   * `SignedKeyProviders.parseAdditional`) or removed (null).
   */
  withAdditional(id: string, key: SignedKey | null): SignedKey {
    const additional = new Map(this.#additional);
    if (key) {
      additional.set(id, key);
    } else {
      additional.delete(id);
    }
    return new SignedKey(this.#provider, this.#values, this.#key, this.#now, {
      additional,
      ...(this.#http ? { http: this.#http } : {}),
    });
  }

  /**
   * What the credentials envelope stores: every field, normalized, and each
   * additional key's own fields under its id.
   */
  stored(): Record<string, unknown> {
    if (this.#ownFields) {
      return Object.fromEntries(
        this.#ownFields.map((field) => [field, this.#values[field]]),
      );
    }
    const stored: Record<string, unknown> = { ...this.#values };
    for (const [id, key] of this.#additional) {
      stored[id] = key.stored();
    }
    return stored;
  }

  /**
   * A freshly signed token: never cached, never stored, never enqueued.
   * With a token exchange this is the client secret, which only the
   * exchange sends.
   */
  mintToken(): string {
    const nowSeconds = Math.floor(this.#now() / 1000);
    const { kid, claims } = this.#provider.token(this.#values);
    const { issuedBeforeSeconds, expiresInSeconds } = this.#provider.lifetime;
    return signEs256Jwt(this.#key, kid, {
      ...claims,
      iat: nowSeconds - issuedBeforeSeconds,
      exp: nowSeconds + expiresInSeconds,
    });
  }

  /**
   * The credentials a connector call receives: a fresh token of the main
   * key as `accessToken`, and one per additional key in its token field.
   */
  mintTokens(): { accessToken: string } & Record<string, string> {
    if (this.exchanges) {
      // The signed JWT is a client secret here; it never reaches a
      // connector. Callers use acquireTokens().
      throw new Error(
        `${this.#provider.id} exchanges its signed key for a token; use acquireTokens()`,
      );
    }
    return this.#withAdditionalTokens(this.mintToken());
  }

  #withAdditionalTokens(
    accessToken: string,
  ): { accessToken: string } & Record<string, string> {
    const tokens: { accessToken: string } & Record<string, string> = {
      accessToken,
    };
    for (const definition of this.#provider.additionalKeys ?? []) {
      const key = this.#additional.get(definition.id);
      if (key) {
        tokens[definition.tokenField] = key.mintToken();
      }
    }
    return tokens;
  }

  /**
   * The credentials of one connector call. Without a token exchange: a
   * freshly signed token, as mintTokens(). With one: the connection's
   * cached token from `cache` (exchanged when missing or about to expire),
   * or, without a cache (candidate keys in probes and previews), a token
   * from a fresh exchange that is not stored anywhere.
   */
  async acquireTokens(
    cache?: SignedKeyTokenCache,
  ): Promise<AcquiredSignedKeyTokens> {
    if (!this.exchanges) {
      return { credentials: this.mintTokens(), cached: false };
    }
    if (cache) {
      const token = await cache.get(this);
      return {
        credentials: this.#withAdditionalTokens(token.accessToken),
        cached: token.cached,
      };
    }
    const exchanged = await this.exchangeAccessToken();
    return {
      credentials: this.#withAdditionalTokens(exchanged.accessToken),
      cached: false,
    };
  }

  /**
   * One token exchange (ADR 0020 §2): a client secret signed for this
   * request only (the provider's lifetime, e.g. iat now − 60 s, exp now +
   * 10 min) is posted with the provider's form to its token endpoint. The
   * secret is never stored. Throws SignedKeyExchangeError; its message
   * names the status and OAuth error code only.
   */
  async exchangeAccessToken(): Promise<ExchangedAccessToken> {
    const exchange = this.#provider.exchange;
    if (!exchange || !this.#http) {
      throw new SignedKeyExchangeError(
        "configuration",
        `${this.#provider.id} has no token exchange`,
      );
    }
    const body = new URLSearchParams({
      ...exchange.form(this.#values),
      client_secret: this.mintToken(),
    }).toString();
    let response: ConnectorResponse;
    try {
      response = await this.#http(exchange.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
    } catch (error) {
      // Network failures, timeouts and egress denials: keep only the name.
      const name = error instanceof Error ? error.name : "Error";
      throw new SignedKeyExchangeError(
        "transient",
        `${this.#provider.name} token exchange failed: ${name}`,
      );
    }
    let parsedBody: unknown;
    try {
      parsedBody = response.json();
    } catch {
      parsedBody = undefined;
    }
    if (response.status === 200) {
      const parsed = exchange.response.safeParse(parsedBody);
      if (!parsed.success || !parsed.data.access_token) {
        throw new SignedKeyExchangeError(
          "transient",
          `${this.#provider.name} token exchange failed: malformed token response`,
        );
      }
      return {
        accessToken: parsed.data.access_token,
        expiresInSeconds: parsed.data.expires_in,
      };
    }
    const code = oauthErrorCode(parsedBody);
    if (response.status === 429 || response.status >= 500) {
      throw new SignedKeyExchangeError(
        "transient",
        `${this.#provider.name} token exchange failed: provider answered ${response.status} (${code})`,
      );
    }
    if (REJECTED_CLIENT_CODES.has(code)) {
      throw new SignedKeyExchangeError("rejected", exchange.invalidClient);
    }
    throw new SignedKeyExchangeError(
      "configuration",
      `${this.#provider.name} token exchange failed: provider answered ${response.status} (${code})`,
    );
  }

  toJSON(): string {
    return "[signed key]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SignedKey(${this.#provider.id})`;
  }
}

export type SignedKeyResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

/** The signed-key providers of this server. */
export class SignedKeyProviders {
  readonly #definitions: ReadonlyMap<string, SignedKeyProviderDefinition>;
  readonly #http: SignedKeyHttpFactory;
  readonly #now: () => number;

  constructor(
    options: {
      definitions?: ReadonlyMap<string, SignedKeyProviderDefinition>;
      /** Default: guarded fetch to each provider's server domains. */
      http?: SignedKeyHttpFactory;
      /** Clock for token iat/exp (ms since epoch); tests pin it. */
      now?: () => number;
    } = {},
  ) {
    this.#definitions = options.definitions ?? SIGNED_KEY_PROVIDER_DEFINITIONS;
    this.#http = options.http ?? signedKeyProviderHttp;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Host-side HTTP to the provider's server domains (guarded egress, short
   * timeout), for provider steps outside connector calls such as enabling
   * App Store analytics (#174).
   */
  httpFor(provider: SignedKeyProviderDefinition): SignedKeyHttp {
    return this.#http(provider);
  }

  has(providerId: string): boolean {
    return this.#definitions.has(providerId);
  }

  get(providerId: string): SignedKeyProviderDefinition | undefined {
    return this.#definitions.get(providerId);
  }

  /**
   * The signed-key strategy a credentials-based connection of this
   * connector uses, or undefined when it uses its token (or none)
   * strategy. Only providers of this server count. A connector that also
   * offers a token strategy uses the signed key when the credentials carry
   * any of the provider's fields, so a key is never handed to a connector
   * as if it were a token.
   */
  providerFor(
    manifest: ConnectorManifest,
    credentials: Record<string, unknown> | undefined,
  ): SignedKeyProviderDefinition | undefined {
    const provider = manifest.authStrategies
      .filter(
        (strategy): strategy is SignedKeyAuthStrategy =>
          strategy.strategy === "signed-key",
      )
      .map((strategy) => this.#definitions.get(strategy.provider))
      .find((definition) => definition !== undefined);
    if (!provider) {
      return undefined;
    }
    const credentialAlternative = manifest.authStrategies.some(
      (strategy) =>
        strategy.strategy === "token" || strategy.strategy === "none",
    );
    if (!credentialAlternative) {
      return provider;
    }
    const keys = Object.keys(credentials ?? {});
    return provider.fields.some((field) => keys.includes(field.key))
      ? provider
      : undefined;
  }

  /**
   * Field and key checks, before anything else (no network): every field
   * present, within its size, in its format; the private key a PEM PKCS#8
   * EC P-256 key. Unknown fields are refused. Messages name the field and
   * never quote a value. An additional key (#190) may come as an object
   * under its id; it is checked the same way (`null` or absent: none).
   */
  parse(
    provider: SignedKeyProviderDefinition,
    credentials: Record<string, unknown> | undefined,
  ): SignedKeyResult<SignedKey> {
    const input = credentials ?? {};
    const additionalKeys = provider.additionalKeys ?? [];
    const known = new Set([
      ...provider.fields.map((field) => field.key),
      ...additionalKeys.map((key) => key.id),
    ]);
    const unknown = Object.keys(input).find((key) => !known.has(key));
    if (unknown !== undefined) {
      return {
        ok: false,
        message: `${provider.name} credentials take ${provider.fields
          .map((field) => field.label)
          .join(", ")}; remove the unknown field "${unknown.slice(0, 40)}".`,
      };
    }
    const main = this.#parseFields(provider, provider.fields, input);
    if (!main.ok) {
      return main;
    }
    let key = new SignedKey(
      provider,
      main.value.values,
      main.value.key,
      this.#now,
      provider.exchange ? { http: this.#http(provider) } : {},
    );
    for (const definition of additionalKeys) {
      const raw = input[definition.id];
      if (raw === undefined || raw === null) {
        continue;
      }
      const additional = this.parseAdditional(key, definition.id, raw);
      if (!additional.ok) {
        return additional;
      }
      key = key.withAdditional(definition.id, additional.value);
    }
    return { ok: true, value: key };
  }

  /**
   * One additional key's fields for the main key `main` (format and key
   * checks, no network). It must be a different key than the main one.
   */
  parseAdditional(
    main: SignedKey,
    id: string,
    raw: unknown,
  ): SignedKeyResult<SignedKey> {
    const provider = main.provider;
    const definition = provider.additionalKeys?.find((key) => key.id === id);
    if (!definition) {
      return {
        ok: false,
        message: `${provider.name} has no "${id.slice(0, 40)}" key.`,
      };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        message: `The ${definition.name} takes ${definition.fields
          .map((field) => field.label)
          .join(", ")}.`,
      };
    }
    const input = raw as Record<string, unknown>;
    const own = new Set(definition.fields.map((field) => field.key));
    const unknown = Object.keys(input).find((key) => !own.has(key));
    if (unknown !== undefined) {
      return {
        ok: false,
        message: `The ${definition.name} takes ${definition.fields
          .map((field) => field.label)
          .join(", ")}; remove the unknown field "${unknown.slice(0, 40)}".`,
      };
    }
    const parsed = this.#parseFields(provider, definition.fields, input);
    if (!parsed.ok) {
      return parsed;
    }
    const mainValues = main.stored();
    const sameKey = definition.fields.some(
      (field) =>
        !field.secret &&
        field.key in mainValues &&
        mainValues[field.key] === parsed.value.values[field.key],
    );
    if (sameKey) {
      return {
        ok: false,
        message: `The ${definition.name} must be a separate key, not the key the connection already uses. Create a new team key for it.`,
      };
    }
    // Shared fields (the issuer ID) come from the main key.
    const shared = Object.fromEntries(
      provider.fields
        .filter((field) => !own.has(field.key) && !field.secret)
        .map((field) => [field.key, mainValues[field.key] as string]),
    );
    return {
      ok: true,
      value: new SignedKey(
        provider,
        { ...shared, ...parsed.value.values },
        parsed.value.key,
        this.#now,
        { ownFields: definition.fields.map((field) => field.key) },
      ),
    };
  }

  #parseFields(
    provider: SignedKeyProviderDefinition,
    fields: readonly SignedKeyField[],
    input: Record<string, unknown>,
  ): SignedKeyResult<{ values: Record<string, string>; key: KeyObject }> {
    const values: Record<string, string> = {};
    let key: KeyObject | undefined;
    for (const field of fields) {
      const raw = input[field.key];
      if (typeof raw !== "string" || raw.trim() === "") {
        return { ok: false, message: `${field.label} is required.` };
      }
      if (Buffer.byteLength(raw, "utf8") > field.maxBytes) {
        return {
          ok: false,
          message: field.privateKey
            ? `${field.label} is larger than ${field.maxBytes / 1024} KiB. Upload the .p8 file of the API key.`
            : `${field.label} is longer than ${field.maxBytes} bytes.`,
        };
      }
      const value = raw.trim();
      if (field.privateKey) {
        try {
          const parsed = parseP256PrivateKey(value);
          key = parsed.key;
          values[field.key] = parsed.pem;
        } catch (error) {
          return {
            ok: false,
            message: `${field.label}: ${
              error instanceof SignedKeyFormatError
                ? error.message
                : "the key could not be read."
            }`,
          };
        }
        continue;
      }
      const invalid = field.validate?.(value) ?? null;
      if (invalid !== null) {
        return { ok: false, message: invalid };
      }
      values[field.key] = value;
    }
    if (!key) {
      // A definition without a private key field is a programming error.
      return { ok: false, message: `${provider.name} defines no private key.` };
    }
    return { ok: true, value: { values, key } };
  }

  /**
   * The provider's probes with the candidate key and config, in order; the
   * first failure answers. Messages are redacted of every credential value
   * and every token minted for the probes.
   */
  async probe(
    key: SignedKey,
    config: Record<string, unknown>,
    probes: readonly SignedKeyProbe[] = key.provider.probes,
  ): Promise<SignedKeyResult<true>> {
    const provider = key.provider;
    const tokens: string[] = [];
    const http = this.#http(provider);
    const redact = (message: string) =>
      redactCredentialValues(redactCredentialValues(message, key.stored()), {
        tokens,
      }).slice(0, 500);
    // With a token exchange the probes share one exchanged token, which is
    // never cached: the key is a candidate until it is stored.
    let exchanged: string | undefined;
    if (key.exchanges && probes.length > 0) {
      try {
        exchanged = (await key.exchangeAccessToken()).accessToken;
        tokens.push(exchanged);
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof SignedKeyExchangeError && error.kind === "rejected"
              ? error.message
              : `${provider.name} could not be reached to check the key. Try again in a few minutes.`,
        };
      }
    }
    for (const probe of probes) {
      let result;
      try {
        result = await probe.run({
          config,
          fields: key.publicFields,
          accessToken: () => {
            if (exchanged !== undefined) {
              return exchanged;
            }
            const token = key.mintToken();
            tokens.push(token);
            return token;
          },
          fetch: (url, init) => http(url, init),
        });
      } catch {
        return {
          ok: false,
          message: `${provider.name} could not be reached to check the key. Try again in a few minutes.`,
        };
      }
      if (!result.ok) {
        return { ok: false, message: redact(result.message) };
      }
    }
    return { ok: true, value: true };
  }

  /**
   * The probes of an additional key (#190) held by `key`: with its own
   * freshly signed tokens, redacted of its values.
   */
  async probeAdditional(
    key: SignedKey,
    id: string,
    config: Record<string, unknown>,
  ): Promise<SignedKeyResult<true>> {
    const definition = key.provider.additionalKeys?.find(
      (entry) => entry.id === id,
    );
    const additional = key.additional(id);
    if (!definition || !additional) {
      return { ok: true, value: true };
    }
    return this.probe(additional, config, definition.probes);
  }

  /**
   * parse, then probe: the whole validation before anything is stored.
   * Additional keys in the credentials are probed too, unless
   * `probeAdditional` is false (a config change re-checks the main key
   * only: a paused reviews key must not block it).
   */
  async validate(
    provider: SignedKeyProviderDefinition,
    credentials: Record<string, unknown> | undefined,
    config: Record<string, unknown>,
    options: { probeAdditional?: boolean } = {},
  ): Promise<SignedKeyResult<SignedKey>> {
    const parsed = this.parse(provider, credentials);
    if (!parsed.ok) {
      return parsed;
    }
    const probed = await this.probe(parsed.value, config);
    if (!probed.ok) {
      return probed;
    }
    if (options.probeAdditional !== false) {
      for (const id of parsed.value.additionalIds) {
        const additional = await this.probeAdditional(parsed.value, id, config);
        if (!additional.ok) {
          return additional;
        }
      }
    }
    return parsed;
  }
}

/** The providers compiled into this server, with real egress. */
export function createSignedKeyProviders(): SignedKeyProviders {
  return new SignedKeyProviders();
}
