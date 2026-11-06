import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepForm } from "@/components/data/step-form";
import { describe, expect, it } from "vitest";
import {
  executePreparation,
  type PreparationGraph,
  type DataTable,
} from "@netrics/domain";
import {
  buildAppendStep,
  suggestAppendColumnMapping,
  preparationInputNodes,
  replacePreparationStep,
  removePreparationStep,
  movePreparationStep,
  preparationMoveProblem,
} from "./preparation-editing";

const source: DataTable = {
  fields: [
    { id: "id", name: "ID", type: "string", nullable: false },
    { id: "amount", name: "Amount", type: "decimal", nullable: false },
  ],
  rows: [
    { id: "a", amount: "2.50" },
    { id: "b", amount: "5.00" },
  ],
};
const graph: PreparationGraph = {
  version: 1,
  nodes: [
    { id: "source", type: "source", datasetId: "rows" },
    {
      id: "rename",
      type: "rename",
      input: "source",
      names: { id: "Identity", amount: "Revenue" },
    },
    {
      id: "filter",
      type: "filter",
      input: "rename",
      expression: {
        kind: "call",
        fn: "eq",
        args: [
          { kind: "field", fieldId: "id" },
          { kind: "literal", type: "string", value: "a" },
        ],
      },
    },
    {
      id: "calculate",
      type: "calculate",
      input: "filter",
      fieldId: "doubled",
      name: "Doubled",
      expression: {
        kind: "call",
        fn: "multiply",
        args: [
          { kind: "field", fieldId: "amount" },
          { kind: "literal", type: "decimal", value: "2" },
        ],
      },
    },
    {
      id: "output",
      type: "select",
      input: "calculate",
      fields: ["id", "doubled"],
    },
  ],
  outputs: ["output"],
};
const evaluate = (definition: PreparationGraph) =>
  executePreparation(definition, new Map([["rows", source]])).outputs.output!;
