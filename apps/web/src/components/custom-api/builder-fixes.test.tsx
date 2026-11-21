import { describe, expect, it, vi } from "vitest";

import type {
  CustomApiDefinitionResponse,
  CustomApiDraft,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { CustomApiBuilder } from "./builder";
import {
  builderErrorMessage,
  enterStep,
  saveAndConnect,
  startSignIn,
  type BuilderClient,
} from "./builder-actions";
import { connectAndSignIn } from "./connect-definition";
import { defaultAuth } from "./step-login";
import { TestPanel } from "./test-panel";
import { D, DRAFT, TEST_RESPONSE, W } from "./test-fixtures";
import { CustomApiRequestError } from "@/lib/custom-api";
import {
  definitionOf,
  emptyBuilderState,
  pickRecords,
  stateFromDefinition,
  stepIssues,
  toggleField,
  withRequest,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Review fixes of #824: sign-in order, edit mode without credentials, the
// stale basis after a reload, connect retry, and the panel's messages.

const LOCALES: Locale[] = ["en", "de"];
const DEFINITION_ID = "33333333-3333-4333-8333-333333333333";

function ready(): BuilderState {
  let state: BuilderState = {
    ...emptyBuilderState("en", "UTC"),
    name: "Shop API",
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: "https://api.example.test",
      },
    ],
    auth: defaultAuth("bearer"),
  };
  state = pickRecords(withRequest(state, { path: "/builder/stats" }), "data");
  state = toggleField(
    state,
    {
      path: "date",
      id: "date",
      name: "Date",
      type: "date",
      nullable: false,
      samples: [],
    },
    true,
  );
  return state;
}

function saved(version: number): CustomApiDefinitionResponse["definition"] {
  return {
    id: DEFINITION_ID,
    name: "Shop API",
    projectId: null,
    currentVersion: version,
    archivedAt: null,
    connectionCount: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    datasetVersions: { records: 1 },
    document: definitionOf(ready()),
  };
}

function client(draft: Partial<CustomApiDraft> = {}) {
  const calls: string[] = [];
  const answer = { ...DRAFT, ...draft };
  const track = <T,>(name: string, value: () => T) =>
    vi.fn(async () => {
      calls.push(name);
      return value();
    });
  const api = {
    createDraft: track("createDraft", () => answer),
    updateDraft: track("updateDraft", () => answer),
    deleteDraft: track("deleteDraft", () => undefined),
    testDraft: track("testDraft", () => TEST_RESPONSE),
    promoteDraft: track("promoteDraft", () => ({ connectionId: D })),
    createDefinition: track("createDefinition", () => ({
      definition: saved(1),
    })),
    saveDefinitionVersion: track("saveDefinitionVersion", () => ({
      definition: saved(4),
    })),
    startCustomOAuth: track("startCustomOAuth", () => ({
      authorizationUrl: "https://auth.example.test/authorize?state=s",
      purpose: "reauthorize" as const,
      expiresAt: "2026-11-21T12:10:00.000Z",
    })),
  };
  return { api: api as unknown as BuilderClient, raw: api, calls };
}

