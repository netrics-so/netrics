import { describe, expect, it } from "vitest";
import type { DataField } from "./data-expression.js";
import {
  executePreparation,
  type DataTable,
  type PreparationNode,
} from "./data-preparation.js";

// The field role "image" is presentation metadata (dataset contract v1,
// ADR 0026): preparations keep it where a field is carried unchanged and
// drop it on anything calculated, cast or aggregated.
const source: DataTable = {
  fields: [
    { id: "id", name: "ID", type: "string", nullable: false },
    { id: "title", name: "Title", type: "string", nullable: false },
    {
      id: "image",
      name: "Image",
      type: "string",
      nullable: true,
      role: "image",
    },
    { id: "views", name: "Views", type: "integer", nullable: false },
  ],
  rows: [
    { id: "a", title: "Alpha", image: "https://img.test/a.png", views: 3 },
    { id: "b", title: "Beta", image: "https://img.test/b.png", views: 5 },
  ],
};
const plain: DataTable = {
  ...source,
  fields: source.fields.map(({ role: _role, ...f }) => f),
};

function run(
  nodes: PreparationNode[],
  sources: Record<string, DataTable> = { src: source },
): DataField[] {
  const output = nodes.at(-1)!.id;
  return executePreparation(
    { version: 1, nodes, outputs: [output] },
    new Map(Object.entries(sources)),
  ).outputs[output]!.fields;
}
const sourceNode: PreparationNode = {
  id: "s",
  type: "source",
  datasetId: "src",
};
const roleOf = (fields: DataField[], id: string) =>
  fields.find((f) => f.id === id)?.role;

describe("the image field role through preparations", () => {
  it("keeps the image role through select, rename, filter, replace and deduplicate", () => {
    const fields = run([
      sourceNode,
      { id: "sel", type: "select", input: "s", fields: ["id", "image"] },
      { id: "ren", type: "rename", input: "sel", names: { image: "Picture" } },
      {
        id: "fil",
        type: "filter",
        input: "ren",
        expression: {
          kind: "call",
          fn: "not",
          args: [
            {
              kind: "call",
              fn: "is_null",
              args: [{ kind: "field", fieldId: "image" }],
            },
          ],
        },
      },
      {
        id: "rep",
        type: "replace",
        input: "fil",
        fieldId: "image",
        from: "https://img.test/a.png",
        to: "https://img.test/c.png",
      },
      {
        id: "dedup",
        type: "deduplicate",
        input: "rep",
        keys: ["id"],
        keep: "first",
      },
    ]);
    expect(roleOf(fields, "image")).toBe("image");
    expect(fields.find((f) => f.id === "id")).not.toHaveProperty("role");
  });

  it("keeps the role on both sides of a join, under the right prefix", () => {
    const fields = run([
      sourceNode,
      { id: "r", type: "source", datasetId: "src" },
      {
        id: "j",
        type: "join",
        left: "s",
        right: "r",
        keys: [{ left: "id", right: "id" }],
        mode: "left",
        cardinality: "one_to_one",
        rightPrefix: "r.",
      },
    ]);
    expect(roleOf(fields, "image")).toBe("image");
    expect(roleOf(fields, "r.image")).toBe("image");
    expect(fields.find((f) => f.id === "r.title")).not.toHaveProperty("role");
  });

  it("keeps the role on group keys and never puts one on aggregates", () => {
    const fields = run([
      sourceNode,
      {
        id: "g",
        type: "group",
        input: "s",
        keys: ["image"],
        aggregates: [
          { id: "latest", name: "Latest", op: "max", fieldId: "image" },
          { id: "total", name: "Total", op: "sum", fieldId: "views" },
        ],
      },
    ]);
    expect(roleOf(fields, "image")).toBe("image");
    expect(fields.find((f) => f.id === "latest")).not.toHaveProperty("role");
    expect(fields.find((f) => f.id === "total")).not.toHaveProperty("role");
  });

  it("drops the role on a cast field and never gives a calculated field one", () => {
    const cast = run([
      sourceNode,
      {
        id: "c",
        type: "cast",
        input: "s",
        fieldId: "image",
        to: "string",
        onError: "reject",
      },
    ]);
    expect(cast.find((f) => f.id === "image")).not.toHaveProperty("role");
    const calculated = run([
      sourceNode,
      {
        id: "k",
        type: "calculate",
        input: "s",
        fieldId: "copy",
        name: "Copy",
        expression: { kind: "field", fieldId: "image" },
      },
    ]);
    expect(roleOf(calculated, "image")).toBe("image");
    expect(calculated.find((f) => f.id === "copy")).not.toHaveProperty("role");
  });

  it("keeps an append's role only when every input agrees", () => {
    const mixed = run(
      [
        { id: "a", type: "source", datasetId: "a" },
        { id: "b", type: "source", datasetId: "b" },
        { id: "app", type: "append", inputs: ["a", "b"] },
      ],
      { a: source, b: plain },
    );
    expect(mixed.find((f) => f.id === "image")).not.toHaveProperty("role");
    const reversed = run(
      [
        { id: "a", type: "source", datasetId: "a" },
        { id: "b", type: "source", datasetId: "b" },
        { id: "app", type: "append", inputs: ["b", "a"] },
      ],
      { a: source, b: plain },
    );
    expect(reversed.find((f) => f.id === "image")).not.toHaveProperty("role");
    const agreeing = run(
      [
        { id: "a", type: "source", datasetId: "a" },
        { id: "b", type: "source", datasetId: "b" },
        { id: "app", type: "append", inputs: ["a", "b"] },
      ],
      { a: source, b: source },
    );
    expect(roleOf(agreeing, "image")).toBe("image");
    // An input without the column does not disagree.
    const partial = run(
      [
        { id: "a", type: "source", datasetId: "a" },
        { id: "b", type: "source", datasetId: "b" },
        { id: "sel", type: "select", input: "b", fields: ["id", "title"] },
        { id: "app", type: "append", inputs: ["a", "sel"] },
      ],
      { a: source, b: plain },
    );
    expect(roleOf(partial, "image")).toBe("image");
    const mapped = run(
      [
        { id: "a", type: "source", datasetId: "a" },
        { id: "b", type: "source", datasetId: "b" },
        {
          id: "app",
          type: "append",
          inputs: ["a", "b"],
          columnMappings: {
            a: { id: "id", image: "picture" },
            b: { id: "id", image: "picture" },
          },
        },
      ],
      { a: source, b: source },
    );
    expect(roleOf(mapped, "picture")).toBe("image");
  });
});
