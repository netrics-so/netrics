/**
 * The web half of the project navigation checks (#573, milestone 11E):
 * every picker offers the active project's items and unassigned ones,
 * never those of an archived project, while a current value from an
 * archived project stays (screens keep their dashboards); project selects
 * hide archived projects unless current; and every list the pages load
 * names its workspace and carries the project filter. The server half
 * (filters, isolation, payloads) lives in apps/server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApproveDeviceForm } from "@/app/(site)/devices/approve/approve-form";
import { DeviceControls } from "@/app/workspaces/[workspaceId]/device-controls";
import { ProjectSelect } from "@/components/project-select";
import { listConnections, listDashboards } from "@/lib/api";
import { loadPublishedModels } from "@/lib/dashboard-data-api";
import { getDataSources, getDataWorkspace } from "@/lib/data-api";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  boundMetricKeys,
  editorSources,
  pickableDashboards,
  pickableMetrics,
  referencedModelIds,
  referencedSourceIds,
} from "@/lib/project-pickers";
import {
  inPickerScope,
  navigationQuery,
  pickerQuery,
  projectScope,
  type ProjectScope,
} from "@/lib/project-scope";
import { pickableModels } from "@/lib/use-published-models";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const W = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const C = "00000000-0000-4000-8000-0000000000cc";
const projects = [
  { id: A, name: "Alpha", archivedAt: null },
  { id: B, name: "Beta", archivedAt: "2026-11-14T00:00:00.000Z" },
  { id: C, name: "Gamma", archivedAt: null },
];

/** One item per place: the active project A, archived B, other C, none. */
const ITEMS = [
  { id: "00000000-0000-4000-8000-00000000000a", name: "in A", projectId: A },
  { id: "00000000-0000-4000-8000-00000000000b", name: "in B", projectId: B },
  { id: "00000000-0000-4000-8000-00000000000c", name: "in C", projectId: C },
  { id: "00000000-0000-4000-8000-00000000000d", name: "none", projectId: null },
];
const byName = (name: string) => ITEMS.find((item) => item.name === name)!;

/** What the server returns for pickerQuery (its own tests prove that). */
function serverPicker(scope: ProjectScope) {
  return ITEMS.filter((item) => inPickerScope(item.projectId, scope));
}

/** Labels of the options with a value (placeholders like "None" aside). */
function optionNames(html: string, selectId: string): string[] {
  const start = html.indexOf(`id="${selectId}"`);
  const select = html.slice(start, html.indexOf("</select>", start));
  return [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)]
    .filter(([, value]) => value !== "")
    .map(([, , label]) => label ?? "");
}

interface PickerCase {
  name: string;
  keepsCurrent: boolean;
  render: (input: { scope: ProjectScope; current?: string }) => string[];
}

const PICKERS: PickerCase[] = [
  {
    name: "Studio published-model picker",
    keepsCurrent: true,
    render: ({ scope, current }) => {
      const all = ITEMS.map((item) => ({
        modelId: item.id,
        modelName: item.name,
        measures: [],
        dimensions: [],
      }));
      const draft = current
        ? {
            slides: [
              { widgets: [{ binding: { modelId: byName(current).id } }] },
            ],
          }
        : { slides: [] };
      return pickableModels(
        all,
        new Set(serverPicker(scope).map((item) => item.id)),
        referencedModelIds(draft),
      ).map((model) => model.modelName);
    },
  },
  {
    name: "Studio metric picker",
    keepsCurrent: true,
    render: ({ scope, current }) => {
      const metrics = ITEMS.map((item) => ({
        connectionId: item.id,
        key: "downloads",
        name: item.name,
      }));
      const draft = current
        ? {
            slides: [
              {
                widgets: [
                  {
                    connectionId: byName(current).id,
                    metricKey: "downloads",
                  },
                ],
              },
            ],
          }
        : {};
      return pickableMetrics(
        metrics,
        (connectionId) =>
          ITEMS.find((item) => item.id === connectionId)?.projectId ?? null,
        scope,
        boundMetricKeys(draft),
      ).map((metric) => metric.name);
    },
  },
  {
    name: "screens dashboard assignment",
    keepsCurrent: true,
    render: ({ scope, current }) => {
      const dashboardId = current ? byName(current).id : null;
      const html = renderI18n(
        <DeviceControls
          workspaceId={W}
          device={{
            id: "device",
            name: "Lobby TV",
            dashboardId,
            rotation: 0,
            displayMode: "screen",
            platform: null,
          }}
          appleTv={false}
          dashboards={pickableDashboards(ITEMS, scope, dashboardId)}
        />,
      );
      return optionNames(html, "device-device-dashboard");
    },
  },
  {
    name: "device approval dashboard select",
    keepsCurrent: false,
    render: ({ scope }) => {
      const html = renderI18n(
        <ApproveDeviceForm
          initialCode=""
          workspaces={[
            {
              id: W,
              name: "Sales",
              dashboards: pickableDashboards(ITEMS, scope, null),
            },
          ]}
        />,
      );
      return optionNames(html, "pairing-dashboard");
    },
  },
  {
    name: "data editors' source picker",
    keepsCurrent: true,
    render: ({ scope, current }) => {
      const draft = current
        ? {
            graph: {
              nodes: [
                { id: "n", type: "source", datasetId: byName(current).id },
              ],
            },
          }
        : null;
      return editorSources(
        serverPicker(scope),
        ITEMS,
        referencedSourceIds(draft),
      ).map((source) => source.name);
    },
  },
];

