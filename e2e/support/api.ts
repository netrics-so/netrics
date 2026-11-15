import { expect, type Page } from "@playwright/test";
import type {
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";

const ORIGIN = "http://localhost:3000";

/** A stored draft as the API answers it, with its exact JSON text. */
export interface Stored<T> {
  id: string;
  name: string;
  version: number;
  publishedVersion: number | null;
  value: T;
  /** The stored record as JSON, to compare byte for byte. */
  json: string;
}

async function list<T>(page: Page, path: string, key: string): Promise<T[]> {
  const response = await page.request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as Record<string, T[]>)[key]!;
}

/** The stored preparation named `name`: its graph, version and JSON. */
export async function readPreparation(
  page: Page,
  workspaceId: string,
  name: string,
): Promise<Stored<PreparationGraph>> {
  type View = {
    id: string;
    name: string;
    version: number;
    publishedVersion: number | null;
    graph: PreparationGraph;
  };
  const views = await list<View>(
    page,
    `/v1/workspaces/${workspaceId}/data/preparations`,
    "preparations",
  );
  const view = views.find((candidate) => candidate.name === name);
  expect(view, `preparation ${name}`).toBeDefined();
  return { ...view!, value: view!.graph, json: JSON.stringify(view) };
}

/** The stored model named `name`: its definition, version and JSON. */
export async function readModel(
  page: Page,
  workspaceId: string,
  name: string,
): Promise<Stored<SemanticModelDefinition>> {
  type View = {
    id: string;
    name: string;
    version: number;
    publishedVersion: number | null;
    definition: SemanticModelDefinition;
  };
  const views = await list<View>(
    page,
    `/v1/workspaces/${workspaceId}/data/models`,
    "models",
  );
  const view = views.find((candidate) => candidate.name === name);
  expect(view, `model ${name}`).toBeDefined();
  return { ...view!, value: view!.definition, json: JSON.stringify(view) };
}

/**
 * A dashboard with one value widget bound to a published measure, as the
 * Studio saves it. Answers the dashboard ID.
 */
export async function createMeasureDashboard(
  page: Page,
  workspaceId: string,
  input: { name: string; modelId: string; measureId: string },
): Promise<string> {
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: input.name,
        slides: [
          {
            widgets: [
              {
                type: "measure",
                x: 0,
                y: 0,
                w: 4,
                h: 3,
                binding: {
                  modelId: input.modelId,
                  measureIds: [input.measureId],
                  groupBy: [],
                  exclusions: [],
                },
                options: { view: "value", limit: 20 },
              },
            ],
          },
        ],
      },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { dashboard: { id: string } }).dashboard
    .id;
}

/**
 * The value a viewer of the dashboard sees in its single widget: the
 * dashboard query the viewer page and paired screens use.
 */
export async function readDashboardValue(
  page: Page,
  workspaceId: string,
  dashboardId: string,
): Promise<unknown> {
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/data`,
    { headers: { origin: ORIGIN }, data: { values: {} } },
  );
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as {
    widgets: Array<{
      error: string | null;
      result: {
        rows: Array<{ measures: Record<string, { value: unknown }> }>;
      } | null;
    }>;
  };
  const [widget] = body.widgets;
  expect(widget?.error ?? null).toBeNull();
  const cell = Object.values(widget!.result!.rows[0]!.measures)[0];
  return cell?.value;
}

/**
 * A model draft saved through the endpoint the model editor uses, as a store
 * template leaves one behind. Answers the model ID.
 */
export async function createModel(
  page: Page,
  workspaceId: string,
  input: { name: string; definition: SemanticModelDefinition },
): Promise<string> {
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/models`,
    { headers: { origin: ORIGIN }, data: input },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { model: { id: string } }).model.id;
}
