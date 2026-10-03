import type { KeyObject } from "node:crypto";

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
  type SignedKeyFieldValues,
  type SignedKeyProviderDefinition,
} from "./providers/index.js";

// The host's signed-key providers (ADR 0014): credential validation before
// persistence, per-call token signing, and the probe hook. The private key
// stays in this module's objects; connectors receive `{ accessToken }`.

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
 * Validated credentials of one provider. The key object and the PEM never
 * leave this class except through `stored()` (for the envelope) and signed
 * tokens. JSON serialization and inspection show no key material.
 */
export class SignedKey {
  readonly #provider: SignedKeyProviderDefinition;
  readonly #values: SignedKeyFieldValues;
  readonly #key: KeyObject;
  readonly #now: () => number;

  constructor(
    provider: SignedKeyProviderDefinition,
    values: SignedKeyFieldValues,
    key: KeyObject,
    now: () => number,
  ) {
    this.#provider = provider;
    this.#values = values;
    this.#key = key;
    this.#now = now;
  }

  get provider(): SignedKeyProviderDefinition {
    return this.#provider;
  }

  /** The non-secret fields (e.g. issuer ID and key ID). */
  get publicFields(): SignedKeyFieldValues {
    return Object.fromEntries(
      this.#provider.fields
        .filter((field) => !field.secret)
        .map((field) => [field.key, this.#values[field.key]!]),
    );
  }

  /** What the credentials envelope stores: every field, normalized. */
  stored(): Record<string, string> {
    return { ...this.#values };
  }

  /** A freshly signed token: never cached, never stored, never enqueued. */
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
   * never quote a value.
   */
  parse(
    provider: SignedKeyProviderDefinition,
    credentials: Record<string, unknown> | undefined,
  ): SignedKeyResult<SignedKey> {
    const input = credentials ?? {};
    const known = new Set(provider.fields.map((field) => field.key));
    const unknown = Object.keys(input).find((key) => !known.has(key));
    if (unknown !== undefined) {
      return {
        ok: false,
        message: `${provider.name} credentials take ${provider.fields
          .map((field) => field.label)
          .join(", ")}; remove the unknown field "${unknown.slice(0, 40)}".`,
      };
    }
    const values: Record<string, string> = {};
    let key: KeyObject | undefined;
    for (const field of provider.fields) {
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
    return { ok: true, value: new SignedKey(provider, values, key, this.#now) };
  }

  /**
   * The provider's probes with the candidate key and config, in order; the
   * first failure answers. Messages are redacted of every credential value
   * and every token minted for the probes.
   */
  async probe(
    key: SignedKey,
    config: Record<string, unknown>,
  ): Promise<SignedKeyResult<true>> {
    const provider = key.provider;
    const tokens: string[] = [];
    const http = this.#http(provider);
    const redact = (message: string) =>
      redactCredentialValues(redactCredentialValues(message, key.stored()), {
        tokens,
      }).slice(0, 500);
    for (const probe of provider.probes) {
      let result;
      try {
        result = await probe.run({
          config,
          fields: key.publicFields,
          accessToken: () => {
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

  /** parse, then probe: the whole validation before anything is stored. */
  async validate(
    provider: SignedKeyProviderDefinition,
    credentials: Record<string, unknown> | undefined,
    config: Record<string, unknown>,
  ): Promise<SignedKeyResult<SignedKey>> {
    const parsed = this.parse(provider, credentials);
    if (!parsed.ok) {
      return parsed;
    }
    const probed = await this.probe(parsed.value, config);
    return probed.ok ? parsed : probed;
  }
}

/** The providers compiled into this server, with real egress. */
export function createSignedKeyProviders(): SignedKeyProviders {
  return new SignedKeyProviders();
}