describe("project navigation checks: pickers (#573)", () => {
  it.each(PICKERS)(
    "$name shows the active project and unassigned items, never archived ones",
    ({ render }) => {
      expect(render({ scope: projectScope(A, projects) })).toEqual([
        "in A",
        "none",
      ]);
    },
  );

  it.each(PICKERS)(
    "$name shows everything not archived under All projects",
    ({ render }) => {
      expect(render({ scope: projectScope(null, projects) })).toEqual([
        "in A",
        "in C",
        "none",
      ]);
    },
  );

  it.each(PICKERS.filter((picker) => picker.keepsCurrent))(
    "$name keeps the current value from an archived project",
    ({ render }) => {
      const names = render({
        scope: projectScope(null, projects),
        current: "in B",
      });
      expect(names).toContain("in B");
      expect(names).not.toContain(undefined);
    },
  );

  it("treats an archived active project as All projects", () => {
    const scope = projectScope(B, projects);
    expect(navigationQuery(scope)).toEqual({ project: "all" });
    expect(pickerQuery(scope)).toEqual({ project: "all" });
  });
});

describe("project navigation checks: project selects (#573)", () => {
  const render = (value: string | null) =>
    optionNames(
      renderI18n(
        <ProjectSelect
          id="project"
          projects={projects}
          value={value}
          onChange={() => {}}
        />,
      ),
      "project",
    );

  it("offers projects that are not archived", () => {
    expect(render(A)).toEqual(["Alpha", "Gamma"]);
    expect(render(null)).toEqual(["Alpha", "Gamma"]);
  });

  it("keeps an archived current project", () => {
    expect(render(B)).toEqual(["Alpha", "Beta (Archived)", "Gamma"]);
  });
});

describe("project navigation checks: lists (#573)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown) {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const paths = (fetch: ReturnType<typeof stubFetch>) =>
    fetch.mock.calls.map(([url]) => String(url));

  it("browser lists name the workspace and carry the filter", async () => {
    const scope = projectScope(A, projects);
    const fetch = stubFetch({
      models: [],
      sources: [],
      preparations: [],
    });
    await loadPublishedModels(W, pickerQuery(scope));
    await getDataWorkspace(W, undefined, navigationQuery(scope));
    await getDataSources(W, undefined, pickerQuery(scope));
    expect(paths(fetch)).toEqual([
      `/v1/workspaces/${W}/dashboards/published-models?project=${A}&unassigned=include`,
      `/v1/workspaces/${W}/data/sources?project=${A}`,
      `/v1/workspaces/${W}/data/preparations?project=${A}`,
      `/v1/workspaces/${W}/data/models?project=${A}`,
      // Store-template updates (11E) are workspace-wide, as in the Studio.
      `/v1/workspaces/${W}/dashboard-templates/stores/installs`,
      `/v1/workspaces/${W}/dashboard-templates/developer/installs`,
      `/v1/workspaces/${W}/data/sources?project=${A}&unassigned=include`,
    ]);
  });

  it("server lists name the workspace and carry the filter", async () => {
    const fetch = stubFetch({ dashboards: [], connections: [] });
    const query = navigationQuery(projectScope(null, projects));
    await listDashboards(new Headers({ cookie: "cookie" }), W, query);
    await listConnections(new Headers({ cookie: "cookie" }), W, query);
    // No query: the full list, e.g. names of what screens show.
    await listDashboards(new Headers({ cookie: "cookie" }), W);
    expect(paths(fetch).map((url) => url.slice(url.indexOf("/v1/")))).toEqual([
      `/v1/workspaces/${W}/dashboards?project=all`,
      `/v1/workspaces/${W}/connections?project=all`,
      `/v1/workspaces/${W}/dashboards`,
    ]);
  });
});
