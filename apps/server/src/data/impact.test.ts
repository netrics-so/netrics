import { describe, expect, it } from "vitest";
import type { SemanticModelDefinition } from "@netrics/domain";
import {
  collectDataImpact,
  redactDataImpact,
  type ImpactGraph,
} from "./impact.js";

const P = "00000000-0000-4000-8000-000000000001";
const Q = "00000000-0000-4000-8000-000000000002";
const R = "00000000-0000-4000-8000-000000000003";
const M1 = "00000000-0000-4000-8000-000000000011";
const M2 = "00000000-0000-4000-8000-000000000012";
const D1 = "00000000-0000-4000-8000-000000000021";
const D2 = "00000000-0000-4000-8000-000000000022";
const D3 = "00000000-0000-4000-8000-000000000023";
const W1 = "00000000-0000-4000-8000-000000000031";
const W2 = "00000000-0000-4000-8000-000000000032";
const W3 = "00000000-0000-4000-8000-000000000033";
const LOBBY = "00000000-0000-4000-8000-000000000041";
const HALL = "00000000-0000-4000-8000-000000000042";

const revenue = {
  id: "revenue",
  name: "Revenue",
  kind: "aggregate",
  datasetId: "prepared:" + Q + ":out",
  aggregate: { id: "revenue", name: "Revenue", op: "sum", fieldId: "amount" },
} as const;
const revenue7 = {
  id: "revenue7",
  name: "Revenue 7 days",
  kind: "rolling",
  baseMeasureId: "revenue",
  timeDimensionId: "day",
  window: { unit: "day", length: 7 },
} as const;
const orders = {
  id: "orders",
  name: "Orders",
  kind: "aggregate",
  datasetId: "prepared:" + Q + ":out",
  aggregate: { id: "orders", name: "Orders", op: "count" },
} as const;
const perOrder = {
  id: "per_order",
  name: "Revenue per order",
  kind: "formula",
  expression: {
    kind: "call",
    fn: "divide",
    args: [
      { kind: "field", fieldId: "revenue7" },
      { kind: "field", fieldId: "orders" },
    ],
  },
} as const;

function definition(
  datasets: string[],
  measures: SemanticModelDefinition["measures"],
): SemanticModelDefinition {
  return {
    version: 1,
    datasets,
    relationships: [],
    dimensions: [],
    measures,
  } as SemanticModelDefinition;
}

const graph: ImpactGraph = {
  preparations: [
    { id: P, name: "Raw sales", draftReads: [], publishedReads: [] },
    { id: Q, name: "Clean sales", draftReads: [P], publishedReads: [P] },
    { id: R, name: "Unrelated", draftReads: [], publishedReads: [] },
  ],
  models: [
    {
      id: M1,
      name: "Revenue",
      publishedVersion: 4,
      draft: definition(["prepared:" + Q + ":out"], [
        { ...revenue, aggregate: { ...revenue.aggregate, op: "max" } },
        revenue7,
        orders,
        perOrder,
      ] as SemanticModelDefinition["measures"]),
      released: definition(["prepared:" + Q + ":out"], [
        revenue,
        revenue7,
        orders,
        perOrder,
      ] as SemanticModelDefinition["measures"]),
      releasePins: { [P]: 3, [Q]: 2 },
    },
    {
      id: M2,
      name: "Other",
      publishedVersion: 1,
      draft: definition(["source:x"], [orders] as never),
      released: definition(["source:x"], [orders] as never),
      releasePins: {},
    },
  ],
  widgets: [
    {
      id: W1,
      dashboardId: D1,
      type: "measure",
      title: "Weekly revenue",
      modelId: M1,
      measureIds: ["revenue7"],
    },
    {
      id: W2,
      dashboardId: D1,
      type: "measure",
      title: null,
      modelId: M1,
      measureIds: ["orders"],
    },
    {
      id: W3,
      dashboardId: D3,
      type: "measure",
      title: "Other",
      modelId: M2,
      measureIds: ["orders"],
    },
  ],
  filterModels: [
    { dashboardId: D2, modelId: M1 },
    { dashboardId: D1, modelId: M1 },
  ],
  dashboards: [
    { id: D1, name: "Sales" },
    { id: D2, name: "Filters only" },
    { id: D3, name: "Unrelated" },
  ],
  devices: [
    { id: LOBBY, name: "Lobby", dashboardId: D1 },
    { id: HALL, name: "Hall", dashboardId: D3 },
  ],
};

