import { describe, expect, it } from "vitest";

import {
  appleAdsAccounts,
  appleAdsConnectionAccount,
  listNames,
} from "./apple-ads";
import {
  appleAdsCredentialsBlock,
  keyFieldHint,
  keyRemovedQuery,
  localizeSignedKeyStrategy,
  parseKeyRemoved,
  type SignedKeyStrategy,
} from "./signed-key";

// The Apple Ads setup's pure rules (#375).

describe("appleAdsAccounts", () => {
  it("reads the preview's ad accounts and why some cannot be connected", () => {
    expect(
      appleAdsAccounts([
        {
          id: "4100000001",
          name: "US",
          kind: "ad_account",
          metadata: {
            selectable: true,
            currency: "USD",
            timeZone: "America/Los_Angeles",
            productFeatures: ["APPSTORE_APP_MANUAL"],
          },
        },
        {
          id: "4100000003",
          name: "Maps",
          kind: "ad_account",
          metadata: {
            selectable: false,
            productFeatures: ["BUSINESS_BRAND_MANUAL"],
          },
        },
        {
          id: "4100000004",
          name: "No role",
          kind: "ad_account",
          metadata: { selectable: false, productFeatures: [] },
        },
        { id: "1", name: "An app", kind: "app" },
      ]),
    ).toEqual([
      {
        id: "4100000001",
        name: "US",
        currency: "USD",
        timeZone: "America/Los_Angeles",
        selectable: true,
        unselectable: null,
      },
      {
        id: "4100000003",
        name: "Maps",
        currency: null,
        timeZone: null,
        selectable: false,
        unselectable: "maps",
      },
      {
        id: "4100000004",
        name: "No role",
        currency: null,
        timeZone: null,
        selectable: false,
        unselectable: "role",
      },
    ]);
  });
});

describe("appleAdsConnectionAccount", () => {
  it("reads the ad account, currency and time zone from the config", () => {
    expect(
      appleAdsConnectionAccount({
        adAccountId: "4100000001",
        adAccountName: "US",
        currency: "USD",
        timeZone: "America/Los_Angeles",
      }),
    ).toEqual({
      id: "4100000001",
      name: "US",
      currency: "USD",
      timeZone: "America/Los_Angeles",
    });
    expect(appleAdsConnectionAccount({ adAccountId: 42 })).toEqual({
      id: "42",
      name: null,
      currency: null,
      timeZone: null,
    });
  });

  it("lists connection names in the user's language", () => {
    expect(listNames(["A", "B"], "en")).toBe("“A” and “B”");
    expect(listNames(["A", "B"], "de")).toBe("„A“ und „B“");
  });
});

describe("Apple Ads key fields", () => {
  const client = "SEARCHADS.27478e71-3bb0-4588-998c-182e2b405577";
  const keyId = "a273d0d3-4d9e-458c-a173-0db8619ca7d7";

  it("checks the IDs as they are typed, and in full once the field is left", () => {
    for (const partial of ["S", "SEARCH", "searchads.", "SEARCHADS.2747"]) {
      expect(
        keyFieldHint("apple-ads", "clientId", partial, "en", { partial: true }),
      ).toBeNull();
    }
    expect(
      keyFieldHint("apple-ads", "clientId", "27478e71", "en", {
        partial: true,
      }),
    ).toContain("starts with SEARCHADS.");
    expect(
      keyFieldHint("apple-ads", "teamId", "SEARCHADS.2747", "en"),
    ).toContain("team ID starts with SEARCHADS.");
    expect(keyFieldHint("apple-ads", "teamId", client, "en")).toBeNull();
    expect(keyFieldHint("apple-ads", "keyId", keyId, "en")).toBeNull();
    expect(
      keyFieldHint("apple-ads", "keyId", client, "en", { partial: true }),
    ).toContain("looks like a client ID");
    expect(keyFieldHint("apple-ads", "keyId", "a273 d0d3", "de")).toContain(
      "Schlüssel-ID",
    );
  });

  it("reads the three IDs from a pasted credentials block, not from one ID", () => {
    expect(
      appleAdsCredentialsBlock(
        `clientId ${client}\nteamId ${client}\nkeyId ${keyId}\n`,
      ),
    ).toEqual({ clientId: client, teamId: client, keyId });
    expect(
      appleAdsCredentialsBlock(
        JSON.stringify({ clientId: client, teamId: client, keyId }),
      ),
    ).toEqual({ clientId: client, teamId: client, keyId });
    expect(appleAdsCredentialsBlock(client)).toBeNull();
  });

  it("words the provider's fields and steps in German", () => {
    const strategy: SignedKeyStrategy = {
      strategy: "signed-key",
      provider: "apple-ads",
      providerName: "Apple Ads",
      generatedKeyPair: true,
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          description: "English.",
          input: "text",
          secret: false,
          maxBytes: 80,
        },
      ],
      setup: {
        steps: ["1", "2", "3", "4"],
        url: "https://ads.apple.com/",
        links: [{ step: 0, label: "Invite", url: "https://ads.apple.com/" }],
      },
    };
    const de = localizeSignedKeyStrategy(strategy, "de");
    expect(de.fields[0]!.label).toBe("Client-ID");
    expect(de.setup!.steps[1]).toContain("Account Settings → API");
    expect(de.setup!.links![0]!.label).toBe(
      "So lädst du einen API-Benutzer ein",
    );
    expect(localizeSignedKeyStrategy(strategy, "en")).toBe(strategy);
  });

  it("says after a deletion whether other connections still use the key", () => {
    expect(keyRemovedQuery("apple-ads", true)).toBe(
      "keyRemoved=apple-ads&keyShared=1",
    );
    expect(parseKeyRemoved({ keyRemoved: "apple-ads" })).toBe("apple-ads");
  });
});
