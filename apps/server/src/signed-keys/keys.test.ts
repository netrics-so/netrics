import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseP256PrivateKey,
  SignedKeyFormatError,
  signEs256Jwt,
} from "./keys.js";
import { decodeJwt, p256KeyPair, pemBody } from "./test-keys.js";

// ADR 0014: PEM PKCS#8 EC P-256 keys only, with messages that name what was
// pasted and never quote it; ES256 signatures in the JOSE r‖s form.

function rejection(input: string): SignedKeyFormatError {
  try {
    parseP256PrivateKey(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SignedKeyFormatError);
    return error as SignedKeyFormatError;
  }
  throw new Error("expected the key to be rejected");
}

/** The message must not carry any part of the key it rejects. */
function expectNoKeyMaterial(message: string, pem: string) {
  const body = pemBody(pem);
  expect(message).not.toContain(body.slice(0, 24));
  for (const line of pem.split("\n").filter((l) => !l.startsWith("-----"))) {
    if (line.length >= 16) {
      expect(message).not.toContain(line);
    }
  }
}

describe("parseP256PrivateKey", () => {
  it("accepts a PKCS#8 P-256 key and re-wraps a paste that lost its line breaks", () => {
    const { privateKeyPem } = p256KeyPair();
    const parsed = parseP256PrivateKey(privateKeyPem);
    expect(parsed.key.asymmetricKeyType).toBe("ec");
    expect(parsed.key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(parsed.pem).toBe(privateKeyPem);

    const flattened = `  ${privateKeyPem.replace(/\n/g, " ")}  `;
    expect(parseP256PrivateKey(flattened).pem).toBe(privateKeyPem);
    const crlf = privateKeyPem.replace(/\n/g, "\r\n");
    expect(parseP256PrivateKey(crlf).pem).toBe(privateKeyPem);
  });

  it("names an RSA key, in PKCS#1 and in PKCS#8", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const type of ["pkcs1", "pkcs8"] as const) {
      const pem = privateKey.export({ format: "pem", type }) as string;
      const error = rejection(pem);
      expect(error.message).toMatch(/RSA private key/);
      expectNoKeyMaterial(error.message, pem);
    }
  });

  it("names the curve of an EC key that is not P-256", () => {
    for (const [curve, name] of [
      ["P-384", "secp384r1"],
      ["secp256k1", "secp256k1"],
    ] as const) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
      const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
      const error = rejection(pem);
      expect(error.message).toContain(`curve ${name}`);
      expect(error.message).toContain("P-256");
      expectNoKeyMaterial(error.message, pem);
    }
  });

  it("names an Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(rejection(pem).message).toMatch(/ED25519 key/);
  });

  it("refuses an encrypted PKCS#8 key", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "correct horse",
    }) as string;
    const error = rejection(pem);
    expect(error.message).toMatch(/encrypted/);
    expectNoKeyMaterial(error.message, pem);
  });

  it("refuses a SEC1 EC key, a public key and a certificate by name", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const sec1 = privateKey.export({ format: "pem", type: "sec1" }) as string;
    expect(rejection(sec1).message).toMatch(/SEC1/);
    const spki = publicKey.export({ format: "pem", type: "spki" }) as string;
    expect(rejection(spki).message).toMatch(/public key/);
    const certificate =
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGVOb3RBS2V5MAoGCCqGSM49BAMC\n-----END CERTIFICATE-----\n";
    expect(rejection(certificate).message).toMatch(/certificate/);
  });

  it("refuses garbage and a corrupted body without passing OpenSSL's reason on", () => {
    expect(rejection("not a key at all").message).toMatch(/BEGIN PRIVATE KEY/);
    expect(rejection("").message).toMatch(/BEGIN PRIVATE KEY/);
    const { privateKeyPem } = p256KeyPair();
    const body = pemBody(privateKeyPem);
    const corrupted = `-----BEGIN PRIVATE KEY-----\n${body.slice(0, 40)}AAAA${body.slice(44)}\n-----END PRIVATE KEY-----`;
    const error = rejection(corrupted);
    expect(error.message).toBe(
      "The private key could not be read. Upload the .p8 file as it was downloaded.",
    );
    const truncated = `-----BEGIN PRIVATE KEY-----\n${body.slice(0, 30)}\n-----END PRIVATE KEY-----`;
    expect(rejection(truncated).message).toMatch(/could not be read/);
  });
});

describe("signEs256Jwt", () => {
  it("signs a JWS whose header, claims and r‖s signature verify with the public key", () => {
    const { privateKeyPem, publicKey } = p256KeyPair();
    const { key } = parseP256PrivateKey(privateKeyPem);
    const token = signEs256Jwt(key, "2X9R4HXF34", {
      iss: "issuer",
      aud: "appstoreconnect-v1",
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // ES256 in JOSE is the raw 64-byte r‖s pair, not DER.
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(64);
    const decoded = decodeJwt(token, publicKey);
    expect(decoded.verifies).toBe(true);
    expect(decoded.header).toEqual({
      alg: "ES256",
      kid: "2X9R4HXF34",
      typ: "JWT",
    });
    expect(decoded.claims).toEqual({
      iss: "issuer",
      aud: "appstoreconnect-v1",
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    });
    // Another key's public half does not verify it.
    expect(decodeJwt(token, p256KeyPair().publicKey).verifies).toBe(false);
  });
});
