import { readFileSync } from "node:fs";

// Test-only: the definition fixtures of the connector SDK (C-G1), read as
// raw JSON documents the way a client would send them.

const FIXTURES = new URL(
  "../../../../packages/connector-sdk/src/custom-api/fixtures/",
  import.meta.url,
);

export function customApiFixture(
  name: "v1-shop" | "v1-all-auth" | "v1-images",
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"),
  ) as Record<string, unknown>;
}
