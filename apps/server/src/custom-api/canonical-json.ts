import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, undefined entries dropped, arrays in
 * order. Two documents that differ only in key order serialize the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const entry = (value as Record<string, unknown>)[key];
          return entry === undefined ? [] : [[key, sortKeys(entry)]];
        }),
    );
  }
  return value;
}

/** SHA-256 (hex) of the value's canonical JSON. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
