import { describe, expect, it } from "vitest";

import type { PublishedModelCatalog } from "@netrics/contracts";

import {
  commitStateItem,
  stateMappingValues,
} from "@/components/studio-editor/state-fields";
import { scrollStatePlacement } from "@/components/scroll/scroll-widgets";

import { newWidget } from "./studio-new-widget";
import {
  stateBindingFor,
  stateFieldChoices,
  stateModels,
} from "./studio-state";

// The state widget's Studio defaults (#875): which fields a new widget
// binds, and which source values its mapping lists.

type Model = PublishedModelCatalog["models"][number];
const model = (
  modelId: string,
  dimensions: Array<[string, string, Model["dimensions"][number]["type"]]>,
): Model =>
  ({
    modelId,
    modelName: modelId,
    measures: [],
    dimensions: dimensions.map(([id, name, type]) => ({ id, name, type })),
  }) as unknown as Model;

const railway = model("railway", [
  ["project_id", "Project ID", "string"],
  ["project_name", "Project", "string"],
  ["service_id", "Service ID", "string"],
  ["service_name", "Service", "string"],
  ["state", "State", "string"],
  ["latest_status", "Latest deployment status", "string"],
  ["latest_created_at", "Latest deployment created", "timestamp"],
  ["latest_status_updated_at", "Latest deployment status changed", "timestamp"],
]);
const vercel = model("vercel", [
  ["project_id", "Project ID", "string"],
  ["project_name", "Project", "string"],
  ["web_analytics", "Web Analytics enabled", "boolean"],
  ["state", "State", "string"],
  ["live_ready_at", "Live deployment ready", "timestamp"],
  ["rolled_back", "Rolled back", "boolean"],
]);
const checks = model("checks", [
  ["url", "URL", "string"],
  ["healthy", "Healthy", "boolean"],
]);
const photos = model("photos", [
  ["title", "Title", "string"],
  ["taken_at", "Taken", "date"],
]);

describe("stateBindingFor (#875)", () => {
  it("binds a connector's state dataset: name, state and change", () => {
    expect(stateBindingFor(railway)).toEqual({
      modelId: "railway",
      nameDimensionId: "project_name",
      stateDimensionId: "state",
      changedAtDimensionId: "latest_status_updated_at",
      exclusions: [],
    });
  });

  it("skips a name a shared filter picks values of", () => {
    const filters = [
      { mappings: [{ modelId: "railway", dimensionId: "project_name" }] },
    ];
    expect(stateBindingFor(railway, filters)?.nameDimensionId).toBe(
      "service_name",
    );
  });

  it("binds the rolled-back flag and a yes/no health field", () => {
    expect(stateBindingFor(vercel)).toMatchObject({
      nameDimensionId: "project_name",
      stateDimensionId: "state",
      changedAtDimensionId: "live_ready_at",
      rolledBackDimensionId: "rolled_back",
    });
    expect(stateBindingFor(checks)).toMatchObject({
      nameDimensionId: "url",
      stateDimensionId: "healthy",
    });
  });

  it("offers only models with a state", () => {
    expect(stateBindingFor(photos)).toBeNull();
    expect(stateModels([photos, vercel]).map((m) => m.modelId)).toEqual([
      "vercel",
    ]);
  });

  it("creates a new widget as a list, or says what is missing", () => {
    expect(
      newWidget("state", {
        models: [photos, railway],
        metrics: [],
        imageIds: [],
        locale: "en",
      }),
    ).toMatchObject({
      widget: {
        type: "state",
        title: null,
        binding: { modelId: "railway", stateDimensionId: "state" },
        options: { layout: "list", item: null, limit: 8, states: {} },
      },
    });
    expect(
      newWidget("state", {
        models: [photos],
        metrics: [],
        imageIds: [],
        locale: "de",
      }),
    ).toEqual({
      reason:
        "Veröffentliche zuerst ein Modell mit einem Statusfeld, zum Beispiel aus Railway, Vercel oder Hetzner Cloud.",
    });
  });
});

describe("stateMappingValues (#875)", () => {
  it("lists mapped values, then unknown ones once, never built-in words", () => {
    expect(
      stateMappingValues({ Maintenance: "down" }, [
        "up",
        "Degraded",
        "degraded",
        null,
        "maintenance",
        "RUNNING",
      ]),
    ).toEqual(["Maintenance", "Degraded"]);
  });

  it("keeps a mapping of a built-in word", () => {
    expect(stateMappingValues({ ok: "down" }, ["ok"])).toEqual(["ok"]);
  });
});

describe("review fixes (#875)", () => {
  const hosts = model("hosts", [
    ["host", "Host", "string"],
    ["condition", "Condition", "string"],
  ]);

  it("offers a model whose fields are named otherwise; names only rank", () => {
    expect(stateModels([hosts]).map((m) => m.modelId)).toEqual(["hosts"]);
    expect(stateBindingFor(hosts)).toMatchObject({
      nameDimensionId: "host",
      stateDimensionId: "condition",
    });
    // A field named like a state still wins.
    expect(stateBindingFor(railway)?.stateDimensionId).toBe("state");
    // One text field cannot be both name and state.
    expect(
      stateBindingFor(model("one", [["host", "Host", "string"]])),
    ).toBeNull();
  });

  it("never offers one field for two roles", () => {
    const choices = stateFieldChoices(railway, {
      nameDimensionId: "service_name",
      stateDimensionId: "state",
    });
    expect(choices.names.map((d) => d.id)).not.toContain("state");
    expect(choices.states.map((d) => d.id)).not.toContain("service_name");
    expect(choices.names.map((d) => d.id)).toContain("service_name");
    expect(choices.states.map((d) => d.id)).toContain("state");
  });

  it("keeps inner spaces of an item name, trimming only on commit", () => {
    expect(commitStateItem("Billing API")).toBe("Billing API");
    expect(commitStateItem("  Billing API ")).toBe("Billing API");
    expect(commitStateItem("   ")).toBeNull();
  });

  it("grows the scroll card with the rows a list shows", () => {
    const { rowCapacity } = scrollStatePlacement(20, 1);
    expect(rowCapacity).toBeGreaterThanOrEqual(20);
    expect(scrollStatePlacement(3, 1).placement.unitBox.height).toBeLessThan(
      scrollStatePlacement(20, 1).placement.unitBox.height,
    );
  });
});