describe("collectDataImpact", () => {
  it("follows preparations transitively and reports the pinned version", () => {
    const impact = collectDataImpact(graph, { kind: "preparation", id: P });
    expect(impact.preparations).toEqual([{ id: Q, name: "Clean sales" }]);
    expect(impact.models).toEqual([
      { id: M1, name: "Revenue", publishedVersion: 4, pinnedVersion: 3 },
    ]);
    expect(impact.measures).toEqual([]);
    expect(impact.dashboards.map((d) => d.id)).toEqual([D2, D1]);
    expect(impact.screens).toEqual([
      { id: LOBBY, name: "Lobby", dashboardId: D1 },
    ]);
    expect(impact.changedMeasureIds).toBeNull();
  });

  it("finds models that read a dependent only through their release pins", () => {
    const pinnedOnly: ImpactGraph = {
      ...graph,
      models: [
        {
          ...graph.models[1]!,
          releasePins: { [Q]: 1 },
        },
      ],
    };
    const impact = collectDataImpact(pinnedOnly, {
      kind: "preparation",
      id: P,
    });
    expect(impact.models).toEqual([
      { id: M2, name: "Other", publishedVersion: 1, pinnedVersion: null },
    ]);
    expect(impact.dashboards.map((d) => d.id)).toEqual([D3]);
  });

  it("terminates on cycles and never lists the target itself", () => {
    const cyclic: ImpactGraph = {
      ...graph,
      preparations: [
        { id: P, name: "P", draftReads: [Q, P], publishedReads: [] },
        { id: Q, name: "Q", draftReads: [], publishedReads: [P] },
      ],
    };
    expect(
      collectDataImpact(cyclic, {
        kind: "preparation",
        id: P,
      }).preparations.map((p) => p.id),
    ).toEqual([Q]);
  });

  it("limits a measure target to widgets using it or a measure built on it", () => {
    const impact = collectDataImpact(graph, {
      kind: "measure",
      id: M1,
      measureIds: ["revenue"],
    });
    expect(impact.preparations).toEqual([]);
    expect(impact.models).toEqual([]);
    expect(impact.measures).toEqual([
      { modelId: M1, id: "revenue7", name: "Revenue 7 days" },
      { modelId: M1, id: "per_order", name: "Revenue per order" },
    ]);
    expect(impact.dashboards).toEqual([
      {
        id: D1,
        name: "Sales",
        widgets: [{ id: W1, type: "measure", title: "Weekly revenue" }],
        viaFilter: false,
      },
    ]);
    expect(impact.screens.map((s) => s.id)).toEqual([LOBBY]);
  });

  it("lists a latest items widget for its model, never for a measure (#810)", () => {
    const W4 = "00000000-0000-4000-8000-000000000034";
    const withItems: ImpactGraph = {
      ...graph,
      widgets: [
        ...graph.widgets,
        {
          id: W4,
          dashboardId: D3,
          type: "items",
          title: "Photos",
          modelId: M2,
          measureIds: [],
        },
      ],
    };
    const model = collectDataImpact(withItems, { kind: "model", id: M2 });
    expect(model.dashboards.find((d) => d.id === D3)!.widgets).toContainEqual({
      id: W4,
      type: "items",
      title: "Photos",
    });
    const measure = collectDataImpact(withItems, {
      kind: "measure",
      id: M2,
      measureIds: ["orders"],
    });
    expect(
      measure.dashboards.flatMap((d) => d.widgets.map((w) => w.id)),
    ).not.toContain(W4);
  });

  it("lists a dashboard bound only through a filter mapping for a model target", () => {
    const impact = collectDataImpact(graph, { kind: "model", id: M1 });
    expect(impact.dashboards.find((d) => d.id === D2)).toEqual({
      id: D2,
      name: "Filters only",
      widgets: [],
      viaFilter: true,
    });
    expect(impact.dashboards.find((d) => d.id === D1)).toMatchObject({
      viaFilter: false,
    });
    expect(
      impact.dashboards.find((d) => d.id === D1)!.widgets.map((w) => w.id),
    ).toEqual([W2, W1]);
    expect(impact.preparations).toEqual([]);
    expect(impact.models).toEqual([]);
  });

  it("ignores revoked devices (the graph never contains them) and lists a device once", () => {
    const impact = collectDataImpact(graph, { kind: "model", id: M1 });
    expect(impact.screens).toEqual([
      { id: LOBBY, name: "Lobby", dashboardId: D1 },
    ]);
  });

  it("reports changed measures against the live release, null when unpublished", () => {
    expect(
      collectDataImpact(graph, { kind: "model", id: M1 }).changedMeasureIds,
    ).toEqual(["revenue"]);
    expect(
      collectDataImpact(graph, {
        kind: "measure",
        id: M1,
        measureIds: ["orders"],
      }).changedMeasureIds,
    ).toEqual(["revenue"]);
    const added: ImpactGraph = {
      ...graph,
      models: [
        {
          ...graph.models[1]!,
          draft: definition(["source:x"], [revenue7] as never),
        },
      ],
    };
    expect(
      collectDataImpact(added, { kind: "model", id: M2 }).changedMeasureIds,
    ).toEqual(["orders", "revenue7"]);
    const unpublished: ImpactGraph = {
      ...graph,
      models: [{ ...graph.models[0]!, publishedVersion: null, released: null }],
    };
    expect(
      collectDataImpact(unpublished, { kind: "model", id: M1 })
        .changedMeasureIds,
    ).toBeNull();
  });

  it("ignores key order when comparing measures", () => {
    const reordered: ImpactGraph = {
      ...graph,
      models: [
        {
          ...graph.models[1]!,
          draft: definition(["source:x"], [
            {
              aggregate: { op: "count", name: "Orders", id: "orders" },
              datasetId: orders.datasetId,
              kind: "aggregate",
              name: "Orders",
              id: "orders",
            },
          ] as never),
        },
      ],
    };
    expect(
      collectDataImpact(reordered, { kind: "model", id: M2 }).changedMeasureIds,
    ).toEqual([]);
  });
});

