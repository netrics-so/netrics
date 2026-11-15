import { describe, expect, it, vi } from "vitest";
import type {
  StoreTemplateOptions,
  StoreTemplatePlan,
} from "@netrics/contracts";

import { renderI18n } from "@/lib/i18n/test-render";
import { storeScopePath } from "@/lib/store-updates";

import { ScopeReview, StoreTemplateForm } from "./store-template-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const APPLE = "00000000-0000-4000-8000-0000000000a1";
const PLAY = "00000000-0000-4000-8000-0000000000a2";
const OTHER = "00000000-0000-4000-8000-0000000000a3";
const options: StoreTemplateOptions = {
  connections: [
    {
      id: APPLE,
      name: "Apple team",
      connectorId: "app-store-connect",
      setupPending: false,
      apps: [{ id: "123", name: "Focus" }],
    },
    {
      id: PLAY,
      name: "Play account",
      connectorId: "google-play",
      setupPending: false,
      apps: [{ id: "com.focus", name: "Focus" }],
    },
    {
      id: OTHER,
      name: "Second Play",
      connectorId: "google-play",
      setupPending: false,
      apps: [],
    },
  ],
};
const checked = (html: string) =>
  [...html.matchAll(/<input[^>]*>/g)]
    .map((match) => match[0])
    .filter((input) => input.includes('checked=""'));

describe("store template form", () => {
  it("opens an install in edit mode with its connections", () => {
    const html = renderI18n(
      <StoreTemplateForm
        workspaceId={W}
        initialOptions={options}
        install={{
          requestId: REQUEST,
          name: "My apps",
          scope: {
            requestId: REQUEST,
            connections: [APPLE, PLAY],
            appScope: { connectionId: PLAY, appId: "com.focus" },
          },
        }}
      />,
    );
    // The install's connections and its app are chosen; the third is not.
    const inputs = checked(html);
    expect(inputs.filter((i) => i.includes('type="checkbox"'))).toHaveLength(2);
    expect(inputs.filter((i) => i.includes('type="radio"'))).toHaveLength(2);
    // No name field and no product links here: those live in the mapping
    // table, which the form links to.
    expect(html).not.toContain("Dashboard name");
    expect(html).not.toContain("Link apps");
    expect(html).toContain(`href="/workspaces/${W}/data"`);
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Loading store connections");
    expect(storeScopePath(W, REQUEST)).toBe(
      `/workspaces/${W}/dashboards/stores?install=${REQUEST}`,
    );
  });

  it("keeps the install's app choosable before its name is known", () => {
    const html = renderI18n(
      <StoreTemplateForm
        workspaceId={W}
        initialOptions={options}
        install={{
          requestId: REQUEST,
          name: "My apps",
          scope: {
            requestId: REQUEST,
            connections: [OTHER],
            appScope: { connectionId: OTHER, appId: "com.unknown" },
          },
        }}
      />,
    );
    expect(html).toContain("com.unknown");
    expect(
      checked(html).filter((i) => i.includes('type="radio"')),
    ).toHaveLength(2);
  });

  const plan: StoreTemplatePlan = {
    requestId: REQUEST,
    fromVersion: 1,
    toVersion: 1,
    basis: "a".repeat(64),
    summary: {
      measures: { added: 0, changed: 0, removed: 0 },
      steps: { added: 0, changed: 0, removed: 0 },
      widgets: { added: 0, changed: 0, removed: 0 },
      conflicts: 0,
      removals: 2,
    },
    records: [
      {
        key: `preparation:source:${OTHER}:downloads`,
        kind: "preparation",
        recordId: "00000000-0000-4000-8000-0000000000c1",
        name: "Downloads · Second Play",
        hasUnpublishedDraft: false,
        items: [
          {
            ref: `preparation:source:${OTHER}:downloads#step:raw`,
            change: "removed",
            outcome: "propose_removal",
            original: { type: "source" },
            current: { type: "source" },
          },
          {
            ref: `preparation:source:${OTHER}:downloads#step:calculate_app_key`,
            change: "removed",
            outcome: "propose_removal",
            original: { type: "calculate", name: "App" },
            current: { type: "calculate", name: "Mine" },
          },
        ],
      },
      {
        key: "model:downloads",
        kind: "model",
        recordId: "00000000-0000-4000-8000-0000000000c2",
        name: "My apps · Downloads",
        hasUnpublishedDraft: false,
        items: [
          {
            ref: "model:downloads#settings:datasets",
            change: "changed",
            outcome: "scope",
            original: ["ref:a"],
            current: ["ref:a"],
            next: ["ref:b"],
          },
        ],
      },
    ],
  };
  const review = (locale: "en" | "de", decided = false) =>
    renderI18n(
      <ScopeReview
        plan={plan}
        decisions={
          decided
            ? Object.fromEntries(
                plan.records[0]!.items.map((item) => [item.ref, "keep"]),
              )
            : {}
        }
        connections={["Apple team", "Play account"]}
        app={null}
        reloaded={false}
        pending={false}
        onDecide={() => {}}
        onEdit={() => {}}
        onApply={() => {}}
      />,
      locale,
    );

  it("shows the scope plan before applying", () => {
    const html = review("en");
    expect(html).toContain("What changes");
    expect(html).toContain("Apple team · Play account");
    expect(html).toContain("All apps in these connections");
    // One choice for the removed connection's preparation, never deleted.
    expect(html).toContain("Downloads · Second Play");
    expect(html).toContain("it is never deleted");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain("Store name");
    // What follows from the apps is regenerated, not asked about.
    expect(html).toContain("1 part follows your app selection");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply as drafts/);
    expect(review("en", true)).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Apply as drafts/,
    );
    // No template version summary for a change of apps.
    expect(html).not.toContain("No changes to measures");
  });

  it("shows the scope plan in German", () => {
    const html = review("de");
    expect(html).toContain("Was sich ändert");
    expect(html).toContain("Alle Apps dieser Verbindungen");
    expect(html).toContain("sie wird nie gelöscht");
    expect(html).toContain("Als Entwürfe anwenden");
  });

  it("says when the apps are the ones the dashboard already uses (en, de)", () => {
    const unchanged = { ...plan, records: [] };
    for (const [locale, text] of [
      ["en", "These are the apps the dashboard already uses"],
      ["de", "Das sind die Apps, die das Dashboard schon nutzt"],
    ] as const) {
      const html = renderI18n(
        <ScopeReview
          plan={unchanged}
          decisions={{}}
          connections={["Apple team"]}
          app="Focus"
          reloaded={false}
          pending={false}
          onDecide={() => {}}
          onEdit={() => {}}
          onApply={() => {}}
        />,
        locale,
      );
      expect(html).toContain(text);
      expect(html).toContain("Focus");
      expect(html).not.toContain("Apply");
    }
  });
});