describe("preparation graph editing", () => {
  it("edits a calculation without changing downstream identities or mutating the saved graph", () => {
    const original = graph.nodes[3]!;
    if (original.type !== "calculate") throw new Error("fixture");
    const changed = replacePreparationStep(graph, original.id, [
      {
        ...original,
        name: "Tripled",
        expression: {
          kind: "call",
          fn: "multiply",
          args: [
            { kind: "field", fieldId: "amount" },
            { kind: "literal", type: "decimal", value: "3" },
          ],
        },
      },
    ]);
    expect(changed.outputs).toEqual(["output"]);
    expect(evaluate(changed).rows).toEqual([{ id: "a", doubled: "7.5" }]);
    expect(evaluate(graph).rows).toEqual([{ id: "a", doubled: "5" }]);
    expect(() =>
      replacePreparationStep(graph, original.id, [
        { ...original, fieldId: "another" },
      ]),
    ).toThrow("identityChanged");
  });
  it("moves adjacent operations by rewiring their inputs and keeps the published output ID", () => {
    const moved = movePreparationStep(graph, "calculate", "up");
    expect(moved.nodes.find((node) => node.id === "calculate")).toMatchObject({
      input: "rename",
      fieldId: "doubled",
    });
    expect(moved.nodes.find((node) => node.id === "filter")).toMatchObject({
      input: "calculate",
    });
    expect(moved.nodes.find((node) => node.id === "output")).toMatchObject({
      input: "filter",
    });
    expect(evaluate(moved)).toEqual(evaluate(graph));
    expect(movePreparationStep(moved, "calculate", "down")).toEqual(graph);
    expect(() => movePreparationStep(graph, "output", "up")).toThrow(
      "outputIdentity",
    );
    expect(() => movePreparationStep(graph, "rename", "up")).toThrow(
      "branchMove",
    );
  });
  it("leaves a shared branch intact and refuses to reorder across it", () => {
    const branched: PreparationGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "branch", type: "select", input: "filter", fields: ["id"] },
      ],
      outputs: ["output", "branch"],
    };
    expect(preparationMoveProblem(branched, "calculate", "up")).toBe(
      "branchMove",
    );
    const next = removePreparationStep(branched, "filter");
    expect(next.nodes.find((node) => node.id === "calculate")).toMatchObject({
      input: "rename",
    });
    expect(next.nodes.find((node) => node.id === "branch")).toMatchObject({
      input: "rename",
    });
    expect(next.outputs).toEqual(["output", "branch"]);
    expect(evaluate(next).rows).toHaveLength(2);
    const withoutOutput = removePreparationStep(graph, "output");
    expect(withoutOutput.outputs).toEqual(["output"]);
    expect(
      withoutOutput.nodes.find((node) => node.id === "output"),
    ).toMatchObject({ type: "calculate", fieldId: "doubled" });
    expect(() => removePreparationStep(graph, "source")).toThrow("sourceInUse");
  });
  it("removes the final unary operation while keeping its published identity and all branches", () => {
    const branched: PreparationGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "before-branch",
          type: "select",
          input: "calculate",
          fields: ["id", "doubled"],
        },
        {
          id: "after-branch",
          type: "rename",
          input: "output",
          names: { doubled: "Public branch" },
        },
      ],
      outputs: ["output", "before-branch", "after-branch"],
    };
    const next = removePreparationStep(branched, "output");
    expect(next.outputs).toEqual(branched.outputs);
    expect(
      next.nodes.find((node) => node.id === "before-branch"),
    ).toMatchObject({ input: "output" });
    expect(next.nodes.find((node) => node.id === "after-branch")).toMatchObject(
      { input: "output" },
    );
    expect(next.nodes.find((node) => node.id === "output")).toMatchObject({
      type: "calculate",
      fieldId: "doubled",
    });
    expect(evaluate(next).rows).toEqual([
      { id: "a", amount: "2.50", doubled: "5" },
    ]);
    const shared: PreparationGraph = {
      ...graph,
      outputs: ["calculate", "output"],
    };
    expect(() => removePreparationStep(shared, "output")).toThrow(
      "outputIdentity",
    );
    expect(() =>
      removePreparationStep(
        {
          version: 1,
          nodes: [{ id: "output", type: "source", datasetId: "rows" }],
          outputs: ["output"],
        },
        "output",
      ),
    ).toThrow("outputIdentity");
  });
  it("requires an explicit surviving merge input and retains the other branch nodes", () => {
    const merged: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "left", type: "source", datasetId: "rows" },
        { id: "right", type: "source", datasetId: "other" },
        {
          id: "merge",
          type: "join",
          left: "left",
          right: "right",
          keys: [{ left: "id", right: "id" }],
          mode: "left",
          cardinality: "many_to_one",
          rightPrefix: "other.",
        },
        { id: "output", type: "select", input: "merge", fields: ["id"] },
      ],
      outputs: ["output"],
    };
    expect(() => removePreparationStep(merged, "merge")).toThrow("chooseInput");
    const removed = removePreparationStep(merged, "merge", "left");
    expect(removed.nodes.map((node) => node.id)).toEqual([
      "left",
      "right",
      "output",
    ]);
    expect(removed.nodes.at(-1)).toMatchObject({ input: "left" });
    const join = merged.nodes[2]!;
    if (join.type !== "join") throw new Error("fixture");
    const edited = replacePreparationStep(merged, "merge", [
      {
        ...join,
        mode: "inner",
        keys: [
          { left: "id", right: "id" },
          { left: "amount", right: "amount" },
        ],
      },
    ]);
    expect(edited.nodes[2]).toMatchObject({
      id: "merge",
      rightPrefix: "other.",
      keys: [
        { left: "id", right: "id" },
        { left: "amount", right: "amount" },
      ],
    });
    expect(() =>
      replacePreparationStep(merged, "merge", [
        { ...join, rightPrefix: "changed." },
      ]),
    ).toThrow("identityChanged");
  });
  it("keeps all append inputs and rename entries when editing branching templates", () => {
    const appended: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "one", type: "source", datasetId: "rows" },
        { id: "two", type: "source", datasetId: "rows" },
        { id: "three", type: "source", datasetId: "rows" },
        { id: "append", type: "append", inputs: ["one", "two", "three"] },
        {
          id: "output",
          type: "rename",
          input: "append",
          names: { id: "Identity", amount: "Revenue" },
        },
      ],
      outputs: ["output"],
    };
    const edited = replacePreparationStep(appended, "append", [
      { id: "four", type: "source", datasetId: "rows" },
      { id: "append", type: "append", inputs: ["one", "two", "three", "four"] },
    ]);
    expect(evaluate(edited).rows).toHaveLength(8);
    expect(edited.nodes.at(-1)).toEqual(appended.nodes.at(-1));
    expect(
      preparationInputNodes(appended, "append").map((node) => node.id),
    ).toEqual(["one", "two", "three"]);
    expect(() =>
      replacePreparationStep(appended, "append", [
        { id: "append", type: "append", inputs: ["one", "output"] },
      ]),
    ).toThrow("cycle");
  });
  it("lets full-output validation catch incompatible reorders instead of dropping dependent columns", () => {
    const dependent: PreparationGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "filter"
          ? {
              ...node,
              type: "filter",
              input: "calculate",
              expression: {
                kind: "call",
                fn: "gt",
                args: [
                  { kind: "field", fieldId: "doubled" },
                  { kind: "literal", type: "decimal", value: "0" },
                ],
              },
            }
          : node.id === "calculate"
            ? { ...node, input: "rename" }
            : node.id === "output"
              ? { ...node, input: "filter" }
              : node,
      ),
    };
    expect(evaluate(dependent).rows).toHaveLength(2);
    expect(() =>
      evaluate(movePreparationStep(dependent, "filter", "up")),
    ).toThrow("expression_field_not_found");
    expect(evaluate(dependent).rows).toHaveLength(2);
  });
});

