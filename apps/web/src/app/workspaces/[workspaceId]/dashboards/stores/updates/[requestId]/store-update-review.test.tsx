import { describe, expect, it, vi } from "vitest";
import type {
  StoreTemplatePlan,
  StoreTemplateUpdate,
} from "@netrics/contracts";

import { ApiError } from "@/lib/api";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  applyReviewed,
  missingDecisions,
  type StoreInstall,
} from "@/lib/store-updates";

import {
  ProgressView,
  ReviewView,
  StoreUpdateReview,
} from "./store-update-review";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const MODEL = "00000000-0000-4000-8000-0000000000c1";
const PREP = "00000000-0000-4000-8000-0000000000c2";
const DASHBOARD = "00000000-0000-4000-8000-000000000010";
const BASIS = "a".repeat(64);

const measure = (name: string, op = "sum") => ({
  id: "downloads",
  name,
  kind: "aggregate",
  datasetId: "datasets[0]",
  aggregate: { id: "downloads", name, op, fieldId: "units" },
});
const plan: StoreTemplatePlan = {
  requestId: REQUEST,
  fromVersion: 1,
  toVersion: 2,
  basis: BASIS,
  summary: {
    measures: { added: 1, changed: 1, removed: 0 },
    steps: { added: 0, changed: 1, removed: 0 },
    widgets: { added: 1, changed: 0, removed: 1 },
    conflicts: 2,
    removals: 1,
  },
  records: [
    {
      key: "model:downloads",
      kind: "model",
      recordId: MODEL,
      name: "App downloads",
      hasUnpublishedDraft: true,
      items: [
        {
          ref: "model:downloads#measure:downloads",
          change: "changed",
          outcome: "template",
          original: measure("Downloads"),
          current: measure("Downloads"),
          next: measure("Downloads (v2)"),
        },
        {
          ref: "model:downloads#measure:downloads_avg",
          change: "added",
          outcome: "choose",
          reason: "reads_removed_dataset",
          dataset: "ref:preparation:append:downloads:0:0:output",
          next: measure("Average downloads", "avg"),
        },
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
    {
      key: "preparation:append:downloads:0:0",
      kind: "preparation",
      recordId: PREP,
      name: "Downloads, all stores",
      hasUnpublishedDraft: false,
      items: [],
    },
    {
      key: "preparation:source:x:downloads",
      kind: "preparation",
      recordId: PREP,
      name: "Apple downloads",
      hasUnpublishedDraft: false,
      items: [
        {
          ref: "preparation:source:x:downloads#step:calculate_store_name",
          change: "changed",
          outcome: "choose",
          original: { type: "calculate", name: "Store name" },
          current: { type: "calculate", name: "Store" },
          next: { type: "calculate", name: "Store name (v2)" },
        },
      ],
    },
    {
      key: "dashboard:portfolio",
      kind: "dashboard",
      recordId: DASHBOARD,
      name: "App portfolio",
      hasUnpublishedDraft: false,
      items: [
        {
          ref: "dashboard:portfolio#widget:ratings",
          change: "removed",
          outcome: "propose_removal",
          original: { type: "table", title: "Ratings", slide: "slide:0" },
          current: { type: "table", title: "Ratings", slide: "slide:0" },
        },
        {
          ref: "dashboard:portfolio#widget:summary",
          change: "added",
          outcome: "template",
          next: { type: "measure", title: "Summary", slide: "slide:0" },
        },
        {
          ref: "dashboard:portfolio#widget:custom:w1",
          change: "added",
          outcome: "customer",
          current: { type: "text", title: "My note", slide: "slide:0" },
        },
      ],
    },
  ],
};
const ASKED = [
  "model:downloads#measure:downloads_avg",
  "preparation:source:x:downloads#step:calculate_store_name",
  "dashboard:portfolio#widget:ratings",
];
const allDecided = {
  [ASKED[0]!]: "customer",
  [ASKED[1]!]: "template",
  [ASKED[2]!]: "keep",
} as const;

const update: StoreTemplateUpdate = {
  id: "00000000-0000-4000-8000-0000000000e1",
  requestId: REQUEST,
  fromVersion: 1,
  toVersion: 2,
  createdAt: "2026-11-14T10:00:00.000Z",
  drafts: [],
  dashboards: [],
};

const review = (
  props: Partial<Parameters<typeof ReviewView>[0]> = {},
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <ReviewView
      plan={plan}
      decisions={{}}
      onDecide={() => {}}
      onApply={() => {}}
      pending={false}
      notice={null}
      error={null}
      {...props}
    />,
    locale,
  );
const applyButton = (html: string) =>
  html.slice(html.lastIndexOf("<button", html.indexOf("Apply as drafts")));

describe("reviewing a store-template update (11E)", () => {
  it("needs a decision for every conflict and proposed removal before applying", () => {
    expect(missingDecisions(plan, {})).toEqual(ASKED);
    expect(
      missingDecisions(plan, { ...allDecided, [ASKED[2]!]: "template" }),
    ).toEqual([ASKED[2]]);
    expect(missingDecisions(plan, allDecided)).toEqual([]);

    const undecided = review();
    // Nothing is chosen for the customer.
    expect(undecided).not.toContain("checked");
    expect(applyButton(undecided)).toMatch(/^<button[^>]*disabled/);
    expect(undecided).toContain("0 of 3 decided");
    expect(undecided).toContain(
      "Make a choice for every item under “Your choice”",
    );
    const decided = review({ decisions: allDecided });
    expect(applyButton(decided)).not.toMatch(/^<button[^>]*disabled/);
    expect(decided).toContain("3 of 3 decided");
  });

  it("groups the items and says why the customer is asked", () => {
    const html = review();
    for (const group of [
      "Your choice",
      "Proposed for removal",
      "From the template",
      "Kept from you",
    ])
      expect(html).toContain(group);
    expect(html).toContain("Use the template’s version");
    expect(html).toContain("Keep mine");
    expect(html).toContain(" Remove</label>");
    expect(html).toContain(" Keep</label>");
    // Item text from the value: names, kinds, aggregations; never JSON.
    expect(html).toContain("Measure Downloads (v2) · Sum");
    expect(html).toContain("Calculate a column · Store name (v2)");
    expect(html).toContain("Yours: Calculate a column · Store");
    expect(html).toContain("Widget Ratings · Table");
    expect(html).toContain("Widget My note · Text");
    expect(html).not.toContain("{&quot;");
    expect(html).not.toContain("ref:");
    // Why: the measure brings back data the customer removed.
    expect(html).toContain(
      "Taking the template’s version brings back Downloads, all stores, which you removed from these measures.",
    );
    expect(html).toContain("You and the template both changed this.");
    expect(html).toContain("The new template no longer has this.");
    // Scope parts are only counted, and the unpublished draft is noted.
    expect(html).toContain("1 part follows your app selection");
    expect(html).toContain("Includes your unpublished changes");
    expect(html).toContain(
      "1 measure changed, 1 added · 1 step changed · 1 widget added, 1 removed · 2 need your choice · 1 proposed for removal",
    );
  });

  it("sends the chosen decisions with the plan basis", async () => {
    const apply = vi.fn(async () => update);
    const reload = vi.fn(async () => plan);
    const result = await applyReviewed(
      plan,
      // A stray choice for an item nobody asked about is not sent.
      { ...allDecided, "model:downloads#measure:downloads": "customer" },
      { apply, reload },
    );
    expect(result).toEqual({ kind: "applied", update });
    expect(apply).toHaveBeenCalledWith({
      basis: BASIS,
      decisions: [
        { ref: ASKED[0], choice: "customer" },
        { ref: ASKED[1], choice: "template" },
        { ref: ASKED[2], choice: "keep" },
      ],
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the plan when it changed", async () => {
    const changed: StoreTemplatePlan = {
      ...plan,
      basis: "b".repeat(64),
      records: plan.records.map((record) =>
        record.key !== "preparation:source:x:downloads"
          ? record
          : {
              ...record,
              items: record.items.map((item) => ({
                ...item,
                current: { type: "calculate", name: "Store, edited again" },
              })),
            },
      ),
    };
    const apply = vi.fn(async () => {
      throw new ApiError(409, "store_update_stale");
    });
    const result = await applyReviewed(plan, allDecided, {
      apply,
      reload: async () => changed,
    });
    // The choice made on a value that changed is asked again.
    expect(result).toEqual({
      kind: "reloaded",
      plan: changed,
      decisions: { [ASKED[0]!]: "customer", [ASKED[2]!]: "keep" },
    });
    expect(review({ notice: "reloaded" })).toContain(
      "The update changed since you opened it, so the review was reloaded.",
    );
    // Other failures are not swallowed.
    await expect(
      applyReviewed(plan, allDecided, {
        apply: async () => {
          throw new ApiError(409, "store_update_open");
        },
        reload: async () => changed,
      }),
    ).rejects.toThrow("store_update_open");
  });

  it("renders the review in German", () => {
    const html = review({}, "de");
    expect(html).toContain("Deine Entscheidung");
    expect(html).toContain("Zum Entfernen vorgeschlagen");
    expect(html).toContain("Aus der Vorlage");
    expect(html).toContain("Von dir behalten");
    expect(html).toContain("Version der Vorlage übernehmen");
    expect(html).toContain("Meine behalten");
    expect(html).toContain("Als Entwürfe anwenden");
    expect(html).toContain("Kennzahl Downloads (v2) · Summe");
    expect(html).toContain("0 von 3 entschieden");
    expect(html).toContain("Enthält deine unveröffentlichten Änderungen");
  });
});

const ORIGINAL = DASHBOARD;
const COPY = "00000000-0000-4000-8000-000000000011";
const LOBBY = "00000000-0000-4000-8000-000000000041";
const KITCHEN = "00000000-0000-4000-8000-000000000042";
const entry = (
  overrides: Partial<StoreTemplateUpdate["dashboards"][number]> = {},
) => ({
  key: "dashboard:portfolio",
  originalId: ORIGINAL,
  copyId: null,
  swappedAt: null,
  swappedBackAt: null,
  ready: false,
  ...overrides,
});
const applied = (
  overrides: Partial<StoreTemplateUpdate> = {},
): StoreTemplateUpdate => ({
  ...update,
  drafts: [
    {
      key: "model:downloads",
      kind: "model",
      recordId: MODEL,
      name: "App downloads",
      version: 2,
      published: false,
    },
  ],
  dashboards: [entry()],
  ...overrides,
});
const noActions = {
  copy: () => {},
  swap: () => {},
  swapBack: () => {},
  close: () => {},
  refresh: () => {},
};
const screens = [
  { id: LOBBY, name: "Lobby", dashboardId: ORIGINAL, revokedAt: null },
  { id: KITCHEN, name: "Kitchen", dashboardId: ORIGINAL, revokedAt: null },
  {
    id: "00000000-0000-4000-8000-000000000043",
    name: "Old hall",
    dashboardId: ORIGINAL,
    revokedAt: "2026-11-01T00:00:00.000Z",
  },
];
const progress = (
  props: Partial<Parameters<typeof ProgressView>[0]> = {},
  locale: "en" | "de" = "en",
) =>
  renderI18n(
    <ProgressView
      workspaceId={W}
      update={applied()}
      screens={screens}
      dashboardNames={{ [ORIGINAL]: "App portfolio" }}
      canCopy
      canSwap
      pending={null}
      problem={null}
      actions={noActions}
      closable
      {...props}
    />,
    locale,
  );
const buttonOf = (html: string, label: string) =>
  html.slice(html.lastIndexOf("<button", html.indexOf(label)));

describe("publishing, copying and swapping an update (11E)", () => {
  it.each(["en", "de"] as const)(
    "keeps the copy step disabled until every draft is published (%s)",
    (locale) => {
      const create =
        locale === "en"
          ? "Create the updated dashboard</button>"
          : "Aktualisiertes Dashboard erstellen</button>";
      const waiting = progress({}, locale);
      expect(buttonOf(waiting, create)).toMatch(/^<button[^>]*disabled/);
      expect(waiting).toContain(
        locale === "en"
          ? "Publish every draft first"
          : "Veröffentliche zuerst alle Entwürfe",
      );
      // Each draft links to its editor in data settings.
      expect(waiting).toContain(`href="/workspaces/${W}/data?model=${MODEL}"`);
      expect(waiting).toMatch(/aria-current="step"[^>]*>.*2<\/span>/s);
      const published = progress(
        {
          update: applied({
            drafts: [{ ...applied().drafts[0]!, published: true }],
            dashboards: [entry({ ready: true })],
          }),
        },
        locale,
      );
      expect(buttonOf(published, create)).not.toMatch(/^<button[^>]*disabled/);
      expect(published).not.toContain(`data?model=`);
      // Without dashboards:create the button is not offered.
      expect(
        progress(
          {
            canCopy: false,
            update: applied({ dashboards: [entry({ ready: true })] }),
          },
          locale,
        ),
      ).not.toContain(create);
    },
  );

  it.each(["en", "de"] as const)(
    "lists the screens a swap would move and those it cannot (%s)",
    (locale) => {
      const copied = applied({
        drafts: [],
        dashboards: [entry({ copyId: COPY })],
      });
      const html = progress({ update: copied }, locale);
      expect(html).toContain(
        locale === "en"
          ? "Moves 2 screens: Lobby and Kitchen"
          : "Verschiebt 2 Bildschirme: Lobby und Kitchen",
      );
      expect(html).not.toContain("Old hall");
      expect(html).toContain(
        `href="/workspaces/${W}/dashboards/${COPY}/studio"`,
      );
      const refused = progress(
        {
          update: copied,
          problem: {
            key: "dashboard:portfolio",
            action: "swap",
            names: [],
            error: new ApiError(409, "device_scope_not_applicable", {
              devices: [
                {
                  id: LOBBY,
                  name: "Lobby",
                  code: "device_scope_filter_unknown",
                },
              ],
            }),
          },
        },
        locale,
      );
      expect(refused).toContain(
        locale === "en"
          ? "No screen moved: Lobby has a fixed scope the updated dashboard can’t show."
          : "Kein Bildschirm wurde verschoben: Lobby hat einen festen Bereich, den das aktualisierte Dashboard nicht zeigen kann.",
      );
      // Moving screens needs devices:manage.
      expect(progress({ update: copied, canSwap: false }, locale)).toContain(
        locale === "en"
          ? "A workspace admin or owner can move screens."
          : "Ein Admin oder Inhaber des Workspaces kann Bildschirme verschieben.",
      );
    },
  );

  it.each(["en", "de"] as const)(
    "offers switching back after a swap (%s)",
    (locale) => {
      const swapped = applied({
        drafts: [],
        dashboards: [
          entry({ copyId: COPY, swappedAt: "2026-11-14T11:00:00.000Z" }),
        ],
      });
      const html = progress({ update: swapped, closable: false }, locale);
      expect(html).toContain(
        locale === "en" ? "Switch back</button>" : "Zurückwechseln</button>",
      );
      expect(html).toContain(
        locale === "en" ? "Update finished." : "Update abgeschlossen.",
      );
      // Every step is done.
      expect(html).not.toContain('aria-current="step"');
      const back = progress(
        {
          update: {
            ...swapped,
            dashboards: [
              {
                ...swapped.dashboards[0]!,
                swappedBackAt: "2026-11-14T12:00:00.000Z",
              },
            ],
          },
          closable: false,
          previous: true,
        },
        locale,
      );
      expect(back).toContain(
        locale === "en"
          ? "Use the updated dashboard again</button>"
          : "Aktualisiertes Dashboard wieder nutzen</button>",
      );
    },
  );

  it("offers to discard copy edits and to recreate a copy of a changed original", () => {
    const copied = applied({
      drafts: [],
      dashboards: [entry({ copyId: COPY })],
    });
    expect(
      progress({
        update: copied,
        problem: {
          key: "dashboard:portfolio",
          action: "copy",
          names: [],
          error: new ApiError(409, "store_update_copy_edited"),
        },
      }),
    ).toContain("Discard my edits to the copy and create it again</button>");
    expect(
      progress({
        update: copied,
        problem: {
          key: "dashboard:portfolio",
          action: "swap",
          names: [],
          error: new ApiError(409, "store_update_original_changed"),
        },
      }),
    ).toContain("Create the copy again</button>");
    expect(
      progress({
        update: copied,
        problem: {
          key: "dashboard:portfolio",
          action: "copy",
          names: ["Ratings"],
          error: new ApiError(409, "store_update_unmergeable"),
        },
      }),
    ).toContain("can’t be made with these widgets: Ratings.");
  });

  it("explains installs updates are not available for", () => {
    const install: StoreInstall = {
      requestId: REQUEST,
      name: "App portfolio",
      templateVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
      summary: null,
      error: "store_template_baseline_unavailable",
      dashboardIds: [ORIGINAL],
      modelIds: [],
      preparationIds: [],
      openUpdate: null,
      lastUpdate: null,
    };
    const html = renderI18n(
      <StoreUpdateReview
        workspaceId={W}
        install={install}
        screens={null}
        dashboardNames={{}}
        canCopy
        canSwap
      />,
    );
    expect(html).toContain("Updates aren’t available for this dashboard.");
    expect(html).not.toContain("Apply as drafts");
  });
});
