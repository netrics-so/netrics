import { describe, expect, it, vi } from "vitest";

import type { ConnectionDetail } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { EditConnectionForm } from "./edit-connection-form";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// A custom API connection (#808) is not in the connector catalogue: its
// form edits the name only; the login panel handles the login.

const W = "11111111-1111-4111-8111-111111111111";

function connection(customApi: boolean): ConnectionDetail {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "OAuth shop",
    connectorId: customApi ? "custom-api" : "unknown-connector",
    connectorName: "Shop API",
    connectorVersion: "1.0.1",
    projectId: null,
    hasCredentials: true,
    oauth: null,
    setupPending: true,
    customApi: customApi
      ? {
          definitionId: "22222222-2222-4222-8222-222222222222",
          version: 1,
          environmentId: "production",
          environmentName: "Production",
          currentVersion: 1,
          updateAvailable: false,
          loginMissing: false,
        }
      : null,
    config: {},
    signedKey: null,
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
    state: {
      health: "pending",
      authState: "ok",
      authReason: null,
      lastSuccessAt: null,
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 3600,
      rateLimitedUntil: null,
    },
  } as ConnectionDetail;
}

describe.each<Locale>(["en", "de"])("EditConnectionForm (%s)", (locale) => {
  it("edits only the name of a custom API connection", () => {
    const html = renderI18n(
      <EditConnectionForm
        workspaceId={W}
        connection={connection(true)}
        connector={undefined}
      />,
      locale,
    );
    expect(html).toContain('id="edit-name"');
    expect(html).not.toContain("custom-api");
    expect(html).not.toContain('id="edit-token"');
  });

  it("still names a missing bundled connector", () => {
    const html = renderI18n(
      <EditConnectionForm
        workspaceId={W}
        connection={connection(false)}
        connector={undefined}
      />,
      locale,
    );
    expect(html).toContain("unknown-connector");
  });
});
