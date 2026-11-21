import { describe, expect, it, vi } from "vitest";

import type { ConnectionDetail, CustomApiUpdatePlan } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  CustomApiConnectionLogin,
  saveConnectionLogin,
} from "./connection-login";
import {
  applyUpdateFlow,
  ConnectionUpdateReview,
  CustomApiUpdateBanner,
  updateReady,
} from "./connection-update-review";
import { W } from "./test-fixtures";
import { CustomApiUpdateError } from "@/lib/custom-api";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The update offer of a custom API connection (#808) and its login panel.

const LOCALES: Locale[] = ["en", "de"];
const C = "44444444-4444-4444-8444-444444444444";
const V1 = "55555555-5555-4555-8555-555555555555";
const V2 = "66666666-6666-4666-8666-666666666666";
const V3 = "77777777-7777-4777-8777-777777777777";

function plan(extra: Partial<CustomApiUpdatePlan> = {}): CustomApiUpdatePlan {
  return {
    connectionId: C,
    definitionId: "22222222-2222-4222-8222-222222222222",
    environmentId: "production",
    fromVersion: { id: V1, version: 1 },
    toVersion: { id: V2, version: 2 },
    changes: [
      {
        kind: "field_added",
        stream: "daily_stats",
        field: "revenue_currency",
      },
      { kind: "stream_removed", stream: "old" },
      { kind: "schedule_changed" },
    ],
    blockers: [],
    login: { carriesOver: true, reason: null, method: "bearer" },
    basis: V1,
    ...extra,
  };
}

const review = (locale: Locale, offer: CustomApiUpdatePlan) =>
  renderI18n(
    <ConnectionUpdateReview
      workspaceId={W}
      connectionId={C}
      initialPlan={offer}
      streamNames={{ daily_stats: "Daily stats", old: "Old stats" }}
      environments={[
        { id: "production", name: "Production", baseUrl: "https://a.test" },
        { id: "staging", name: "Staging", baseUrl: "https://b.test" },
      ]}
      variables={[{ id: "region", label: "Region", secret: false }]}
    />,
    locale,
  );

const inputs = { environmentId: "production", variables: {}, secrets: {} };

describe("ConnectionUpdateReview", () => {
  it.each(LOCALES)("lists the changes by data set (%s)", (locale) => {
    const html = review(locale, plan());
    expect(html).toContain(
      locale === "en"
        ? "Field revenue_currency in Daily stats is new."
        : "Das Feld revenue_currency in Daily stats ist neu.",
    );
    expect(html).toContain(
      locale === "en"
        ? "Old stats will stop updating. Its data stays."
        : "Old stats wird nicht mehr aktualisiert. Die Daten bleiben.",
    );
    expect(html).toContain(
      locale === "en"
        ? "The saved login stays."
        : "Die gespeicherte Anmeldung bleibt.",
    );
  });

  it.each(LOCALES)(
    "needs the blockers resolved before updating (%s)",
    (locale) => {
      const blocked = plan({
        blockers: [
          { code: "variable_required", variable: "region", secret: false },
          { code: "environment_removed", environment: "production" },
        ],
      });
      expect(updateReady(blocked, inputs)).toBe(false);
      expect(
        updateReady(blocked, { ...inputs, variables: { region: "eu" } }),
      ).toBe(false);
      expect(
        updateReady(blocked, {
          environmentId: "staging",
          variables: { region: "eu" },
          secrets: {},
        }),
      ).toBe(true);
      // A new login is left out or entered completely.
      expect(
        updateReady(plan(), { ...inputs, secrets: { username: "u" } }, [
          "username",
          "password",
        ]),
      ).toBe(false);
      const html = review(locale, blocked);
      const apply =
        locale === "en" ? "Update connection" : "Verbindung aktualisieren";
      expect(html).toMatch(
        new RegExp(
          `<button type="submit" class="primary" disabled="">${apply}`,
        ),
      );
      expect(html).toContain('id="custom-api-update-var-region"');
      expect(review(locale, plan())).toMatch(
        new RegExp(`<button type="submit" class="primary">${apply}`),
      );
    },
  );

  it.each(LOCALES)("says up front when the login is dropped (%s)", (locale) => {
    const html = review(
      locale,
      plan({
        login: { carriesOver: false, reason: "hosts_changed", method: "basic" },
      }),
    );
    expect(html).toContain(
      locale === "en"
        ? "you&#x27;ll need to enter the login again"
        : "Du musst die Anmeldung neu eingeben",
    );
    expect(html).toContain('id="custom-api-update-secret-password"');
    const oauth = review(
      locale,
      plan({
        login: {
          carriesOver: false,
          reason: "hosts_changed",
          method: "oauth_authorization_code",
        },
      }),
    );
    expect(oauth).toContain(
      locale === "en" ? "sign in again" : "melde dich neu an",
    );
    expect(oauth).not.toContain("custom-api-update-secret-");
  });

  it("reloads the plan when it is stale", async () => {
    const fresh = plan({ toVersion: { id: V3, version: 3 }, basis: V1 });
    const applyConnectionUpdate = vi.fn(async () => {
      throw new CustomApiUpdateError(409, "custom_api_update_stale", fresh, []);
    });
    await expect(
      applyUpdateFlow(
        { applyConnectionUpdate },
        { workspaceId: W, connectionId: C, plan: plan(), inputs },
      ),
    ).resolves.toEqual({ kind: "stale", plan: fresh });
    expect(applyConnectionUpdate).toHaveBeenCalledWith(W, C, {
      basis: V1,
      toVersionId: V2,
    });
  });

  it("sends the answers with the update", async () => {
    const applyConnectionUpdate = vi.fn(async () => ({
      connection: { customApi: { version: 2 } } as ConnectionDetail,
    }));
    await expect(
      applyUpdateFlow(
        { applyConnectionUpdate },
        {
          workspaceId: W,
          connectionId: C,
          plan: plan({
            blockers: [
              { code: "environment_removed", environment: "production" },
            ],
          }),
          inputs: {
            environmentId: "staging",
            variables: { region: "eu", empty: " " },
            secrets: { token: "abcd" },
          },
        },
      ),
    ).resolves.toEqual({ kind: "applied", version: 2 });
    expect(applyConnectionUpdate).toHaveBeenCalledWith(W, C, {
      basis: V1,
      toVersionId: V2,
      environmentId: "staging",
      variables: { region: "eu" },
      secrets: { token: "abcd" },
    });
  });

  it.each(LOCALES)(
    "shows the update banner on the connection page (%s)",
    (locale) => {
      const html = renderI18n(
        <CustomApiUpdateBanner
          workspaceId={W}
          connectionId={C}
          name="Shop API"
          version={2}
          canUpdate
        />,
        locale,
      );
      expect(html).toContain(
        locale === "en"
          ? "A newer version of Shop API is available (version 2)."
          : "Eine neuere Version von Shop API ist verfügbar (Version 2).",
      );
      expect(html).toContain(
        `href="/workspaces/${W}/connections/${C}/custom-api-update"`,
      );
    },
  );
});

describe("the connection's login", () => {
  const detail = (authState: string) =>
    ({ state: { authState } }) as unknown as ConnectionDetail;

  it("changes an OAuth client and asks for a sign-in after a new client ID", async () => {
    const updateConnection = vi.fn(async () => ({
      connection: detail("needs_reauthorization"),
    }));
    const startCustomOAuth = vi.fn();
    await expect(
      saveConnectionLogin(
        { updateConnection, startCustomOAuth },
        {
          workspaceId: W,
          connectionId: C,
          method: "oauth_authorization_code",
          secretVariableIds: [],
          values: { clientId: "new-client", clientSecret: "secret-1" },
        },
      ),
    ).resolves.toMatchObject({ needsSignIn: true });
    expect(updateConnection).toHaveBeenCalledWith(W, C, {
      credentials: { clientId: "new-client", clientSecret: "secret-1" },
    });
    // A rotated secret of the same client keeps the grant.
    updateConnection.mockResolvedValueOnce({ connection: detail("ok") });
    await expect(
      saveConnectionLogin(
        { updateConnection, startCustomOAuth },
        {
          workspaceId: W,
          connectionId: C,
          method: "oauth_authorization_code",
          secretVariableIds: [],
          values: { clientId: "new-client", clientSecret: "secret-2" },
        },
      ),
    ).resolves.toMatchObject({ needsSignIn: false });
  });

  it("enters a dropped login with its secret values", async () => {
    const updateConnection = vi.fn(async () => ({ connection: detail("ok") }));
    await saveConnectionLogin(
      { updateConnection, startCustomOAuth: vi.fn() },
      {
        workspaceId: W,
        connectionId: C,
        method: "bearer",
        secretVariableIds: ["tenant"],
        values: { token: "token-1", tenant: "tenant-1" },
      },
    );
    expect(updateConnection).toHaveBeenCalledWith(W, C, {
      credentials: { token: "token-1" },
      secretVariables: { tenant: "tenant-1" },
    });
  });

  it.each(LOCALES)("asks for a dropped login again (%s)", (locale) => {
    const connection = {
      id: C,
      state: { authState: "auth_failed" },
      customApi: { loginMissing: true },
    } as unknown as ConnectionDetail;
    const html = renderI18n(
      <CustomApiConnectionLogin
        workspaceId={W}
        connection={connection}
        method="basic"
        variables={[]}
      />,
      locale,
    );
    expect(html).toContain(
      locale === "en"
        ? "This connection has no login for its current version."
        : "Diese Verbindung hat keine Anmeldung für ihre aktuelle Version.",
    );
    expect(html).toContain('id="custom-api-connection-secret-username"');
    expect(html).toContain('id="custom-api-connection-secret-password"');
  });
});
