import { describe, expect, it, vi } from "vitest";

import type { ConnectorCatalogEntry } from "@netrics/contracts";

import { NewConnectionWizard } from "@/app/workspaces/[workspaceId]/connections/new/new-connection-wizard";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  connectSourcePath,
  onboardingRail,
  onboardingStep,
  welcomePath,
} from "@/lib/onboarding";

import { OnboardingFrame } from "./onboarding-frame";
import { ScreenStep } from "./screen-step";
import { SourceStep, sourceAccess, sourceChoices } from "./source-step";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

function connector(
  id: string,
  name: string,
  strategy: "none" | "oauth2" | "signed-key" | "token",
  available = true,
): ConnectorCatalogEntry {
  return {
    id,
    name,
    version: "0.1.0",
    description: `${name} metrics.`,
    metricsCount: 2,
    category: "other",
    brandColor: null,
    metrics: [],
    minRefreshIntervalSeconds: 300,
    supportsBackfill: true,
    configSchema: { type: "object", properties: {} },
    authStrategies: [{ strategy }],
    available,
    unavailable: available
      ? null
      : { reason: "oauth_provider_not_configured", provider: "google" },
  };
}

const DEMO = connector("demo", "Demo", "none");
const GSC = connector("google-search-console", "Search Console", "oauth2");
const ASC = connector("app-store-connect", "App Store Connect", "signed-key");
const VERCEL = connector("vercel", "Vercel", "token");

