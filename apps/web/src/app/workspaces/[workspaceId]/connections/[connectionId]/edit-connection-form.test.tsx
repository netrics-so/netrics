import { describe, expect, it, vi } from "vitest";

import type { ConnectionDetail } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  EditConnectionForm,
  customApiConfigFields,
  editConnectionRequest,
} from "./edit-connection-form";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// A custom API connection (#808) is not in the connector catalogue: its
// form edits the name and its pinned version's plain values (#830); the
// login panel handles the login and the secret values.

const W = "11111111-1111-4111-8111-111111111111";

const VARIABLES = [
  { id: "account_id", label: "Account", secret: false },
  { id: "tenant", label: "Tenant secret", secret: true },
];

function connection(
  customApi: boolean,
  config: Record<string, unknown> = {},
): ConnectionDetail {
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
    config,
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

  it("edits the plain values of a custom API connection, never the secret ones", () => {
    const html = renderI18n(
      <EditConnectionForm
        workspaceId={W}
        connection={connection(true, { account_id: "acc-1" })}
        connector={undefined}
        customApiVariables={VARIABLES}
      />,
      locale,
    );
    expect(html).toContain('id="config-account_id"');
    expect(html).toContain('value="acc-1"');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain(">Account<");
    expect(html).not.toContain("config-tenant");
    expect(html).not.toContain("custom-api");
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

describe("editConnectionRequest (#830)", () => {
  const fields = customApiConfigFields(VARIABLES);
  const base = {
    name: "OAuth shop",
    fields,
    token: "",
    fixedConfig: false,
  };

  it("describes only the plain values, each required", () => {
    expect(
      fields.map((field) => [
        field.key,
        field.required,
        field.minLength,
        field.maxLength,
      ]),
    ).toEqual([["account_id", true, 1, 500]]);
  });

  it("sends a custom API connection's changed values", () => {
    expect(
      editConnectionRequest({
        ...base,
        connection: connection(true, { account_id: "acc-1" }),
        configValues: { account_id: "acc-2" },
      }),
    ).toEqual({ config: { account_id: "acc-2" } });
  });

  it("sends no values with a name change when they are unchanged", () => {
    expect(
      editConnectionRequest({
        ...base,
        name: "Renamed",
        connection: connection(true, { account_id: "acc-1" }),
        configValues: { account_id: "acc-1" },
      }),
    ).toEqual({ name: "Renamed" });
    // Without plain values (or the pinned version), only the name.
    expect(
      editConnectionRequest({
        ...base,
        fields: [],
        name: "Renamed",
        connection: connection(true),
        configValues: {},
      }),
    ).toEqual({ name: "Renamed" });
  });

  it("keeps sending a catalogue connector's config as before", () => {
    expect(
      editConnectionRequest({
        ...base,
        fields: [],
        connection: connection(false),
        configValues: {},
      }),
    ).toEqual({ config: {} });
  });
});
