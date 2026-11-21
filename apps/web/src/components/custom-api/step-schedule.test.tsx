import { describe, expect, it, vi } from "vitest";

import type {
  CustomApiDefinitionResponse,
  CustomApiTestResponse,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { runTest, saveAndConnect, type BuilderClient } from "./builder-actions";
import { fetchedOf, StepPaging } from "./step-paging";
import { StepSchedule } from "./step-schedule";
import { D, DRAFT, TEST_RESPONSE, W } from "./test-fixtures";
import { CustomApiRequestError } from "@/lib/custom-api";
import {
  definitionOf,
  emptyBuilderState,
  pickRecords,
  toggleField,
  withRequest,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Paging and time window, Schedule and review, save and connect (#807).

const LOCALES: Locale[] = ["en", "de"];
const DEFINITION_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";

function ready(): BuilderState {
  let state: BuilderState = {
    ...emptyBuilderState("en", "Europe/Berlin"),
    name: "Shop API",
    environments: [
      {
        id: "production",
        name: "Production",
        baseUrl: "https://api.example.test",
      },
    ],
    auth: { type: "bearer", headerName: "Authorization", prefix: "Bearer" },
    secretsSet: ["token"],
  };
  state = withRequest(state, {
    path: "/builder/stats",
    query: [
      { key: "from", value: "{{window.start}}" },
      { key: "to", value: "{{window.end}}" },
    ],
  });
  state = pickRecords(state, "data");
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
  state = toggleField(
    state,
    {
      path: "orders",
      id: "orders",
      name: "Orders",
      type: "integer",
      nullable: false,
      samples: [],
    },
    true,
  );
  return {
    ...state,
    stream: {
      ...state.stream,
      pagination: { type: "cursor", cursorPath: "meta.next", param: "cursor" },
    },
  };
}

const saved = (version = 1): CustomApiDefinitionResponse => ({
  definition: {
    id: DEFINITION_ID,
    name: "Shop API",
    projectId: null,
    currentVersion: version,
    archivedAt: null,
    connectionCount: 0,
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
    document: definitionOf(ready()),
    datasetVersions: { records: 1 },
  },
});

function client(overrides: Partial<Record<keyof BuilderClient, unknown>> = {}) {
  const calls: string[] = [];
  const track = <T,>(name: string, answer: () => T) =>
    vi.fn(async () => {
      calls.push(name);
      return answer();
    });
  const api = {
    createDraft: track("createDraft", () => DRAFT),
    updateDraft: track("updateDraft", () => DRAFT),
    deleteDraft: track("deleteDraft", () => undefined),
    testDraft: track("testDraft", () => TEST_RESPONSE),
    promoteDraft: track("promoteDraft", () => ({
      connectionId: CONNECTION_ID,
    })),
    createDefinition: track("createDefinition", () => saved()),
    saveDefinitionVersion: track("saveDefinitionVersion", () => saved(4)),
    ...overrides,
  };
  return {
    api: api as unknown as BuilderClient &
      Record<string, ReturnType<typeof vi.fn>>,
    calls,
  };
}

const TWO_PAGES: CustomApiTestResponse = {
  ...TEST_RESPONSE,
  log: [1, 2].map((page) => ({
    page,
    method: "GET" as const,
    url: `https://api.example.test/builder/stats?page=${page}`,
    status: 200,
    durationMs: 10,
    bytes: 200,
    records: 3,
  })),
};

describe("custom API builder: Paging, Schedule and save", () => {
  it.each(LOCALES)(
    "tests up to five pages and reports pages and records (%s)",
    async (locale) => {
      const { api } = client({ testDraft: vi.fn(async () => TWO_PAGES) });
      const tested = await runTest(api, W, D, ready(), 5);
      expect(api.testDraft).toHaveBeenCalledWith(
        W,
        D,
        expect.objectContaining({
          pages: 5,
          definition: expect.objectContaining({
            stream: expect.objectContaining({
              pagination: {
                type: "cursor",
                cursorPath: "meta.next",
                param: "cursor",
              },
            }),
          }),
        }),
      );
      expect(fetchedOf(tested.state.lastTest!)).toEqual({
        pages: 2,
        records: 6,
      });
      const html = renderI18n(
        <StepPaging
          state={tested.state}
          update={() => {}}
          pending={false}
          pagingTest={tested.state.lastTest}
          onTest={() => {}}
        />,
        locale,
      );
      expect(html).toContain(
        locale === "en"
          ? "Fetched 2 pages and 6 records."
          : "2 Seiten und 6 Einträge abgerufen.",
      );
      expect(html).toMatch(
        locale === "en" ? />Test paging</ : />Seiten testen</,
      );
    },
  );

  it.each(LOCALES)("offers the window placeholders' formats (%s)", (locale) => {
    const html = renderI18n(
      <StepPaging
        state={ready()}
        update={() => {}}
        pending={false}
        pagingTest={null}
        onTest={() => {}}
      />,
      locale,
    );
    const formats =
      locale === "en"
        ? [
            "ISO date (2026-11-21)",
            "ISO timestamp",
            "Unix seconds",
            "Unix milliseconds",
          ]
        : [
            "ISO-Datum (2026-11-21)",
            "ISO-Zeitstempel",
            "Unix-Sekunden",
            "Unix-Millisekunden",
          ];
    for (const format of formats) expect(html).toContain(format);
    // The request uses the window, so it got a date window.
    expect(html).toMatch(/name="custom-api-window" checked=""/);
  });

  it.each(LOCALES)(
    "saves the definition and promotes the draft to the first connection (%s)",
    async (locale) => {
      const { api, calls } = client();
      const result = await saveAndConnect(api, {
        workspaceId: W,
        draftId: D,
        state: ready(),
      });
      expect(calls).toEqual(["createDefinition", "promoteDraft"]);
      expect(result).toEqual({
        kind: "connected",
        connectionId: CONNECTION_ID,
      });
      expect(api.promoteDraft).toHaveBeenCalledWith(W, D, {
        definitionId: DEFINITION_ID,
        version: 1,
        name: "Shop API",
        projectId: null,
      });
      const document = (
        vi.mocked(api.createDefinition).mock.calls[0] as unknown as [
          string,
          { document: unknown },
        ]
      )[1].document;
      expect(JSON.stringify(document)).not.toContain('token":');
      const html = renderI18n(
        <StepSchedule state={ready()} update={() => {}} onGoTo={() => {}} />,
        locale,
      );
      expect(html).toContain(
        locale === "en"
          ? "netrics will send requests to api.example.test."
          : "netrics sendet Anfragen an api.example.test.",
      );
      expect(html).toContain(
        locale === "en"
          ? "Refresh every (minutes)"
          : "Aktualisieren alle (Minuten)",
      );
      expect(html).toContain(
        locale === "en" ? "Load history (days)" : "Verlauf laden (Tage)",
      );
    },
  );

  it("retries only the promote when it failed", async () => {
    let fail = true;
    const { api, calls } = client({
      promoteDraft: vi.fn(async () => {
        calls.push("promoteDraft");
        if (fail)
          throw new CustomApiRequestError(409, "custom_api_connection_limit");
        return { connectionId: CONNECTION_ID };
      }),
    });
    const first = await saveAndConnect(api, {
      workspaceId: W,
      draftId: D,
      state: ready(),
    });
    expect(first.kind).toBe("promoteFailed");
    fail = false;
    const retry = await saveAndConnect(api, {
      workspaceId: W,
      draftId: D,
      state: ready(),
      saved: first.kind === "promoteFailed" ? first.saved : undefined,
    });
    expect(retry).toEqual({ kind: "connected", connectionId: CONNECTION_ID });
    expect(calls).toEqual(["createDefinition", "promoteDraft", "promoteDraft"]);
  });

  it("saves an edited definition as a new version with its baseVersion", async () => {
    const { api, calls } = client();
    const original = saved(3).definition;
    const edited = {
      ...ready(),
      defaults: { ...ready().defaults, refreshMinutes: 30 },
    };
    const result = await saveAndConnect(api, {
      workspaceId: W,
      draftId: D,
      state: edited,
      editing: {
        id: original.id,
        currentVersion: 3,
        document: original.document,
      },
    });
    expect(result).toEqual({ kind: "saved", definitionId: DEFINITION_ID });
    expect(api.saveDefinitionVersion).toHaveBeenCalledWith(W, DEFINITION_ID, {
      document: expect.objectContaining({
        defaults: { refreshMinutes: 30, timeZone: "Europe/Berlin" },
      }),
      baseVersion: 3,
    });
    // No promote: connections get the update offer; the draft is closed.
    expect(calls).toEqual(["saveDefinitionVersion", "deleteDraft"]);
  });
});
