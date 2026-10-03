import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

/**
 * A signed-key provider definition (ADR 0014): trusted host code that knows
 * how a provider's uploaded key is validated and signed into short-lived
 * tokens. Connectors only name the provider; they never see the key, the
 * claims or the lifetime, and receive `credentials: { accessToken }`.
 * Community connectors may name a provider but never define one.
 */
export interface SignedKeyProviderDefinition {
  /** Stable id, used in manifests ("app-store-connect"). */
  readonly id: string;
  /** Display name ("Upload a new App Store Connect key"). */
  readonly name: string;
  /**
   * The credential fields the wizard asks for, in order. Exactly one is the
   * private key (`privateKey: true`); its value is a PEM PKCS#8 EC P-256
   * key, which the host parses and checks before anything else.
   */
  readonly fields: readonly SignedKeyField[];
  /** The JWT `kid` header and claims besides `iat` and `exp`. */
  token(credentials: SignedKeyFieldValues): {
    kid: string;
    claims: Readonly<Record<string, string>>;
  };
  /**
   * Token lifetime: `iat` is now − issuedBeforeSeconds (clock skew), `exp`
   * is now + expiresInSeconds.
   */
  readonly lifetime: {
    readonly issuedBeforeSeconds: number;
    readonly expiresInSeconds: number;
  };
  /**
   * Hosts the validation probes may reach: the egress allowlist of
   * host-side probe calls. Connector calls use the connector's own
   * outboundDomains.
   */
  readonly serverDomains: readonly string[];
  /**
   * The wizard's setup copy: steps to create the key, the keys page, and
   * deep links shown with a step (`step` indexes `steps`).
   */
  readonly setup: {
    readonly steps: readonly string[];
    readonly url: string;
    readonly links?: readonly {
      readonly step: number;
      readonly label: string;
      readonly url: string;
    }[];
  };
  /**
   * Checks with a freshly signed token before the credentials are stored
   * (create, preview, rotation, config change). They run in order after the
   * field and key checks; the first failure is the answer.
   */
  readonly probes: readonly SignedKeyProbe[];
  /**
   * What the user reads when the provider refuses a freshly signed token
   * during a connector call: 401 (key revoked or invalid) and 403 (role
   * missing). Both put the connection in auth_failed.
   */
  readonly authFailure: {
    readonly unauthorized: string;
    readonly forbidden: string;
  };
  /**
   * Optional further keys of the same connection (#190: App Store Connect's
   * reviews key), stored in the same envelope under their `id`. Each is
   * validated with its own probes, signed into its own token and handed to
   * the connector as `credentials[tokenField]`. A refusal of such a token
   * never puts the connection in auth_failed: the connector pauses what
   * the key reads.
   */
  readonly additionalKeys?: readonly SignedKeyAdditionalKey[];
}

/**
 * An optional additional key of a signed-key provider. Its fields replace
 * the main key's fields of the same name (key ID, private key); the main
 * key's other fields (the team-wide issuer ID) are shared, and the
 * provider's `token()` signs it with the merged values.
 */
export interface SignedKeyAdditionalKey {
  /** Envelope and request member ("reviews"). */
  readonly id: string;
  /** Display name ("Customer Support key"). */
  readonly name: string;
  /** The connector's credential field for its token ("reviewsAccessToken"). */
  readonly tokenField: string;
  /** Its own fields, in order; exactly one is the private key. */
  readonly fields: readonly SignedKeyField[];
  /**
   * Checks with a freshly signed token of this key (and the connection's
   * config) before it is stored; the first failure answers.
   */
  readonly probes: readonly SignedKeyProbe[];
}

/** One credential field of a signed-key provider. */
export interface SignedKeyField {
  /** The key in `credentials` (and in the stored envelope). */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** "file": chosen with a file picker, or pasted. */
  readonly input: "text" | "file";
  /** Whether the value is secret (never shown again after upload). */
  readonly secret: boolean;
  readonly placeholder?: string;
  /** Upper bound in UTF-8 bytes, checked before anything else. */
  readonly maxBytes: number;
  /** The private key field (exactly one per provider). */
  readonly privateKey?: true;
  /**
   * Format check of the trimmed value: null when valid, otherwise a message
   * for the user. It must not quote the value.
   */
  validate?(value: string): string | null;
}

/** Trimmed credential values by field key. */
export type SignedKeyFieldValues = Readonly<Record<string, string>>;

/** What a probe may use: the candidate key's tokens and guarded egress. */
export interface SignedKeyProbeContext {
  /** The connection config being validated with the key (vendor number). */
  readonly config: Readonly<Record<string, unknown>>;
  /** The non-secret credential fields (issuer ID, key ID). */
  readonly fields: SignedKeyFieldValues;
  /** A freshly signed token for the candidate key, per call. */
  accessToken(): string;
  /**
   * HTTPS to the provider's serverDomains only (public addresses, no
   * redirects, short timeout, bounded body).
   */
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
}

export type SignedKeyProbeResult =
  | { ok: true }
  | {
      ok: false;
      /** Shown to the user; credential values are redacted from it. */
      message: string;
    };

/**
 * A validation probe (ADR 0014, "Validation before anything is stored"),
 * e.g. App Store Connect's `GET /v1/apps?limit=1` and the sales report
 * probe (#171). A thrown error counts as a failed validation with a generic
 * message; it is never retried here.
 */
export interface SignedKeyProbe {
  /** Short name for logs ("apps", "sales-report"). */
  readonly name: string;
  run(context: SignedKeyProbeContext): Promise<SignedKeyProbeResult>;
}