describe("onboarding step", () => {
  it("is step 1 without a workspace", () => {
    expect(onboardingStep({ hasWorkspace: false })).toBe("workspace");
  });

  it("is step 2 until a real source exists; demo data does not count", () => {
    expect(onboardingStep({ hasWorkspace: true, connections: [] })).toBe(
      "source",
    );
    expect(
      onboardingStep({
        hasWorkspace: true,
        connections: [{ connectorId: "demo" }],
      }),
    ).toBe("source");
  });

  it("is step 3 with a real source, after skipping, or for viewers", () => {
    expect(
      onboardingStep({
        hasWorkspace: true,
        connections: [{ connectorId: "demo" }, { connectorId: "vercel" }],
      }),
    ).toBe("screen");
    expect(
      onboardingStep({
        hasWorkspace: true,
        connections: [],
        requested: "screen",
      }),
    ).toBe("screen");
    expect(
      onboardingStep({
        hasWorkspace: true,
        connections: [],
        canConnect: false,
      }),
    ).toBe("screen");
    // Unknown values are ignored.
    expect(
      onboardingStep({ hasWorkspace: true, connections: [], requested: "x" }),
    ).toBe("source");
  });

  it("marks the steps before the current one done", () => {
    expect(onboardingRail("source").map((s) => s.state)).toEqual([
      "done",
      "current",
      "next",
    ]);
    expect(onboardingRail("workspace").map((s) => s.state)).toEqual([
      "current",
      "next",
      "next",
    ]);
    expect(onboardingRail("screen").map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it("builds the step links", () => {
    expect(welcomePath("w")).toBe("/workspaces/w/welcome");
    expect(welcomePath("w", "screen")).toBe(
      "/workspaces/w/welcome?step=screen",
    );
    expect(connectSourcePath("w", "google-search-console")).toBe(
      "/workspaces/w/connections/new?connector=google-search-console",
    );
  });
});

describe("onboarding frame", () => {
  it("shows the rail with done, current and next steps", () => {
    const html = renderI18n(
      <OnboardingFrame step="source">
        <p>content</p>
      </OnboardingFrame>,
    );
    expect(html).toContain(
      '<li class="onboarding-step done"><span class="onboarding-step-mark" aria-hidden="true">✓</span>Create your workspace<span class="visually-hidden"> (done)</span></li>',
    );
    expect(html).toContain(
      '<li class="onboarding-step current" aria-current="step"><span class="onboarding-step-mark" aria-hidden="true">2</span>Connect a source</li>',
    );
    expect(html).toContain(
      '<li class="onboarding-step next"><span class="onboarding-step-mark" aria-hidden="true">3</span>Show it on a screen</li>',
    );
    expect(html).toContain("<p>content</p>");
  });

  it("is translated", () => {
    const html = renderI18n(
      <OnboardingFrame step="workspace">{null}</OnboardingFrame>,
      "de",
    );
    for (const text of [
      "Workspace erstellen",
      "Quelle verbinden",
      "Auf einem Bildschirm zeigen",
    ]) {
      expect(html).toContain(text);
    }
  });
});

describe("source step", () => {
  const all = [DEMO, GSC, ASC, VERCEL];

  it("offers the real sources and the demo as one more card", () => {
    expect(sourceChoices(all).map((c) => c.id)).toEqual([
      "google-search-console",
      "app-store-connect",
      "vercel",
    ]);
    const html = renderI18n(
      <SourceStep workspaceId="w" connectors={all} hasDemo={false} />,
    );
    expect(html).toContain("Connect your first source");
    expect(html.match(/class="source-choice"/g)).toHaveLength(4);
    expect(html).toContain("Explore with demo data");
    expect(html).toContain("Skip, use demo data");
    // The first available source is selected, and the explainer and the
    // primary action speak about it.
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Search Console<\/span>/);
    expect(html).toContain("netrics asks Search Console for read-only access");
    expect(html).toContain("Continue with Search Console");
  });

  it("puts unavailable sources last, disabled, and never selects them", () => {
    const connectors = [
      DEMO,
      connector("gsc", "Search Console", "oauth2", false),
      VERCEL,
    ];
    expect(sourceChoices(connectors).map((c) => c.id)).toEqual([
      "vercel",
      "gsc",
    ]);
    const html = renderI18n(
      <SourceStep workspaceId="w" connectors={connectors} hasDemo />,
    );
    expect(html).toContain("Not set up on this installation");
    expect(html).toMatch(/aria-pressed="false" disabled=""/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Vercel<\/span>/);
    expect(html).toContain("with the key you enter in the next step");
  });

  it("falls back to the demo without real sources", () => {
    const html = renderI18n(
      <SourceStep workspaceId="w" connectors={[DEMO]} hasDemo />,
      "de",
    );
    expect(html).toContain("Mit Demodaten ausprobieren");
    expect(html).toContain("Schon in diesem Workspace");
    expect(html).toContain("Demodaten erzeugt netrics selbst");
    expect(html).toContain("Überspringen, Demodaten nutzen");
    expect(html).toContain(">Weiter</button>");
  });

  it("explains each kind of access", () => {
    expect([DEMO, GSC, ASC, VERCEL].map(sourceAccess)).toEqual([
      "demo",
      "oauth",
      "key",
      "key",
    ]);
    expect(sourceAccess(connector("rss", "RSS", "none"))).toBe("none");
  });
});

describe("screen step", () => {
  it("explains pairing and links to the approval page and the dashboard", () => {
    const html = renderI18n(
      <ScreenStep
        workspaceId="w"
        dashboardId="d"
        kioskUrl="app.example.com/kiosk"
        canManageDevices
        suggestSource
      />,
    );
    expect(html).toContain("Show it on a screen");
    expect(html).toContain('href="/kiosk">app.example.com/kiosk</a>');
    expect(html).toContain('href="/devices/approve"');
    expect(html).toContain('href="/workspaces/w/dashboards/d"');
    expect(html).toContain('href="/workspaces/w/welcome"');
    expect(html).toContain("Open my dashboard");
  });

  it("asks viewers to get an admin, and lists dashboards without one", () => {
    const html = renderI18n(
      <ScreenStep
        workspaceId="w"
        dashboardId={null}
        kioskUrl="x/kiosk"
        canManageDevices={false}
        suggestSource={false}
      />,
      "de",
    );
    expect(html).toContain("Bitte einen Inhaber oder Admin");
    expect(html).not.toContain("/devices/approve");
    expect(html).not.toContain("/welcome");
    expect(html).toContain('href="/workspaces/w/dashboards"');
  });
});

describe("new-connection wizard", () => {
  it("preselects the connector chosen in onboarding", () => {
    const html = renderI18n(
      <NewConnectionWizard
        workspaceId="w"
        connectors={[DEMO, VERCEL]}
        initialConnectorId="vercel"
      />,
    );
    const selected = [
      ...html.matchAll(
        /<article class="catalogue-card catalogue-card--selected"[\s\S]*?<\/article>/g,
      ),
    ].map((match) => match[0]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("Vercel");
  });
});
