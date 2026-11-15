import { describe, expect, it, vi } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import { projectScope } from "@/lib/project-scope";
import { DataWorkspace } from "./data-workspace";
import { loadDataLists } from "@/lib/data-lists";
import { DataTable } from "./data-table";

const getDataWorkspace = vi.hoisted(() =>
  vi.fn(async () => ({ sources: [], preparations: [], models: [] })),
);
const getDataSources = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/data-api", async (original) => ({
  ...(await original<typeof import("@/lib/data-api")>()),
  getDataWorkspace,
  getDataSources,
}));

const A = "00000000-0000-4000-8000-0000000000aa";

describe("data lists follow the active project (#573)", () => {
  it("reloads the lists with the active project and the picker scope", async () => {
    await loadDataLists(
      "workspace",
      projectScope(A, [{ id: A, archivedAt: null }]),
    );
    expect(getDataWorkspace).toHaveBeenCalledWith("workspace", undefined, {
      project: A,
    });
    expect(getDataSources).toHaveBeenCalledWith("workspace", undefined, {
      project: A,
      unassigned: "include",
    });
  });

  it("reloads everything not archived under All projects", async () => {
    getDataWorkspace.mockClear();
    getDataSources.mockClear();
    await loadDataLists("workspace", projectScope(null, []));
    expect(getDataWorkspace).toHaveBeenCalledWith("workspace", undefined, {
      project: "all",
    });
    // Navigation and pickers are the same list then: loaded once.
    expect(getDataSources).not.toHaveBeenCalled();
  });

  it("opens a linked model from another project without listing it (#573)", () => {
    const model = {
      id: "00000000-0000-4000-8000-0000000000m1",
      name: "Revenue elsewhere",
      definition: {
        version: 1 as const,
        datasets: [],
        relationships: [],
        dimensions: [],
        measures: [],
      },
      projectId: "00000000-0000-4000-8000-0000000000bb",
      version: 1,
      publishedVersion: null,
      updatedAt: "2026-11-14T00:00:00.000Z",
    };
    const html = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{ sources: [], preparations: [], models: [] }}
        openModelId={model.id}
        openModel={model}
      />,
    );
    // The editor is open on it…
    expect(html).toContain('value="Revenue elsewhere"');
    // …and the models tab still counts the navigation list only.
    expect(html).toMatch(/aria-current="page"[^>]*>[^<]*<span>0<\/span>/);
  });

  it("names the active project in the header", () => {
    const html = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{ sources: [], preparations: [], models: [] }}
        projects={[{ id: A, name: "Alpha", archivedAt: null }]}
        activeProjectId={A}
      />,
    );
    expect(html).toContain("In Alpha");
  });
});

describe("store-template updates in data settings (11E)", () => {
  const REQUEST = "00000000-0000-4000-8000-0000000000f1";
  const MODEL = "00000000-0000-4000-8000-0000000000c1";
  const model = {
    id: MODEL,
    name: "App downloads",
    definition: {
      version: 1 as const,
      datasets: [],
      relationships: [],
      dimensions: [],
      measures: [],
    },
    projectId: null,
    version: 1,
    publishedVersion: 1,
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
  const install = {
    requestId: REQUEST,
    name: "App portfolio",
    templateVersion: 1,
    latestVersion: 2,
    updateAvailable: true,
    summary: {
      measures: { added: 1, changed: 2, removed: 0 },
      steps: { added: 0, changed: 3, removed: 0 },
      widgets: { added: 0, changed: 0, removed: 1 },
      conflicts: 0,
      removals: 0,
    },
    error: null,
    dashboardIds: [],
    modelIds: [MODEL],
    preparationIds: [],
    openUpdate: null,
    lastUpdate: null,
  };
  const render = (locale: "en" | "de" = "en") =>
    renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{
          sources: [],
          preparations: [],
          models: [model, { ...model, id: "other", name: "Own model" }],
          storeUpdates: [install],
        }}
        initialSection="models"
      />,
      locale,
    );

  it("shows the update summary in data settings", () => {
    const html = render();
    expect(html).toContain("Template update for App portfolio");
    expect(html).toContain(
      "2 measures changed, 1 added · 3 steps changed · 1 widget removed",
    );
    expect(html).toContain(
      `href="/workspaces/workspace/dashboards/stores/updates/${REQUEST}">Review the update</a>`,
    );
    // The listed model the update changes is marked; the customer's own is not.
    expect(html.match(/class="data-update-mark"/g)).toHaveLength(1);
    const row = html.slice(html.indexOf("App downloads"));
    expect(row.slice(0, row.indexOf("</tr>"))).toContain("data-update-mark");
  });

  it("shows it in German", () => {
    const html = render("de");
    expect(html).toContain("Vorlagen-Update für App portfolio");
    expect(html).toContain(
      "2 Kennzahlen geändert, 1 hinzugefügt · 3 Schritte geändert · 1 Widget entfernt",
    );
  });

  it("counts the drafts an applied update still waits on", () => {
    const html = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{
          sources: [],
          preparations: [],
          models: [model],
          storeUpdates: [
            {
              ...install,
              openUpdate: {
                id: "00000000-0000-4000-8000-0000000000e1",
                requestId: REQUEST,
                fromVersion: 1,
                toVersion: 2,
                createdAt: "2026-11-14T00:00:00.000Z",
                drafts: [
                  {
                    key: "model:downloads",
                    kind: "model",
                    recordId: MODEL,
                    name: "App downloads",
                    version: 2,
                    published: false,
                    stale: false,
                  },
                ],
                dashboards: [],
              },
            },
          ],
        }}
      />,
    );
    expect(html).toContain(
      "1 draft from the template update waits to be published.",
    );
    expect(html).toContain(">Open the update</a>");
  });

  it("says nothing without an update", () => {
    const html = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{
          sources: [],
          preparations: [],
          models: [model],
          storeUpdates: [{ ...install, updateAvailable: false, summary: null }],
        }}
        initialSection="models"
      />,
    );
    expect(html).not.toContain("Template update");
    expect(html).not.toContain("data-update-mark");
  });
});

describe("data workspace", () => {
  it.each(["en", "de"] as const)(
    "renders an actionable empty state in %s",
    (locale) => {
      const html = renderI18n(
        <DataWorkspace
          workspaceId="workspace"
          initial={{ sources: [], preparations: [], models: [] }}
        />,
        locale,
      );
      expect(html).toContain("/workspaces/workspace/connections/new");
      expect(html).toContain(
        locale === "en" ? "Start with your data" : "Beginne mit deinen Daten",
      );
      expect(html).not.toContain("undefined");
    },
  );
  it("escapes source values and keeps exact decimals readable", () => {
    const html = renderI18n(
      <DataTable
        fields={[
          { id: "text", name: "Name", type: "string", nullable: false },
          { id: "amount", name: "Amount", type: "decimal", nullable: false },
        ]}
        rows={[
          {
            text: "<script>private</script>",
            amount: "12345678901234567890.12",
          },
        ]}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("12345678901234567890.12");
  });
});
