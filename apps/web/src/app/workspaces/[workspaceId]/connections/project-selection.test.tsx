import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
  SelectedResource,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { AppPicker } from "./app-picker";
import {
  ProjectSelection,
  ProjectSelectionEditor,
  pickerState,
  selectionSavable,
  SYNCED_SHOWN,
  SYNCED_STEP,
  SyncedProjects,
  SyncedProjectsReadOnly,
  syncedPage,
} from "./project-selection";
import { apiErrorMessage, ApiError } from "@/lib/api";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The synced projects of a connection (#782), in English and German.

const connector = {
  id: "vercel",
  configSchema: {
    type: "object",
    properties: { teamId: { type: "string", title: "Team ID" } },
  },
} as unknown as ConnectorCatalogEntry;

function render(
  locale: Locale,
  config: Record<string, unknown>,
  synced?: SelectedResource[] | null,
) {
  return renderI18n(
    <ProjectSelection
      workspaceId="w"
      connection={{ id: "c", config } as unknown as ConnectionDetail}
      connector={connector}
      synced={synced}
    />,
    locale,
  );
}

describe("project selection (#782)", () => {
  it("offers the change and says that removed projects keep their data", () => {
    const en = render("en", {});
    expect(en).toContain("Synced projects");
    expect(en).toContain("the data already collected is kept");
    expect(en).toContain("Change project selection");
    const de = render("de", {});
    expect(de).toContain("Synchronisierte Projekte");
    expect(de).toContain("bereits importierte Daten bleiben erhalten");
    expect(de).toContain("Projektauswahl ändern");
  });

  it("a refused check still opens the picker, so failing projects can be removed", () => {
    // Web Analytics was turned off on the last enabled project: Vercel's
    // check refuses, and the stored selection must stay reachable.
    const refused = pickerState({
      check: { ok: false, message: "None of the projects has Web Analytics." },
      resources: [],
      selection: ["prj_a"],
    });
    expect(refused).toEqual({
      resources: [],
      hidden: 0,
      selection: ["prj_a"],
      refusal: "None of the projects has Web Analytics.",
    });
    // The picker lists the stored project as not listed, to be unticked.
    const html = renderI18n(
      <AppPicker
        texts="connections.projects"
        resources={refused.resources}
        value={refused.selection}
        onChange={() => {}}
      />,
      "en",
    );
    expect(html).toContain("prj_a");
    expect(html).toContain("Not currently listed");
    expect(html).toContain("Clear selection");
  });

  it("a selected project without Web Analytics stays removable, others are not offered", () => {
    const state = pickerState({
      check: { ok: true },
      resources: [
        { id: "prj_a", name: "alpha-site", kind: "project" },
        {
          id: "prj_g",
          name: "gamma-docs",
          kind: "project",
          metadata: { webAnalytics: false },
        },
      ],
      selection: ["prj_a", "prj_g"],
    });
    expect(state.refusal).toBeNull();
    expect(state.resources.map((resource) => resource.id)).toEqual(["prj_a"]);
    expect(state.hidden).toBe(1);
    expect(state.selection).toEqual(["prj_a", "prj_g"]);
  });

  it("the picker names projects, with their IDs beside the names", () => {
    const picker = (locale: Locale) =>
      renderI18n(
        <AppPicker
          texts="connections.projects"
          resources={[{ id: "prj_a", name: "alpha-site", kind: "project" }]}
          value={["prj_a", "prj_gone"]}
          onChange={() => {}}
        />,
        locale,
      );
    const en = picker("en");
    expect(en).toContain("Projects to sync");
    expect(en).toContain("alpha-site");
    expect(en).toContain("prj_a");
    expect(en).toContain("2 projects selected");
    expect(en).toContain("Not currently listed");
    expect(en).not.toContain("apps");
    const de = picker("de");
    expect(de).toContain("Projekte für die Synchronisierung");
    expect(de).toContain("2 Projekte ausgewählt");
    expect(de).not.toContain("Apps");
  });
});

describe("the synced projects up front, and at least one required (#854)", () => {
  it("names the synced projects without loading the list, IDs where no name is known", () => {
    const synced = [
      { id: "prj_a", name: "alpha-site" },
      { id: "prj_b", name: null },
    ];
    const en = render("en", {}, synced);
    expect(en).toContain("Selected projects (2):");
    // The configured selection, not a promise of data: a project is only
    // synced while the token sees it and it has Web Analytics.
    expect(en).toContain(
      "A selected project is only synced while the token can see it and Web Analytics is enabled for it.",
    );
    expect(en).not.toContain("are synced");
    expect(en).toContain("<li>alpha-site</li>");
    expect(en).toContain("<li>prj_b</li>");
    // A named project is shown by its name only.
    expect(en).not.toContain("prj_a");
    expect(en).toContain("Change project selection");
    const de = render("de", {}, synced);
    expect(de).toContain("Ausgewählte Projekte (2):");
    expect(de).toContain(
      "Ein ausgewähltes Projekt wird nur synchronisiert, solange das Token es sehen kann und Web Analytics dafür aktiviert ist.",
    );
    expect(de).toContain("<li>alpha-site</li>");
    expect(render("en", {}, [synced[0]!])).toContain("Selected project (1):");
    expect(render("de", {}, [synced[0]!])).toContain(
      "Ausgewähltes Projekt (1):",
    );
  });

  it("says all projects when no selection is stored", () => {
    // Qualified: the team of the settings, and only with Web Analytics.
    const en = render("en", {}, null);
    expect(en).toContain("Selection: all current and future projects.");
    expect(en).toContain(
      "Synced are the projects the token lists (for the Team ID in the settings, if one is set) that have Web Analytics enabled; projects without it are skipped.",
    );
    const de = render("de", {}, null);
    expect(de).toContain("Auswahl: alle aktuellen und zukünftigen Projekte.");
    expect(de).toContain("Projekte ohne Web Analytics werden übersprungen.");
  });

  it("says nothing about the selection while it is unknown", () => {
    // An API from before the field: no claim either way.
    const en = render("en", {});
    expect(en).not.toContain("Selected project");
    expect(en).not.toContain("Selection:");
    expect(en).not.toContain("No project is selected");
    expect(en).not.toContain("<ul>");
  });

  it("a stored empty selection collects nothing and says how to fix it", () => {
    const en = render("en", {}, []);
    expect(en).toContain(
      "No project is selected, so this connection collects nothing new.",
    );
    expect(en).toContain(
      "Use “Change project selection” to choose at least one project (or all projects); the data already collected is kept.",
    );
    // Deleting is no way to keep the history: it goes with the connection.
    expect(en).toContain(
      "Deleting the connection instead also deletes the data it collected.",
    );
    expect(en).toContain('role="status"');
    const de = render("de", {}, []);
    expect(de).toContain(
      "Kein Projekt ist ausgewählt, deshalb importiert diese Verbindung nichts Neues.",
    );
    expect(de).toContain("„Projektauswahl ändern“");
    expect(de).toContain(
      "Wenn du stattdessen die Verbindung löschst, werden auch ihre importierten Daten gelöscht.",
    );
  });

  it("cuts a long list short", () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      id: `prj_${index}`,
      name: `site-${index}`,
    }));
    const en = renderI18n(<SyncedProjects selection={many} />, "en");
    expect(en).toContain("Selected projects (23):");
    expect(en.match(/<li>site-/g)).toHaveLength(20);
    expect(en).toContain("and 3 more");
    const de = renderI18n(<SyncedProjects selection={many} />, "de");
    expect(de).toContain("und 3 weitere");
    // The rest opens in place: a button that names the list it controls.
    const listId = en.match(/<ul id="([^"]+)">/)![1];
    expect(en).toContain(
      `<button type="button" aria-expanded="false" aria-controls="${listId}">Show all 23</button>`,
    );
    expect(en).not.toContain("Show fewer");
    expect(de).toContain(">Alle 23 anzeigen</button>");
    // A short list has nothing to open.
    const short = renderI18n(
      <SyncedProjects selection={many.slice(0, SYNCED_SHOWN)} />,
      "en",
    );
    expect(short).not.toContain("<button");
    expect(short).not.toContain("more");
  });

  it("opens the whole stored list, by stored names, and closes it again", () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      id: `prj_${index}`,
      name: index === 22 ? null : `site-${index}`,
    }));
    // What "Show all 23" leaves on the page.
    const en = renderI18n(
      <SyncedProjects selection={many} initialLimit={23} />,
      "en",
    );
    expect(en.match(/<li>/g)).toHaveLength(23);
    expect(en).toContain("<li>site-21</li>");
    expect(en).toContain("<li>prj_22</li>");
    expect(en).not.toContain("and 0 more");
    expect(en).not.toContain("Show all");
    expect(en).toContain('aria-expanded="true"');
    expect(en).toContain(">Show fewer</button>");
    expect(
      renderI18n(<SyncedProjects selection={many} initialLimit={23} />, "de"),
    ).toContain(">Weniger anzeigen</button>");
  });

  it("a very long list opens in steps, never all at once", () => {
    const huge = Array.from({ length: 70_000 }, (_, index) => index);
    const closed = syncedPage(huge, SYNCED_SHOWN);
    expect(closed.shown).toHaveLength(SYNCED_SHOWN);
    expect(closed).toMatchObject({
      rest: 70_000 - SYNCED_SHOWN,
      next: SYNCED_STEP,
      expanded: false,
    });
    const once = syncedPage(huge, SYNCED_SHOWN + closed.next);
    expect(once.shown).toHaveLength(SYNCED_SHOWN + SYNCED_STEP);
    expect(once.expanded).toBe(true);
    // The last step shows what is left.
    const last = syncedPage(huge, 69_900);
    expect(last).toMatchObject({ rest: 100, next: 100 });
    expect(syncedPage(huge, 70_000)).toMatchObject({ rest: 0, next: 0 });
    // The button says how many the step adds, not "all".
    const selection = huge.map((index) => ({ id: `prj_${index}`, name: null }));
    const en = renderI18n(<SyncedProjects selection={selection} />, "en");
    expect(en.match(/<li>/g)).toHaveLength(SYNCED_SHOWN);
    expect(en).toContain(">Show 500 more</button>");
    expect(
      renderI18n(<SyncedProjects selection={selection} />, "de"),
    ).toContain(">500 weitere anzeigen</button>");
  });

  it("someone who cannot change the connection sees the selection too", () => {
    const viewer = (
      locale: Locale,
      selection: SelectedResource[] | null | undefined,
    ) => renderI18n(<SyncedProjectsReadOnly selection={selection} />, locale);
    const en = viewer("en", [
      { id: "prj_a", name: "alpha-site" },
      { id: "prj_b", name: null },
    ]);
    expect(en).toContain("Synced projects");
    expect(en).toContain("Selected projects (2):");
    expect(en).toContain("<li>alpha-site</li>");
    expect(en).toContain("<li>prj_b</li>");
    expect(en).toContain(
      "A selected project is only synced while the token can see it and Web Analytics is enabled for it.",
    );
    // No form, and no pointer at a button they do not have.
    expect(en).not.toContain("Change project selection");
    expect(en).not.toContain("<form");
    expect(viewer("de", [{ id: "prj_a", name: "alpha-site" }])).toContain(
      "Ausgewähltes Projekt (1):",
    );
    expect(viewer("en", null)).toContain(
      "Selection: all current and future projects.",
    );
    // A stored empty selection: why nothing syncs, and whom to ask.
    const none = viewer("en", []);
    expect(none).toContain('role="status"');
    expect(none).toContain(
      "No project is selected, so this connection collects nothing new. The data already collected is kept. Ask an owner, admin or editor of this workspace to choose at least one project (or all projects).",
    );
    expect(none).not.toContain("Change project selection");
    expect(none).not.toContain("delet");
    expect(viewer("de", [])).toContain(
      "Bitte einen Inhaber, Admin oder Bearbeiter dieses Workspace, mindestens ein Projekt (oder alle Projekte) auszuwählen.",
    );
    // Unknown (an older API): no card at all.
    expect(viewer("en", undefined)).toBe("");
  });

  const editor = (
    locale: Locale,
    selection: string[] | null,
    options: { dirty?: boolean; refusal?: string | null } = {},
  ) =>
    renderI18n(
      <ProjectSelectionEditor
        resources={[{ id: "prj_a", name: "alpha-site", kind: "project" }]}
        hidden={0}
        refusal={options.refusal ?? null}
        selection={selection}
        dirty={options.dirty ?? true}
        pending={null}
        onChange={() => {}}
        onCancel={() => {}}
      />,
      locale,
    );
  const saveButton = (html: string, label: string) =>
    html.match(
      new RegExp(`<button[^>]*type="submit"[^>]*>${label}</button>`),
    )?.[0] ?? "";

  it("an empty selection cannot be saved: Save is disabled, with the hint", () => {
    expect(selectionSavable(null)).toBe(true);
    expect(selectionSavable(["prj_a"])).toBe(true);
    expect(selectionSavable([])).toBe(false);
    const en = editor("en", []);
    const button = saveButton(en, "Save project selection");
    expect(button).toContain('disabled=""');
    // The button refers to the hint shown with the empty list.
    const hint = en.match(/<p class="notice" id="([^"]+)">([^<]*)<\/p>/);
    expect(hint?.[2]).toBe(
      "Select at least one project, or choose all projects: an empty selection cannot be saved.",
    );
    expect(button).toContain(`aria-describedby="${hint![1]}"`);
    const de = editor("de", []);
    expect(saveButton(de, "Projektauswahl speichern")).toContain('disabled=""');
    expect(de).toContain(
      "Wähle mindestens ein Projekt aus oder alle Projekte: Eine leere Auswahl kann nicht gespeichert werden.",
    );
  });

  it("one project, or all projects, can be saved once changed", () => {
    for (const selection of [["prj_a"], null]) {
      const button = saveButton(
        editor("en", selection),
        "Save project selection",
      );
      expect(button).not.toBe("");
      expect(button).not.toContain("disabled");
      expect(button).not.toContain("aria-describedby");
    }
    // Unchanged: nothing to save.
    expect(
      saveButton(
        editor("en", ["prj_a"], { dirty: false }),
        "Save project selection",
      ),
    ).toContain('disabled=""');
  });

  it("a refused check explains the options and keeps the picker", () => {
    const refusal = "None of the projects has Web Analytics.";
    const en = editor("en", ["prj_a", "prj_gone"], { refusal });
    expect(en).toContain(refusal);
    expect(en).toContain(
      "enable Web Analytics for a project in Vercel and load the list again, or choose another project; the data already collected is kept either way.",
    );
    expect(en).toContain(
      "Deleting this connection instead also deletes the data it collected.",
    );
    expect(en).toContain("at least one has to stay selected");
    // Reduced to one project it can still be saved.
    expect(en).toContain("prj_gone");
    expect(saveButton(en, "Save project selection")).not.toContain("disabled");
    // Reduced to none it cannot.
    expect(
      saveButton(editor("en", [], { refusal }), "Save project selection"),
    ).toContain('disabled=""');
    const de = editor("de", ["prj_a"], { refusal });
    expect(de).toContain(
      "Aktiviere Web Analytics für ein Projekt in Vercel und lade die Liste neu, oder wähle ein anderes Projekt",
    );
    expect(de).toContain(
      "Wenn du stattdessen diese Verbindung löschst, werden auch ihre importierten Daten gelöscht.",
    );
    expect(de).toContain("mindestens eines muss ausgewählt bleiben");
  });

  it("the API's refusal of an empty selection is worded in both languages", () => {
    const refused = new ApiError(400, "resource_selection_empty");
    expect(apiErrorMessage(refused, "en")).toBe(
      "Select at least one project, or all projects. An empty selection cannot be saved.",
    );
    expect(apiErrorMessage(refused, "de")).toBe(
      "Wähle mindestens ein Projekt oder alle Projekte aus. Eine leere Auswahl kann nicht gespeichert werden.",
    );
  });

  it("the app picker of the stores keeps its own note for an empty selection", () => {
    const html = renderI18n(
      <AppPicker resources={[]} value={[]} onChange={() => {}} />,
      "en",
    );
    expect(html).not.toContain("cannot be saved");
  });
});
