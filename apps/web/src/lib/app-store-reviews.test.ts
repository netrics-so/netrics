import { describe, expect, it } from "vitest";

import {
  REMOVE_REVIEWS_KEY,
  reviewsKeyGuide,
  reviewsKeyCredentials,
  reviewsKeyStrategy,
  reviewsLead,
  reviewsStatusLabel,
} from "./app-store-reviews";
import { webTranslator } from "./i18n/catalogs";
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
    expect(reviewsStatusLabel("not_configured", null, "en")).toBe(
      "Not set up. Ratings and reviews are optional.",
    );
    expect(reviewsStatusLabel("active", "CS5UPP0RT1", "en")).toBe(
      "Reading ratings and reviews (key CS5UPP0RT1).",
    );
    expect(reviewsStatusLabel("paused", "CS5UPP0RT1", "en")).toBe(
      "App Store reviews paused — upload a new reviews key (key CS5UPP0RT1).",
    );
    expect(reviewsStatusLabel("unknown", null, "en")).toBe(
      "Status unknown right now.",
    );
    expect(reviewsStatusLabel("active", "CS5UPP0RT1", "de")).toBe(
      "Bewertungen und Rezensionen werden gelesen (Schlüssel CS5UPP0RT1).",
    );
    expect(reviewsKeyStrategy(STRATEGY, "de").providerName).toBe(
      "Customer Support",
    );
  });

  it("asks for the key ID and the .p8 file only: the issuer ID is shared", () => {
    const strategy = reviewsKeyStrategy(STRATEGY, "en");
    expect(strategy.fields.map((field) => field.key)).toEqual([
      "keyId",
      "privateKey",
    ]);
    expect(strategy.fields[0]!.description).toMatch(/Customer Support key/);
  });

  it("sends the key under `reviews`, normalized, and null to remove it", () => {
    expect(
      reviewsKeyCredentials(reviewsKeyStrategy(STRATEGY, "en"), {
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
    const guide = reviewsKeyGuide("en");
    const text = guide.steps.join(" ");
    expect(text).toMatch(/Customer Support role/);
    expect(text).toMatch(/refuses Admin keys/);
    expect(guide.links[0]!.url).toBe(
      "https://appstoreconnect.apple.com/access/integrations/api",
    );
  });

  // #712: the card's privacy statement matches what is kept (the connector
  // doc, "What is read and kept"): the newest 50 reviews per app with text
  // and nickname, at most 90 days, deleted with the key.
  it.each([
    [
      "en",
      /newest 50 reviews, at most 90 days; removing the key deletes them/,
      /never review text|only counts and stars/,
    ],
    [
      "de",
      /neuesten 50 Rezensionen jeder App, höchstens 90 Tage lang; wird der Schlüssel entfernt, werden sie gelöscht/,
      /nie Rezensionstexte|nur Anzahlen und Sterne/,
    ],
  ] as const)(
    "says in %s which review text is kept and for how long",
    (locale, kept, wrong) => {
      const intro = webTranslator(
        locale,
        "connections.appStoreReviews",
      )("intro");
      expect(intro).toMatch(kept);
      expect(intro).not.toMatch(wrong);
    },
  );

  it("words the lead by the key's status (#771)", () => {
    expect(reviewsLead(null, "en")).toBe(
      "Reviews: an optional Customer Support key reads them.",
    );
    expect(reviewsLead("not_configured", "en")).toBe(
      "Reviews: add a Customer Support key.",
    );
    expect(reviewsLead("active", "en")).toBe(
      "Reviews: read with the stored Customer Support key.",
    );
    expect(reviewsLead("paused", "en")).toBe(
      "Reviews paused: upload a new Customer Support key.",
    );
    expect(reviewsLead("unknown", "en")).toBe(
      "Reviews: the key’s status is unknown right now.",
    );
    expect(reviewsLead(null, "de")).toBe(
      "Rezensionen: Ein optionaler Customer-Support-Schlüssel liest sie.",
    );
    expect(reviewsLead("not_configured", "de")).toBe(
      "Rezensionen: Füg einen Customer-Support-Schlüssel hinzu.",
    );
    expect(reviewsLead("active", "de")).toBe(
      "Rezensionen: werden mit dem gespeicherten Customer-Support-Schlüssel gelesen.",
    );
    expect(reviewsLead("paused", "de")).toBe(
      "Rezensionen pausiert: Lade einen neuen Customer-Support-Schlüssel hoch.",
    );
    expect(reviewsLead("unknown", "de")).toBe(
      "Rezensionen: Der Status des Schlüssels ist gerade unbekannt.",
    );
  });
});
