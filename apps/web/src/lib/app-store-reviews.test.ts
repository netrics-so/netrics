import { describe, expect, it } from "vitest";

import {
  REMOVE_REVIEWS_KEY,
  REVIEWS_KEY_GUIDE,
  reviewsKeyCredentials,
  reviewsKeyStrategy,
  reviewsStatusLabel,
} from "./app-store-reviews";
import type { SignedKeyStrategy } from "./signed-key";

const STRATEGY: SignedKeyStrategy = {
  strategy: "signed-key",
  provider: "app-store-connect",
  providerName: "App Store Connect",
  fields: [
    {
      key: "issuerId",
      label: "Issuer ID",
      description: "Issuer",
      input: "text",
      secret: false,
      maxBytes: 64,
    },
    {
      key: "keyId",
      label: "Key ID",
      description: "Key",
      input: "text",
      secret: false,
      maxBytes: 32,
    },
    {
      key: "privateKey",
      label: "Private key",
      description: "File",
      input: "file",
      secret: true,
      maxBytes: 4096,
    },
  ],
};

describe("App Store reviews card", () => {
  it("labels each status of the reviews key", () => {
    expect(reviewsStatusLabel("not_configured", null)).toBe(
      "Not set up. Ratings and reviews are optional.",
    );
    expect(reviewsStatusLabel("active", "CS5UPP0RT1")).toBe(
      "Reading ratings and reviews (key CS5UPP0RT1).",
    );
    expect(reviewsStatusLabel("paused", "CS5UPP0RT1")).toBe(
      "App Store reviews paused — upload a new reviews key (key CS5UPP0RT1).",
    );
    expect(reviewsStatusLabel("unknown", null)).toBe(
      "Status unknown right now.",
    );
  });

  it("asks for the key ID and the .p8 file only: the issuer ID is shared", () => {
    const strategy = reviewsKeyStrategy(STRATEGY);
    expect(strategy.fields.map((field) => field.key)).toEqual([
      "keyId",
      "privateKey",
    ]);
    expect(strategy.fields[0]!.description).toMatch(/Customer Support key/);
  });

  it("sends the key under `reviews`, normalized, and null to remove it", () => {
    expect(
      reviewsKeyCredentials(reviewsKeyStrategy(STRATEGY), {
        keyId: " cs5upp0rt1 ",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        issuerId: "ignored",
      }),
    ).toEqual({
      reviews: {
        keyId: "CS5UPP0RT1",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      },
    });
    expect(REMOVE_REVIEWS_KEY).toEqual({ reviews: null });
  });

  it("recommends the Customer Support role and says Admin keys are refused", () => {
    const text = REVIEWS_KEY_GUIDE.steps.join(" ");
    expect(text).toMatch(/Customer Support role/);
    expect(text).toMatch(/refuses Admin keys/);
    expect(REVIEWS_KEY_GUIDE.links[0].url).toBe(
      "https://appstoreconnect.apple.com/access/integrations/api",
    );
  });
});
