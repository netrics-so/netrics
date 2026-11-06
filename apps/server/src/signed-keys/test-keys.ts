import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

// Test keys are generated at runtime; no private key is committed (ADR 0014).

export interface TestKeyPair {
  /** PEM PKCS#8, as in an App Store Connect .p8 file. */
  privateKeyPem: string;
  publicKey: KeyObject;
}

export function p256KeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    privateKeyPem: privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    publicKey,
  };
}

/** The base64 body of a PEM, without labels and line breaks. */
export function pemBody(pem: string): string {
  return pem
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("-----"))
    .join("");
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** Whether the ES256 signature verifies with the public key. */
  verifies: boolean;
}

/** Decodes a compact JWS and verifies its ES256 (r‖s) signature. */
export function decodeJwt(token: string, publicKey: KeyObject): DecodedJwt {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")),
    verifies: verify(
      "sha256",
      Buffer.from(`${header}.${claims}`, "ascii"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  };
}

export const TEST_ISSUER_ID = "57246542-96fe-1a63-e053-0824d011072a";
export const TEST_KEY_ID = "2X9R4HXF34";
