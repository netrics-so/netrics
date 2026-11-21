import { afterEach, describe, expect, it, vi } from "vitest";

import {
  oauthCallbackOutcomeSchema,
  type CustomApiAuth,
  type CustomApiDraft,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { CustomApiBuilder } from "./builder";
import { enterStep, syncDraft, type BuilderClient } from "./builder-actions";
import { StepBasics } from "./step-basics";
import { defaultAuth, OAuthSignIn, StepLogin } from "./step-login";
import { BuilderOAuthOutcome } from "./oauth-outcome";
import { D, DRAFT, W } from "./test-fixtures";
import { startCustomOAuth } from "@/lib/custom-api";
import {
  emptyBuilderState,
  type BuilderState,
  type BuilderStep,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The builder's shell, Basics and Login (#807), in English and German.

const TOKEN = "fx-bearer-token-0001";
const LOCALES: Locale[] = ["en", "de"];

function basics(baseUrl = "https://api.example.test"): BuilderState {
  return {
    ...emptyBuilderState("en", "Europe/Berlin"),
    name: "Shop API",
    environments: [{ id: "production", name: "Production", baseUrl }],
  };
}

function mockClient(draft: Partial<CustomApiDraft> = {}) {
  const answer = { ...DRAFT, secretsSet: [], ...draft };
  return {
    createDraft: vi.fn(async () => answer),
    updateDraft: vi.fn(async () => answer),
    deleteDraft: vi.fn(async () => {}),
    testDraft: vi.fn(),
    promoteDraft: vi.fn(),
    createDefinition: vi.fn(),
    saveDefinitionVersion: vi.fn(),
  } satisfies Record<keyof BuilderClient, unknown>;
}

const continueButton = (html: string) =>
  /<button type="button" class="primary"( disabled="")?>(Continue|Weiter)<\/button>/.exec(
    html,
  );

function renderBuilder(
  locale: Locale,
  state: BuilderState,
  step: { step?: BuilderStep } = {},
  api = mockClient(),
) {
  return renderI18n(
    <CustomApiBuilder
      workspaceId={W}
      canEdit
      projects={[]}
      initial={{ state, ...step }}
      api={api as unknown as BuilderClient}
    />,
    locale,
  );
}

function renderLogin(locale: Locale, state: BuilderState, secretsLost = false) {
  return renderI18n(
    <StepLogin
      state={state}
      update={() => {}}
      workspaceId={W}
      draftId={D}
      secretsLost={secretsLost}
      pending={false}
      onSaveSecrets={async () => true}
      onSignIn={() => {}}
    />,
    locale,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("custom API builder: Basics and Login", () => {
  it.each(LOCALES)(
    "walks Basics with an https base URL only (%s)",
    (locale) => {
      const http = renderBuilder(locale, basics("http://api.example.test"));
      expect(continueButton(http)?.[1]).toBe(' disabled=""');
      expect(http).toContain(
        locale === "en"
          ? "The base URL starts with https:// and names a host."
          : "Die Basis-URL beginnt mit https:// und nennt einen Host.",
      );
      const https = renderBuilder(locale, basics());
      expect(continueButton(https)).not.toBeNull();
      expect(continueButton(https)?.[1]).toBeUndefined();
      expect(https).toContain(
        locale === "en" ? "Starts with https://." : "Beginnt mit https://.",
      );
      // The stepper names all six steps.
      for (const step of locale === "en"
        ? [
            "Basics",
            "Login",
            "Request",
            "Response",
            "Paging and time window",
            "Schedule and review",
          ]
        : [
            "Grundlagen",
            "Anmeldung",
            "Anfrage",
            "Antwort",
            "Seiten und Zeitraum",
            "Zeitplan und Prüfung",
          ])
        expect(https).toContain(step);
    },
  );

  it("creates the draft on entering Login, not on load", async () => {
    const api = mockClient();
    renderBuilder("en", basics(), {}, api);
    expect(api.createDraft).not.toHaveBeenCalled();
    // Browsing Basics creates nothing either.
    const stay = await enterStep(api, {
      workspaceId: W,
      draftId: null,
      state: basics(),
      target: "basics",
    });
    expect(stay.draftId).toBeNull();
    expect(api.createDraft).not.toHaveBeenCalled();
    const login = await enterStep(api, {
      workspaceId: W,
      draftId: null,
      state: basics(),
      target: "login",
    });
    expect(login.draftId).toBe(D);
    expect(api.createDraft).toHaveBeenCalledTimes(1);
    // The draft holds the definition from then on, without secrets.
    expect(api.updateDraft).toHaveBeenCalledWith(W, D, {
      definition: expect.objectContaining({ name: "Shop API" }),
      environmentId: "production",
      variables: {},
    });
    await enterStep(api, {
      workspaceId: W,
      draftId: D,
      state: basics(),
      target: "request",
    });
    expect(api.createDraft).toHaveBeenCalledTimes(1);
  });

  it.each(LOCALES)(
    "sends a secret once and never renders it again (%s)",
    async (locale) => {
      const api = mockClient({ secretsSet: ["token"] });
      const state: BuilderState = { ...basics(), auth: defaultAuth("bearer") };
      const synced = await syncDraft(api, W, D, state, { token: TOKEN });
      expect(api.updateDraft).toHaveBeenCalledWith(
        W,
        D,
        expect.objectContaining({ secrets: { token: TOKEN } }),
      );
      expect(synced.state.secretsSet).toEqual(["token"]);
      expect(JSON.stringify(synced.state)).not.toContain(TOKEN);
      const html = renderLogin(locale, synced.state);
      expect(html).not.toContain(TOKEN);
      expect(html).toContain(
        locale === "en"
          ? "Saved. netrics keeps it encrypted and never shows it again."
          : "Gespeichert. netrics bewahrt es verschlüsselt auf und zeigt es nie wieder an.",
      );
      expect(html).toContain(locale === "en" ? ">Replace<" : ">Ersetzen<");
      // The whole builder on the Login step: no token, and Continue open.
      const builder = renderBuilder(locale, synced.state, { step: "login" });
      expect(builder).not.toContain(TOKEN);
      expect(continueButton(builder)?.[1]).toBeUndefined();
    },
  );

  it.each(LOCALES)(
    "asks for the login again when the base URL host changes (%s)",
    async (locale) => {
      const stored: BuilderState = {
        ...basics(),
        auth: defaultAuth("bearer"),
        secretsSet: ["token"],
      };
      // Before the change, Basics says what it does.
      const warned = renderI18n(
        <StepBasics state={stored} update={() => {}} projects={[]} />,
        locale,
      );
      expect(warned).toContain(
        locale === "en"
          ? "Changing this address deletes the saved login."
          : "Wenn du diese Adresse änderst, wird die gespeicherte Anmeldung gelöscht.",
      );
      // The draft forgets the token for the new host.
      const api = mockClient({ secretsSet: [] });
      const moved = await syncDraft(api, W, D, {
        ...stored,
        environments: [
          {
            id: "production",
            name: "Production",
            baseUrl: "https://other.example.test",
          },
        ],
      });
      expect(moved.secretsLost).toBe(true);
      expect(moved.state.secretsSet).toEqual([]);
      const html = renderLogin(locale, moved.state, moved.secretsLost);
      expect(html).toContain(
        locale === "en"
          ? "You changed where netrics sends your login. Enter it again."
          : "Du hast geändert, wohin netrics deine Anmeldung sendet. Gib sie erneut ein.",
      );
      expect(html).toMatch(/type="password"/);
    },
  );

  it("shows only the inputs the chosen method needs", () => {
    const inputsOf = (auth: CustomApiAuth) => {
      const html = renderLogin("en", { ...basics(), auth });
      return [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
    };
    expect(inputsOf(defaultAuth("none"))).toEqual([]);
    expect(inputsOf(defaultAuth("api_key"))).toEqual([
      "custom-api-key-name",
      "custom-api-secret-apiKey",
    ]);
    expect(inputsOf(defaultAuth("bearer"))).toEqual([
      "custom-api-bearer-header",
      "custom-api-bearer-prefix",
      "custom-api-secret-token",
    ]);
    expect(inputsOf(defaultAuth("basic"))).toEqual([
      "custom-api-secret-username",
      "custom-api-secret-password",
    ]);
    expect(inputsOf(defaultAuth("oauth_client_credentials"))).toEqual([
      "custom-api-token-url",
      "custom-api-scopes",
      "custom-api-secret-clientId",
      "custom-api-secret-clientSecret",
    ]);
    expect(inputsOf(defaultAuth("oauth_authorization_code"))).toEqual([
      "custom-api-authorize-url",
      "custom-api-token-url",
      "custom-api-revoke-url",
      "custom-api-scopes",
      "custom-api-secret-clientId",
      "custom-api-secret-clientSecret",
    ]);
    const de = renderLogin("de", { ...basics(), auth: defaultAuth("api_key") });
    expect(de).toContain("Wie meldet sich die API an?");
    expect(de).toContain("Query-Parameter");
  });

  it.each(LOCALES)(
    "shows the redirect URL and starts the OAuth sign-in for the draft (%s)",
    async (locale) => {
      const redirect = "https://app.example.test/oauth/custom/callback";
      const html = renderI18n(
        <OAuthSignIn
          workspaceId={W}
          ready
          pending={false}
          onSignIn={() => {}}
          redirectUri={redirect}
        />,
        locale,
      );
      expect(html).toContain(`<code>${redirect}</code>`);
      expect(html).toContain(
        locale === "en"
          ? "netrics can&#x27;t register an app for an API it doesn&#x27;t know."
          : "netrics kann keine App für eine API registrieren, die es nicht kennt.",
      );
      expect(html).toMatch(
        locale === "en" ? />Sign in<\/button>/ : />Anmelden<\/button>/,
      );
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              authorizationUrl: "https://auth.example.test/authorize?state=s",
              // C-G4 adds "authorize" for drafts; "reauthorize" exists today.
              purpose: "reauthorize",
              expiresAt: "2026-11-21T12:10:00.000Z",
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetch);
      const started = await startCustomOAuth(W, D);
      expect(started.authorizationUrl).toContain("auth.example.test");
      const [path, init] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(path).toBe(`/v1/workspaces/${W}/oauth/authorizations`);
      expect(JSON.parse(init.body as string)).toEqual({
        connectorId: "custom-api",
        connectionId: D,
      });
    },
  );

  it.each(LOCALES)(
    "says how the draft's sign-in ended, for every outcome (%s)",
    (locale) => {
      const seen = new Set<string>();
      for (const outcome of oauthCallbackOutcomeSchema.options) {
        const html = renderI18n(
          <BuilderOAuthOutcome outcome={outcome} />,
          locale,
        );
        const ok = outcome === "connected" || outcome === "reauthorized";
        expect(html).toContain(ok ? 'role="status"' : 'role="alert"');
        seen.add(html);
      }
      expect(seen.size).toBe(oauthCallbackOutcomeSchema.options.length);
      expect(renderI18n(<BuilderOAuthOutcome outcome={null} />, locale)).toBe(
        "",
      );
      // Before a change that ends the sign-in, Login says so.
      const html = renderLogin(locale, {
        ...basics(),
        auth: defaultAuth("oauth_authorization_code"),
        secretsSet: ["clientId", "clientSecret"],
      });
      expect(html).toContain(
        locale === "en"
          ? "Changing the URLs, the client ID or the client secret ends the sign-in."
          : "Wenn du die URLs, die Client-ID oder das Client-Secret änderst, endet die Anmeldung.",
      );
    },
  );

  it.each(LOCALES)("shows a read-only summary to viewers (%s)", (locale) => {
    const api = mockClient();
    const html = renderI18n(
      <CustomApiBuilder
        workspaceId={W}
        canEdit={false}
        projects={[]}
        api={api as unknown as BuilderClient}
        definition={{
          id: "33333333-3333-4333-8333-333333333333",
          name: "Shop API",
          projectId: null,
          currentVersion: 2,
          archivedAt: null,
          connectionCount: 1,
          createdAt: "2026-11-01T10:00:00.000Z",
          updatedAt: "2026-11-02T10:00:00.000Z",
          datasetVersions: { stats: 1 },
          document: {
            schemaVersion: 1,
            name: "Shop API",
            environments: [
              {
                id: "production",
                name: "Production",
                baseUrl: "https://api.example.test",
              },
            ],
            variables: [],
            auth: {
              type: "bearer",
              headerName: "Authorization",
              prefix: "Bearer",
            },
            defaults: { refreshMinutes: 60, timeZone: "UTC" },
            streams: [
              {
                key: "stats",
                name: "Stats",
                request: { path: "/stats", query: {}, headers: {} },
                pagination: { type: "none" },
                records: "data",
                fields: [
                  {
                    id: "day",
                    name: "Day",
                    path: "date",
                    type: "date",
                    nullable: false,
                    classification: "internal",
                  },
                ],
                keyFields: ["day"],
                mode: "upsert",
                window: { type: "none" },
                retentionDays: null,
              },
            ],
          },
        }}
      />,
      locale,
    );
    expect(html).toContain(
      locale === "en"
        ? "You can view this custom API."
        : "Du kannst diese eigene API ansehen.",
    );
    expect(html).toContain("https://api.example.test");
    expect(html).toContain(
      locale === "en" ? "Login: Bearer token" : "Anmeldung: Bearer-Token",
    );
    expect(html).not.toContain("<input");
    expect(api.createDraft).not.toHaveBeenCalled();
  });
});
