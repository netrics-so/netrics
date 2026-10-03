import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// Key parsing and ES256 signing with node:crypto only (ADR 0014). Messages
// name what was pasted but never quote it: no key material reaches errors,
// logs or responses.

/**
 * One PEM PKCS#8 block. Whitespace inside the body is tolerated (a paste may
 * have lost or changed its line breaks); the key is stored re-wrapped.
 */
const PKCS8_PEM =
  /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;

/** The labels of PEM blocks that are not a PKCS#8 private key. */
const OTHER_PEM: ReadonlyArray<[RegExp, string]> = [
  [
    /-----BEGIN CERTIFICATE-----/,
    "This is a certificate, not a private key. Upload the .p8 file of the API key.",
  ],
  [
    /-----BEGIN RSA PRIVATE KEY-----/,
    "This is an RSA private key. The API key is an EC (P-256) key in a .p8 file.",
  ],
  [
    /-----BEGIN ENCRYPTED PRIVATE KEY-----/,
    "This private key is encrypted with a passphrase. Upload the .p8 file as it was downloaded.",
  ],
  [
    /-----BEGIN EC PRIVATE KEY-----/,
    "This EC key is in SEC1 format, not PKCS#8. Upload the .p8 file as it was downloaded.",
  ],
  [
    /-----BEGIN (?:RSA )?PUBLIC KEY-----/,
    "This is a public key. Upload the private key, the .p8 file.",
  ],
  [
    /-----BEGIN OPENSSH PRIVATE KEY-----/,
    "This is an SSH key. Upload the .p8 file of the API key.",
  ],
];

const NOT_PEM =
  "The private key must be the contents of the .p8 file, starting with -----BEGIN PRIVATE KEY-----.";

/** A key that cannot be used, with a message for the user. */
export class SignedKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedKeyFormatError";
  }
}

/** A parsed key and its canonical PEM (64-character lines). */
export interface ParsedPrivateKey {
  key: KeyObject;
  pem: string;
}

/**
 * Parses a PEM PKCS#8 private key and requires an EC key on P-256 (the
 * curve of ES256). Throws SignedKeyFormatError with a message that names
 * what was pasted (an RSA key, a certificate, another curve).
 */
export function parseP256PrivateKey(input: string): ParsedPrivateKey {
  const text = input.trim();
  const body = PKCS8_PEM.exec(text)?.[1]?.replace(/\s+/g, "");
  if (!body) {
    for (const [pattern, message] of OTHER_PEM) {
      if (pattern.test(text)) {
        throw new SignedKeyFormatError(message);
      }
    }
    throw new SignedKeyFormatError(NOT_PEM);
  }
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    ...(body.match(/.{1,64}/g) ?? []),
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    // OpenSSL's reason is not useful to the user and is not passed on.
    throw new SignedKeyFormatError(
      "The private key could not be read. Upload the .p8 file as it was downloaded.",
    );
  }
  if (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") {
    throw new SignedKeyFormatError(
      "This is an RSA private key. The API key is an EC (P-256) key in a .p8 file.",
    );
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new SignedKeyFormatError(
      `This is an ${String(key.asymmetricKeyType).toUpperCase()} key. The API key is an EC (P-256) key in a .p8 file.`,
    );
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== "prime256v1") {
    throw new SignedKeyFormatError(
      `This EC key uses the curve ${curve ?? "unknown"}. The API key uses P-256 (ES256).`,
    );
  }
  return { key, pem };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * A compact JWS with ES256 (RFC 7515, RFC 7518 §3.4): the signature is the
 * raw r‖s pair (ieee-p1363), not DER.
 */
export function signEs256Jwt(
  key: KeyObject,
  kid: string,
  claims: Readonly<Record<string, string | number>>,
): string {
  const signingInput = `${base64UrlJson({ alg: "ES256", kid, typ: "JWT" })}.${base64UrlJson(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}