describe("custom API builder review fixes", () => {
  it("stores the current definition on the draft before the sign-in starts", async () => {
    const { api, raw, calls } = client({
      secretsSet: ["clientId", "clientSecret"],
    });
    const state: BuilderState = {
      ...ready(),
      auth: {
        ...defaultAuth("oauth_authorization_code"),
        authorizeUrl: "https://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
      } as BuilderState["auth"],
      secretsSet: ["clientId", "clientSecret"],
    };
    const started = await startSignIn(api, {
      workspaceId: W,
      draftId: D,
      state,
    });
    expect(calls).toEqual(["updateDraft", "startCustomOAuth"]);
    expect(raw.updateDraft).toHaveBeenCalledWith(
      W,
      D,
      expect.objectContaining({
        definition: expect.objectContaining({
          auth: expect.objectContaining({
            tokenUrl: "https://auth.example.test/token",
          }),
        }),
      }),
    );
    expect(started).toMatchObject({ kind: "redirect" });
  });

  it("starts no sign-in when the update forgot the saved client", async () => {
    const { api, calls } = client({ secretsSet: [] });
    const started = await startSignIn(api, {
      workspaceId: W,
      draftId: D,
      state: { ...ready(), secretsSet: ["clientId", "clientSecret"] },
    });
    expect(started.kind).toBe("secretsLost");
    expect(calls).toEqual(["updateDraft"]);
  });

  it.each(LOCALES)(
    "edits a saved definition without credentials (%s)",
    async (locale) => {
      const definition = saved(3);
      const state = stateFromDefinition(definition.document);
      // Login and Request don't gate on secrets while editing.
      expect(stepIssues(state, "login", { editing: true })).toEqual([]);
      expect(stepIssues(state, "login")).toEqual(["issues.secretMissing"]);
      const html = renderI18n(
        <CustomApiBuilder
          workspaceId={W}
          definition={definition}
          canEdit
          projects={[]}
          initial={{ state, step: "login" }}
          api={client().api}
        />,
        locale,
      );
      expect(html).toMatch(/class="primary">(Continue|Weiter)</);
      expect(html).toContain(
        locale === "en"
          ? "To send a test request, enter and save the login."
          : "Für eine Testanfrage gibst du die Anmeldung ein",
      );
      // Moving through the steps creates no draft.
      const { api, calls } = client();
      const moved = await enterStep(api, {
        workspaceId: W,
        draftId: null,
        definitionId: DEFINITION_ID,
        state,
        target: "review",
        createDraft: false,
      });
      expect(moved.draftId).toBeNull();
      // A schedule-only change saves without any token or draft.
      const result = await saveAndConnect(api, {
        workspaceId: W,
        draftId: null,
        state: {
          ...state,
          defaults: { ...state.defaults, refreshMinutes: 30 },
        },
        editing: {
          id: DEFINITION_ID,
          currentVersion: 3,
          document: definition.document,
        },
      });
      expect(result).toEqual({ kind: "saved", definitionId: DEFINITION_ID });
      expect(calls).toEqual(["saveDefinitionVersion"]);
    },
  );

  it("saves a typed, unsaved secret when moving on", async () => {
    const { api, raw } = client({ secretsSet: ["token"] });
    const moved = await enterStep(api, {
      workspaceId: W,
      draftId: D,
      state: { ...ready(), secretsSet: ["token"] },
      target: "request",
      secrets: { token: "replacement-token" },
    });
    expect(raw.updateDraft).toHaveBeenCalledWith(
      W,
      D,
      expect.objectContaining({ secrets: { token: "replacement-token" } }),
    );
    expect(moved.state.secretsSet).toEqual(["token"]);
    // Editing: a typed secret creates the draft it is saved on.
    const editing = client({ secretsSet: ["token"] });
    const created = await enterStep(editing.api, {
      workspaceId: W,
      draftId: null,
      state: ready(),
      target: "request",
      createDraft: false,
      secrets: { token: "replacement-token" },
    });
    expect(created.draftId).toBe(D);
    expect(editing.calls).toEqual(["createDraft", "updateDraft"]);
  });

  it("keeps the loaded version as the basis after a reload, so a newer save is stale", async () => {
    const { api, raw } = client();
    (
      raw.saveDefinitionVersion as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(
      new CustomApiRequestError(409, "custom_api_definition_stale"),
    );
    // The page now has version 4; the restored editor state was made on 3.
    const definition = saved(4);
    await expect(
      saveAndConnect(api, {
        workspaceId: W,
        draftId: D,
        state: ready(),
        editing: {
          id: DEFINITION_ID,
          currentVersion: 3,
          document: definition.document,
        },
      }),
    ).rejects.toMatchObject({ code: "custom_api_definition_stale" });
    expect(raw.saveDefinitionVersion).toHaveBeenCalledWith(
      W,
      DEFINITION_ID,
      expect.objectContaining({ baseVersion: 3 }),
    );
  });

  it("signs in the connection created before instead of creating another", async () => {
    const connectDefinition = vi.fn(async () => ({ connection: { id: D } }));
    const startCustomOAuth = vi
      .fn()
      .mockRejectedValueOnce(new CustomApiRequestError(500, "request_failed"))
      .mockResolvedValueOnce({
        authorizationUrl: "https://auth.example.test/a",
      });
    const api = { connectDefinition, startCustomOAuth } as never;
    let created: string | null = null;
    const input = {
      workspaceId: W,
      definitionId: DEFINITION_ID,
      oauth: true,
      body: {
        name: "Shop",
        environmentId: "production",
        variables: {},
        secretVariables: {},
        credentials: { clientId: "c", clientSecret: "secret-1" },
      },
      onCreated: (id: string) => (created = id),
    };
    await expect(
      connectAndSignIn(api, { ...input, connectionId: null }),
    ).rejects.toBeInstanceOf(CustomApiRequestError);
    expect(created).toBe(D);
    const retry = await connectAndSignIn(api, {
      ...input,
      connectionId: created,
    });
    expect(retry).toEqual({
      connectionId: D,
      authorizationUrl: "https://auth.example.test/a",
    });
    expect(connectDefinition).toHaveBeenCalledTimes(1);
  });

  it.each(LOCALES)(
    "shows the wait of a rate-limited test, a shortened answer and the missing secrets (%s)",
    (locale) => {
      expect(
        builderErrorMessage(
          new CustomApiRequestError(
            429,
            "custom_api_test_rate_limited",
            [],
            42,
          ),
          locale,
        ),
      ).toBe(
        locale === "en"
          ? "Too many test requests. Try again in 42 seconds."
          : "Zu viele Testanfragen. Versuch es in 42 Sekunden erneut.",
      );
      const truncated = renderI18n(
        <TestPanel
          test={{ ...TEST_RESPONSE, truncated: true }}
          error={null}
          pending={false}
        />,
        locale,
      );
      expect(truncated).toContain(
        locale === "en"
          ? "Shortened for the preview. Everything is read when the connection syncs."
          : "Für die Vorschau gekürzt.",
      );
      const missing = renderI18n(
        <TestPanel
          test={{
            ...TEST_RESPONSE,
            ok: false,
            error: { code: "custom_api_secret_missing", message: "x" },
          }}
          error={null}
          pending={false}
          missingSecrets={["Signing key"]}
        />,
        locale,
      );
      expect(missing).toContain(
        locale === "en"
          ? "Enter and save first: Signing key."
          : "Gib zuerst ein und speichere: Signing key.",
      );
    },
  );
});
