import { describe, expect, it, vi } from "vitest";

import type {
  CustomApiDefinition,
  CustomApiDefinitionResponse,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ConnectDefinition, connectRequest } from "./connect-definition";
import { W } from "./test-fixtures";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Connect an existing custom API (#807), in English and German.

const LOCALES: Locale[] = ["en", "de"];

function definition(
  patch: Partial<CustomApiDefinition> = {},
): CustomApiDefinitionResponse["definition"] {
  return {
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
        {
          id: "staging",
          name: "Staging",
          baseUrl: "https://staging.example.test",
        },
      ],
      variables: [
        { id: "account_id", label: "Account ID", secret: false },
        { id: "signing_key", label: "Signing key", secret: true },
      ],
      auth: { type: "bearer", headerName: "Authorization", prefix: "Bearer" },
      defaults: { refreshMinutes: 60, timeZone: "UTC" },
      streams: [
        {
          key: "stats",
          name: "Stats",
          request: {
            path: "/accounts/{{account_id}}/stats",
            query: {},
            headers: {},
          },
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
      ...patch,
    },
  };
}

const render = (locale: Locale, value = definition()) =>
  renderI18n(
    <ConnectDefinition workspaceId={W} definition={value} projects={[]} />,
    locale,
  );

describe("connect an existing custom API", () => {
  it("connects with an environment, values and a token", () => {
    const body = connectRequest(definition(), {
      name: " Shop EU ",
      environmentId: "staging",
      values: { account_id: "42" },
      secrets: { token: "fx-bearer-token-0001", signing_key: "sk-0001" },
      projectId: null,
    });
    expect(body).toEqual({
      name: "Shop EU",
      environmentId: "staging",
      variables: { account_id: "42" },
      secretVariables: { signing_key: "sk-0001" },
      credentials: { token: "fx-bearer-token-0001" },
    });
    const html = render("en");
    expect(html).toContain(
      '<option value="staging">Staging (https://staging.example.test)</option>',
    );
    expect(html).toContain('value="Shop API (Production)"');
    expect(html).toContain(">Connect</button>");
  });

  it.each(LOCALES)(
    "hides the environment choice for a single environment (%s)",
    (locale) => {
      const one = definition({
        environments: [
          {
            id: "production",
            name: "Production",
            baseUrl: "https://api.example.test",
          },
        ],
      });
      const html = render(locale, one);
      expect(html).not.toContain("custom-api-connect-environment");
      expect(html).toContain('value="Shop API"');
      expect(html).toContain(
        locale === "en" ? ">Connect</button>" : ">Verbinden</button>",
      );
    },
  );

  it.each(LOCALES)(
    "asks for the secret connection values as secrets (%s)",
    (locale) => {
      const html = render(locale);
      expect(html).toMatch(
        /<label for="custom-api-connect-secret-signing_key">Signing key<\/label><input id="custom-api-connect-secret-signing_key" type="password"/,
      );
      expect(html).toMatch(
        /<label for="custom-api-connect-account_id">Account ID<\/label><input id="custom-api-connect-account_id" value=""/,
      );
      expect(html).toMatch(
        /id="custom-api-connect-secret-token" type="password"/,
      );
      expect(html).toContain(
        locale === "en" ? "Connection values" : "Verbindungswerte",
      );
    },
  );
});