it("rewrites append mapping keys when a final step promotes its predecessor", () => {
  const definition: PreparationGraph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: "other", type: "source", datasetId: "rows" },
      {
        id: "appended",
        type: "append",
        inputs: ["calculate", "other"],
        columnMappings: {
          calculate: { doubled: "total" },
          other: { amount: "total" },
        },
      },
    ],
    outputs: ["output", "appended"],
  };
  const removed = removePreparationStep(definition, "output");
  expect(removed.nodes.find((node) => node.id === "appended")).toMatchObject({
    inputs: ["output", "other"],
    columnMappings: {
      output: { doubled: "total" },
      other: { amount: "total" },
    },
  });
});

it("renders every existing rename, append input and composite join key for editing", () => {
  const render = (
    initial: PreparationGraph["nodes"][number],
    definition = graph,
  ) =>
    renderToStaticMarkup(
      createElement(StepForm, {
        workspaceId: "workspace",
        input: "source",
        fields: source.fields,
        sources: [],
        graph: definition,
        initial,
        busy: false,
        onApply: async () => undefined,
        onCancel: () => undefined,
      }),
    );
  expect(render(graph.nodes[1]!)).toContain('value="Identity"');
  expect(render(graph.nodes[1]!)).toContain('value="Revenue"');
  const append = render({
    id: "combined",
    type: "append",
    inputs: ["source", "rename", "filter"],
  });
  expect(append).toContain("Input 3");
  expect(append).toContain('value="step:filter" selected');
  expect(append).toContain("Match columns before appending");
  const merge = render({
    id: "merged",
    type: "join",
    left: "source",
    right: "rename",
    keys: [
      { left: "id", right: "id" },
      { left: "amount", right: "amount" },
    ],
    mode: "inner",
    cardinality: "one_to_one",
    rightPrefix: "retained.",
    rightNamePrefix: "Account / ",
  });
  expect(merge.match(/Column in this data/g)).toHaveLength(2);
  expect(merge).toContain('value="Account / "');
  expect(merge).toContain('value="inner" selected');
});

