import { createHash, randomBytes } from "node:crypto";

/**
 * One-time bearer tokens (setup, invitations): 256 random bits, URL-safe.
 * Only the SHA-256 hex digest is ever stored.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Bearer token for a service account or device. The "nt_" prefix makes
 * leaked tokens recognizable to secret scanners.
 */
export function generatePrincipalToken(): string {
  return `nt_${generateToken()}`;
}
