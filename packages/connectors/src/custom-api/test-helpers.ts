// Shared inputs of the custom-api package tests (excluded from dist).
import { readFileSync } from "node:fs";

import {
  upgradeCustomApiDefinition,
  type CustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";

import type { CustomApiPin } from "./manifest.js";

const FIXTURES = new URL(
  "../../../connector-sdk/src/custom-api/fixtures/",
  import.meta.url,
);

export function sdkFixture(
  name: "v1-shop" | "v1-all-auth" | "v1-images",
): CustomApiDefinition {
  return upgradeCustomApiDefinition(
    JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")),
  );
}

export function pinFor(
  definition: CustomApiDefinition,
  overrides: Partial<CustomApiPin> = {},
): CustomApiPin {
  return {
    definitionId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    version: 3,
    environmentId: definition.environments[0]!.id,
    datasetVersions: Object.fromEntries(
      definition.streams.map((stream) => [stream.key, 1]),
    ),
    ...overrides,
  };
}

export const b64 = (value: string) => Buffer.from(value).toString("base64");
