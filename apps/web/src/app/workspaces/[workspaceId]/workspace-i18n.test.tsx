import { describe, expect, it, vi } from "vitest";

import type { ConnectorCatalogEntry } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ConfigFields } from "./connections/config-fields";
import { ConnectOAuthButton } from "./connections/connect-oauth-button";
import { NewConnectionWizard } from "./connections/new/new-connection-wizard";
import { SignedKeyFields } from "./connections/signed-key-fields";
import { ConnectionActions } from "./connections/[connectionId]/connection-actions";
import { DeviceControls } from "./device-controls";
import { HealthBadge } from "./health-badge";
import { ApproveDeviceForm } from "@/app/devices/approve/approve-form";
import { renderI18n } from "@/lib/i18n/test-render";
import { signedKeyStrategyOf } from "@/lib/signed-key";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const CONNECTORS: ConnectorCatalogEntry[] = [
  {
    id: "demo",
    name: "Demo",
    version: "0.1.0",
    description: "Sample numbers.",
    metricsCount: 3,
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    configSchema: { type: "object", properties: {} },
    authStrategies: [{ strategy: "none" }],
    available: true,
    unavailable: null,
  },
  {
    id: "google-search-console",
    name: "Google Search Console",
    version: "0.1.0",
    description: "Clicks and impressions.",
    metricsCount: 1,
    minRefreshIntervalSeconds: 300,
    supportsBackfill: false,
    configSchema: { type: "object", properties: {} },
    authStrategies: [{ strategy: "oauth2", provider: "google", scopes: ["s"] }],
    available: false,
    unavailable: {
      reason: "oauth_provider_not_configured",
      provider: "google",
    },
  },
] as ConnectorCatalogEntry[];

const ASC = signedKeyStrategyOf({
  authStrategies: [
    {
      strategy: "signed-key",
      provider: "app-store-connect",
      providerName: "App Store Connect",
      fields: [
        {
          key: "issuerId",
          label: "Issuer ID",
          description: "Above the list of team keys.",
          input: "text",
          secret: false,
          maxBytes: 64,
        },
        {
          key: "privateKey",
          label: "Private key",
          description: "The .p8 file.",
          input: "file",
          secret: true,
          maxBytes: 4096,
        },
      ],
    },
  ],
} as never)!;

function render(locale: Locale) {
  return renderI18n(
    <>
      <HealthBadge health="needs_reauthorization" />
      <DeviceControls
        workspaceId="w"
        device={{ id: "d", name: "Lobby", dashboardId: null }}
        dashboards={[{ id: "x", name: "Sales" }]}
      />
      <NewConnectionWizard workspaceId="w" connectors={CONNECTORS} />
      <ConnectionActions
        workspaceId="w"
        connectionId="c"
        connectionName="Demo"
        oauthProvider="google"
        canSync
        canUpdate
        canDelete
      />
      <ConnectOAuthButton
        workspaceId="w"
        connectorId="google-search-console"
        provider="google"
        connectionId="c"
        returnPath="/"
        offerAccountChange
      />
      <ConfigFields
        fields={[
          { key: "flag", label: "Flag", type: "boolean", required: false },
        ]}
        values={{}}
        onChange={() => {}}
      />
      <SignedKeyFields strategy={ASC} values={{}} onChange={() => {}} />
      <ApproveDeviceForm
        initialCode=""
        workspaces={[{ id: "w", name: "Acme", dashboards: [] }]}
      />
    </>,
    locale,
  );
}

describe("workspace, connections and devices", () => {
  it("render in English", () => {
    const html = render("en");
    expect(html).toContain("Needs reconnect");
    expect(html).toContain("No dashboard");
    expect(html).toContain("1. Choose a connector");
    expect(html).toContain("v0.1.0 · 3 metrics · backfill");
    expect(html).toContain("Needs Google sign-in set up by an administrator");
    expect(html).toContain("Sync now");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Reconnect Google");
    expect(html).toContain("Use a different Google account");
    expect(html).toContain("Flag (optional)");
    expect(html).toContain("Private key");
    expect(html).toContain("Code on the TV");
  });

  it("render in German", () => {
    const html = render("de");
    expect(html).toContain("Neu verbinden");
    expect(html).toContain("Kein Dashboard");
    expect(html).toContain("Widerrufen");
    expect(html).toContain("1. Connector auswählen");
    expect(html).toContain("v0.1.0 · 3 Metriken · mit Historie");
    expect(html).toContain(
      "Die Anmeldung mit Google muss erst ein Administrator einrichten",
    );
    expect(html).toContain("Jetzt synchronisieren");
    expect(html).toContain("Trennen");
    expect(html).toContain("Google neu verbinden");
    expect(html).toContain("Anderes Google-Konto verwenden");
    expect(html).toContain("Flag (optional)");
    expect(html).toContain(">Ja<");
    expect(html).toContain("Privater Schlüssel");
    expect(html).toContain("Code auf dem TV");
    expect(html).toContain("TV verbinden");
    for (const english of [
      "Sync now",
      "Choose a connector",
      "Revoke",
      "Private key",
      "Connect TV",
    ]) {
      expect(html).not.toContain(english);
    }
  });
});