describe("redactDataImpact", () => {
  const full = collectDataImpact(
    {
      ...graph,
      devices: [...graph.devices, { id: HALL, name: "Hall", dashboardId: D2 }],
    },
    { kind: "preparation", id: P },
  );

  it("counts what the caller may not see instead of naming it", () => {
    const out = redactDataImpact(full, {
      data: true,
      dashboards: false,
      screens: false,
    });
    expect(out.preparations).toEqual(full.preparations);
    expect(out.models).toEqual(full.models);
    expect(out.dashboards).toEqual([]);
    expect(out.screens).toEqual([]);
    expect(out.hidden).toEqual({
      preparations: 0,
      models: 0,
      dashboards: 2,
      screens: 2,
    });
    expect(JSON.stringify(out)).not.toContain("Lobby");
    expect(JSON.stringify(out)).not.toContain("Sales");
  });

  it("hides data items when the caller may not edit data", () => {
    const out = redactDataImpact(full, {
      data: false,
      dashboards: true,
      screens: true,
    });
    expect(out.preparations).toEqual([]);
    expect(out.models).toEqual([]);
    expect(out.measures).toEqual([]);
    expect(out.dashboards).toEqual(full.dashboards);
    expect(out.screens).toEqual(full.screens);
    expect(out.hidden).toEqual({
      preparations: 1,
      models: 1,
      dashboards: 0,
      screens: 0,
    });
  });

  it("counts screens instead of naming them when dashboards are hidden", () => {
    const out = redactDataImpact(full, {
      data: true,
      dashboards: false,
      screens: true,
    });
    expect(out.dashboards).toEqual([]);
    expect(out.screens).toEqual([]);
    expect(out.hidden).toMatchObject({ dashboards: 2, screens: 2 });
    for (const dashboard of full.dashboards)
      expect(JSON.stringify(out)).not.toContain(dashboard.id);
  });

  it("names everything when the caller may see everything", () => {
    expect(
      redactDataImpact(full, { data: true, dashboards: true, screens: true }),
    ).toEqual({
      ...full,
      hidden: { preparations: 0, models: 0, dashboards: 0, screens: 0 },
    });
  });
});
