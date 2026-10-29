import { describe, expect, it, vi } from "vitest";

import type { ConnectorCatalogEntry } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ConnectionActions } from "../[connectionId]/connection-actions";
import { SignedKeyPanel } from "../[connectionId]/signed-key-panel";
import { NewConnectionWizard } from "./new-connection-wizard";
import { renderI18n } from "@/lib/i18n/test-render";
import { signedKeyStrategyOf } from "@/lib/signed-key";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The guided Apple Ads setup and the connection page's key states (#375),
// rendered in English and German.

const text = (key: string, label: string) => ({
  key,
  label,
  description: `The ${key} shown under Account Settings → API.`,
  input: "text" as const,
  secret: false,
  maxBytes: 80,
});

const APPLE_ADS: ConnectorCatalogEntry = {
  id: "apple-ads",
  name: "Apple Ads",
  version: "0.1.0",
  description: "Spend and installs.",
  metricsCount: 6,
  category: "ads",
  brandColor: "#0d84ff",
  metrics: [{ key: "apple_ads.spend", name: "Ad spend" }],
  minRefreshIntervalSeconds: 21600,
  supportsBackfill: true,
  configSchema: { type: "object", properties: {} },
  authStrategies: [
    {
      strategy: "signed-key",
      provider: "apple-ads",
      providerName: "Apple Ads",
      generatedKeyPair: true,
      fields: [
        text("clientId", "Client ID"),
        text("teamId", "Team ID"),
        text("keyId", "Key ID"),
        {
          key: "privateKey",
          label: "Private key",
          description: "PEM.",
          input: "file",
          secret: true,
          maxBytes: 4096,
        },
      ],
      setup: {
        steps: ["One.", "Two.", "Three.", "Four."],
        url: "https://ads.apple.com/",
      },
    },
  ],
  available: true,
  unavailable: null,
};
const strategy = signedKeyStrategyOf(APPLE_ADS)!;

function render(locale: Locale) {
  return renderI18n(
    <>
      <NewConnectionWizard
        workspaceId="w"
        connectors={[APPLE_ADS]}
        initialConnectorId="apple-ads"
      />
      <SignedKeyPanel
        workspaceId="w"
        connectionId="c"
        strategy={strategy}
        signedKey={{
          provider: "apple-ads",
          fields: [{ key: "keyId", label: "Key ID", value: "a273d0d3-4d9e" }],
          sharedWith: [
            { id: "11111111-1111-4111-8111-111111111111", name: "EU" },
          ],
        }}
        hasCredentials
        authFailed
        canUpdate
      />
      <ConnectionActions
        workspaceId="w"
        connectionId="c"
        connectionName="US"
        oauthProvider={null}
        signedKey={{
          provider: "apple-ads",
          providerName: "Apple Ads",
          revokeUrl: "https://ads.apple.com/",
          keyId: "a273d0d3-4d9e",
          sharedWith: ["EU"],
        }}
        canSync
        canUpdate
        canDelete
      />
    </>,
    locale,
  );
}

describe("Apple Ads setup (#375)", () => {
  it("walks through the API user, the public key, the IDs and the check, in English", () => {
    const html = render("en");
    for (const expected of [
      "1. Use an API user",
      "API Account Read Only",
      "Limited Access: API Read Only",
      "Account Settings → User Management",
      "2. Paste the public key in Apple Ads",
      "Generate key pair",
      "I already have a private key",
      "3. Enter the IDs Apple Ads shows",
      "Check key and find ad accounts",
      // The connection page: auth_failed, the shared key.
      "Set up a new key",
      "The same key also reads “EU”",
    ]) {
      expect(html).toContain(expected);
    }
    // The generic "upload a key" copy is not used for Apple Ads.
    expect(html).not.toContain("Upload a new Apple Ads key");
  });

  it("is German throughout", () => {
    const html = render("de");
    for (const expected of [
      "1. Einen API-Benutzer verwenden",
      "2. Öffentlichen Schlüssel in Apple Ads einfügen",
      "3. Die IDs aus Apple Ads eingeben",
      "Schlüssel prüfen und Werbekonten finden",
      "Client-ID",
      "Schlüssel-ID",
      "Neuen Schlüssel einrichten",
      "Derselbe Schlüssel liest auch „EU“",
    ]) {
      expect(html).toContain(expected);
    }
    for (const english of [
      "Use an API user",
      "Check key and find ad accounts",
      "Set up a new key",
    ]) {
      expect(html).not.toContain(english);
    }
  });
});
