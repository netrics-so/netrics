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
