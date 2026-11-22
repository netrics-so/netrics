import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { AppPicker } from "./app-picker";
import { ProjectSelection, pickerState } from "./project-selection";
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

function render(locale: Locale, config: Record<string, unknown>) {
  return renderI18n(
    <ProjectSelection
      workspaceId="w"
      connection={{ id: "c", config } as unknown as ConnectionDetail}
      connector={connector}
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
