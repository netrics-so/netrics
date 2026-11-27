import { describe, expect, it } from "vitest";

import type { PublishedModelCatalog } from "@netrics/contracts";
import { statusLayout } from "@netrics/domain";

import {
  commitStateItem,
  stateMappingValues,
} from "@/components/studio-editor/state-fields";
import { scrollStatePlacement } from "@/components/scroll/scroll-widgets";

import { newWidget } from "./studio-new-widget";
import { contentBox } from "./studio-render";
import {
  stateBindingFor,
  stateFieldChoices,
  stateItemNames,
  stateModels,
  withStateField,
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

  it("never offers one field for two roles, and swaps name and state at once (final review)", () => {
    const hostsBinding = {
      modelId: "hosts",
      nameDimensionId: "host",
      stateDimensionId: "condition",
      exclusions: [],
    };
    // With two text fields, either can be picked for either role…
    const choices = stateFieldChoices(hosts, hostsBinding);
    expect(choices.names.map((d) => d.id)).toEqual(["host", "condition"]);
    expect(choices.states.map((d) => d.id)).toEqual(["host", "condition"]);
    // …and picking the other role's field swaps them, never one in two roles.
    expect(
      withStateField(hostsBinding, "stateDimensionId", "host"),
    ).toMatchObject({ nameDimensionId: "condition", stateDimensionId: "host" });
    expect(
      withStateField(hostsBinding, "nameDimensionId", "condition"),
    ).toMatchObject({ nameDimensionId: "condition", stateDimensionId: "host" });
    expect(withStateField(hostsBinding, "nameDimensionId", "host")).toEqual(
      hostsBinding,
    );
  });

  it("offers only item names that match whole, never a cut one (final review)", () => {
    const long = "y".repeat(199) + "…";
    expect(
      stateItemNames([
        { name: "web" },
        { name: long },
        { name: null },
        { name: "web" },
      ]),
    ).toEqual(["web"]);
  });

  it("keeps an item name exactly as written (#900)", () => {
    expect(commitStateItem("Billing API")).toBe("Billing API");
    expect(commitStateItem(" Billing API ")).toBe(" Billing API ");
    expect(commitStateItem("   ")).toBeNull();
    expect(commitStateItem("")).toBeNull();
  });

  it("grows the scroll card with the rows a list shows", () => {
    const { rowCapacity } = scrollStatePlacement(20, 1, "Status");
    expect(rowCapacity).toBeGreaterThanOrEqual(20);
    expect(
      scrollStatePlacement(3, 1, "Status").placement.unitBox.height,
    ).toBeLessThan(
      scrollStatePlacement(20, 1, "Status").placement.unitBox.height,
    );
  });
});

describe("follow-ups of the final review (#900)", () => {
  it("sizes the scroll card for its own title, wrapped", () => {
    const title =
      "Production services across every project and environment we deploy to";
    const { placement } = scrollStatePlacement(5, 1, title);
    const box = contentBox(placement, false);
    expect(
      statusLayout({
        label: title,
        width: box.width,
        height: box.height,
        fontScale: 1,
      }).rowCapacity,
    ).toBeGreaterThanOrEqual(5);
  });

  const checks = model("checks", [
    ["url", "URL", "string"],
    ["healthy", "Healthy", "boolean"],
  ]);
  const binding = {
    modelId: "checks",
    nameDimensionId: "url",
    stateDimensionId: "healthy",
    exclusions: [],
  };

  it("never offers a swap that would make a yes/no field the name", () => {
    expect(stateFieldChoices(checks, binding).states.map((d) => d.id)).toEqual([
      "healthy",
    ]);
    expect(withStateField(binding, "stateDimensionId", "url", checks)).toBe(
      binding,
    );
    // With another text field, the swap names the item by it.
    const more = model("more", [
      ["url", "URL", "string"],
      ["region", "Region", "string"],
      ["healthy", "Healthy", "boolean"],
    ]);
    expect(stateFieldChoices(more, binding).states.map((d) => d.id)).toEqual([
      "url",
      "region",
      "healthy",
    ]);
    expect(
      withStateField(binding, "stateDimensionId", "url", more),
    ).toMatchObject({ nameDimensionId: "region", stateDimensionId: "url" });
  });

  it("picks a default state that leaves a text field for the name", () => {
    const flagged = model("flagged", [
      ["status", "Status", "string"],
      ["healthy", "Healthy", "boolean"],
    ]);
    expect(stateBindingFor(flagged)).toMatchObject({
      nameDimensionId: "status",
      stateDimensionId: "healthy",
    });
    expect(stateModels([flagged]).map((m) => m.modelId)).toEqual(["flagged"]);
  });

  it("keeps the preferred name when only text fields can be the state", () => {
    const plain = model("plain", [
      ["condition_id", "Condition ID", "string"],
      ["host", "Host", "string"],
    ]);
    expect(stateBindingFor(plain)).toMatchObject({
      nameDimensionId: "host",
      stateDimensionId: "condition_id",
    });
  });
});