it("shows the existing aggregate filter instead of silently removing it", () => {
  const initial = {
    id: "grouped",
    type: "group" as const,
    input: "source",
    keys: [],
    aggregates: [
      {
        id: "total",
        name: "Filtered total",
        op: "sum" as const,
        fieldId: "amount",
        filter: {
          kind: "call" as const,
          fn: "eq" as const,
          args: [
            { kind: "field" as const, fieldId: "id" },
            { kind: "literal" as const, type: "string" as const, value: "a" },
          ],
        },
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(StepForm, {
      workspaceId: "workspace",
      input: "source",
      fields: source.fields,
      sources: [],
      graph,
      initial,
      busy: false,
      onApply: async () => undefined,
      onCancel: () => undefined,
    }),
  );
  expect(html).toContain("Filter before aggregation (optional)");
  expect(html).toContain("EQ([ID], &quot;a&quot;)");
});

it("normalizes explicitly matched append inputs with different identities and keeps exact values", () => {
  const other: DataTable = {
    ...source,
    fields: source.fields.map((field) => ({ ...field, id: "web_" + field.id })),
    rows: source.rows.map((row) => ({
      web_id: row.id,
      web_amount: row.amount,
    })),
  };
  const suggestion = suggestAppendColumnMapping(source.fields, other.fields);
  expect(suggestion).toEqual({ web_id: "id", web_amount: "amount" });
  const append = buildAppendStep("output", [
    {
      id: "one",
      mapping: suggestAppendColumnMapping(source.fields, source.fields),
    },
    { id: "two", mapping: suggestion },
  ]);
  const definition: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "one", type: "source", datasetId: "first" },
      { id: "two", type: "source", datasetId: "second" },
      append,
    ],
    outputs: ["output"],
  };
  const result = executePreparation(
    definition,
    new Map([
      ["first", source],
      ["second", other],
    ]),
  ).outputs.output!;
  expect(result.fields.map((field) => field.id)).toEqual(["id", "amount"]);
  expect(result.rows).toEqual([...source.rows, ...source.rows]);
  expect(
    buildAppendStep("output", [{ id: "one" }, { id: "two" }]),
  ).not.toHaveProperty("columnMappings");
  expect(() =>
    buildAppendStep("output", [
      { id: "one", mapping: {} },
      { id: "two", mapping: suggestion },
    ]),
  ).toThrow("preparation_append_mapping_invalid");
});

it("does not suggest ambiguous name joins or reuse one source column for several target identities", () => {
  const target = {
    id: "left",
    name: "Name",
    type: "string" as const,
    nullable: false,
  };
  expect(
    suggestAppendColumnMapping(
      [target, { ...target, id: "right" }],
      [{ ...target, id: "source" }],
    ),
  ).toEqual({});
  expect(
    suggestAppendColumnMapping(
      [target],
      [
        { ...target, id: "one" },
        { ...target, id: "two" },
      ],
    ),
  ).toEqual({});
  expect(
    suggestAppendColumnMapping([target], [target, { ...target, id: "other" }]),
  ).toEqual({ left: "left" });
});

it("changes a promoted sole source without changing its published output identity", () => {
  const definition: PreparationGraph = {
    version: 1,
    nodes: [{ id: "published_output", type: "source", datasetId: "old" }],
    outputs: ["published_output"],
  };
  const changed = replacePreparationStep(definition, "published_output", [
    { id: "published_output", type: "source", datasetId: "new" },
  ]);
  expect(changed.outputs).toEqual(definition.outputs);
  expect(changed.nodes).toEqual([
    { id: "published_output", type: "source", datasetId: "new" },
  ]);
  expect(definition.nodes[0]).toEqual({
    id: "published_output",
    type: "source",
    datasetId: "old",
  });
});
