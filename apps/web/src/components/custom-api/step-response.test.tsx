import { describe, expect, it, vi } from "vitest";

import type { CustomApiTestResponse } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { CustomApiBuilder } from "./builder";
import type { BuilderClient } from "./builder-actions";
import { StepResponse } from "./step-response";
import { TestPanel } from "./test-panel";
import { TEST_RESPONSE, W } from "./test-fixtures";
import {
  emptyBuilderState,
  pickRecords,
  setFieldType,
  stepIssues,
  toggleField,
  withRequest,
  type BuilderState,
} from "@/lib/custom-api-builder";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Request, Response, the field mapping and the test panel (#807).

const LOCALES: Locale[] = ["en", "de"];

const STATS: CustomApiTestResponse = {
  ...TEST_RESPONSE,
  response: {
    status: 200,
    contentType: "application/json",
    body: {
      data: [
        {
          date: "2026-11-01",
          orders: 1,
          revenue: { amount: "12.50", currency: "EUR" },
        },
        {
          date: "2026-11-02",
          orders: 2,
          revenue: { amount: "12.50", currency: "EUR" },
        },
        {
          date: "2026-11-03",
          orders: 3,
          revenue: { amount: "12.50", currency: "EUR" },
        },
      ],
      meta: { next: "p2" },
    },
    truncated: false,
    bytes: 300,
  },
  recordArrays: [{ path: "data", length: 3 }],
  records: { path: "data", count: 3, found: true },
  suggestions: [
    {
      path: "date",
      id: "date",
      name: "Date",
      type: "date",
      nullable: false,
      samples: ["2026-11-01"],
    },
    {
      path: "orders",
      id: "orders",
      name: "Orders",
      type: "integer",
      nullable: false,
      samples: ["1"],
    },
    {
      path: "revenue.amount",
      id: "revenue_amount",
      name: "Revenue amount",
      type: "decimal",
      nullable: false,
      samples: ["12.50"],
    },
    {
      path: "revenue.currency",
      id: "revenue_currency",
      name: "Revenue currency",
      type: "string",
      nullable: false,
      samples: ["EUR"],
    },
  ],
  rows: [
    { date: "2026-11-01", orders: 1, revenue_amount: "12.50" },
    { date: "2026-11-02", orders: 2, revenue_amount: "12.50" },
    { date: "2026-11-03", orders: 3, revenue_amount: "12.50" },
  ],
};

function mapped(test: CustomApiTestResponse = STATS): BuilderState {
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
  };
  state = pickRecords(withRequest(state, { path: "/builder/stats" }), "data");
  for (const path of ["date", "orders", "revenue.amount"])
    state = toggleField(
      state,
      test.suggestions.find((s) => s.path === path)!,
      true,
    );
  return { ...state, lastTest: test };
}

const render = (locale: Locale, state: BuilderState) =>
  renderI18n(
    <StepResponse
      state={state}
      update={() => {}}
      pending={false}
      previewStale={false}
      onPickRecords={() => {}}
      onRefresh={() => {}}
    />,
    locale,
  );

describe("custom API builder: Response", () => {
  it.each(LOCALES)(
    "shows the suggested types and lets me change them (%s)",
    (locale) => {
      const html = render(locale, mapped());
      const expected =
        locale === "en"
          ? [
              "Suggested: Date",
              "Suggested: Whole number",
              "Suggested: Decimal (money)",
            ]
          : [
              "Vorschlag: Datum",
              "Vorschlag: Ganze Zahl",
              "Vorschlag: Dezimalzahl (Geld)",
            ];
      for (const text of expected) expect(html).toContain(text);
      // Every type is offered, the image URL too.
      expect(html).toContain(
        locale === "en" ? ">Image URL</option>" : ">Bild-URL</option>",
      );
      expect(html).toMatch(/<option value="decimal" selected="">/);
      const changed = setFieldType(mapped(), "orders", "number");
      expect(changed.stream.fields.find((f) => f.id === "orders")?.type).toBe(
        "number",
      );
      // The first record's leaves can be ticked; the ticked ones are.
      expect(html).toContain('aria-label="revenue.amount" checked=""/>');
      expect(html).toContain('aria-label="revenue.currency"/>');
    },
  );

  it.each(LOCALES)("previews mapped rows in a table (%s)", (locale) => {
    const html = render(locale, mapped());
    expect(html).toContain(
      locale === "en" ? "Preview (3 rows)" : "Vorschau (3 Zeilen)",
    );
    expect(html).toContain('class="table data-table"');
    expect(html.match(/<tr>/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain(">2026-11-03</td>");
  });

  it.each(LOCALES)(
    "says when the request returned no records (%s)",
    (locale) => {
      const empty: CustomApiTestResponse = {
        ...STATS,
        response: { ...STATS.response!, body: { data: [] } },
        records: { path: "data", count: 0, found: true },
        suggestions: [],
        rows: [],
      };
      const html = render(locale, { ...mapped(), lastTest: empty });
      expect(html).toContain(
        locale === "en"
          ? "The request returned no records. Change the request or the time window and send it again."
          : "Die Anfrage hat keine Einträge geliefert.",
      );
    },
  );

  it.each(LOCALES)(
    "shows the request log with redacted URLs as sent by the server (%s)",
    (locale) => {
      const html = renderI18n(
        <TestPanel
          test={{
            ...STATS,
            log: [
              {
                page: 1,
                method: "GET",
                url: "https://api.example.test/builder/stats?key=[redacted]&from=2026-11-01",
                status: 200,
                durationMs: 18,
                bytes: 2048,
                records: 3,
              },
            ],
          }}
          error={null}
          pending={false}
        />,
        locale,
      );
      expect(html).toContain(
        "<code>https://api.example.test/builder/stats?key=[redacted]&amp;from=2026-11-01</code>",
      );
      expect(html).toContain(locale === "en" ? "Requests" : "Anfragen");
      expect(html).toContain("18 ms");
      expect(html).toContain("2 KB");
      expect(html).toContain(
        locale === "en"
          ? "The request worked."
          : "Die Anfrage hat funktioniert.",
      );
      // A failed test says why, in the viewer's language.
      const failed = renderI18n(
        <TestPanel
          test={{
            ...STATS,
            ok: false,
            error: { code: "custom_api_auth_rejected", message: "401" },
          }}
          error={null}
          pending={false}
        />,
        locale,
      );
      expect(failed).toContain(
        locale === "en"
          ? "The API refused the login. Check the key or token."
          : "Die API hat die Anmeldung abgelehnt.",
      );
    },
  );

  it.each(LOCALES)("refuses an Authorization header row (%s)", (locale) => {
    const state = withRequest(mapped(), {
      headers: [{ key: "Authorization", value: "Bearer x" }],
    });
    expect(stepIssues(state, "request")).toEqual(["issues.authHeader"]);
    const html = renderI18n(
      <CustomApiBuilder
        workspaceId={W}
        canEdit
        projects={[]}
        initial={{ state, step: "request" }}
        api={{} as BuilderClient}
      />,
      locale,
    );
    expect(html).toContain(
      locale === "en"
        ? "Don&#x27;t add an Authorization header."
        : "Füge keinen Authorization-Header hinzu.",
    );
    expect(html).toMatch(/class="primary" disabled="">(Continue|Weiter)</);
  });
});
