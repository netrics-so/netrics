import { describe, expect, it } from "vitest";
import { dataErrorCodeKey } from "./data-errors";
import { parseEnteredTable, enteredValue, preparationAt } from "./data-editing";
import type { PreparationGraph } from "@netrics/domain";
describe("entered reference data", () => {
  it("preserves leading zeroes and exact decimals while reading quoted CSV", () => {
    const table = parseEnteredTable(
      'id,name,amount\r\n001,"An app, named A",12345678901234567890.12\r\n002,"A ""quoted"" name",0.10\r\n',
    );
    expect(table.rows).toEqual([
      ["001", "An app, named A", "12345678901234567890.12"],
      ["002", 'A "quoted" name', "0.10"],
    ]);
    expect(table.fields.every((f) => f.type === "string")).toBe(true);
    expect(enteredValue("decimal", table.rows[0]![2]!, false)).toBe(
      "12345678901234567890.12",
    );
  });
  it("accepts pasted tabular data and quoted newlines without losing columns", () => {
    expect(parseEnteredTable('id\tname\n1\t"A\nB"').rows).toEqual([
      ["1", "A\nB"],
    ]);
    expect(parseEnteredTable("\uFEFFid;name\n1;App").rows).toEqual([
      ["1", "App"],
    ]);
  });
  it("rejects malformed, ambiguous and incomplete tables", () => {
    for (const input of [
      "",
      "id,name",
      "id,id\n1,2",
      "id,name\n1",
      'id,name\n1,"unterminated',
      'id,name\n1,"quoted"trailing',
      "id,ID \n1,2",
    ])
      expect(() => parseEnteredTable(input)).toThrow("table_invalid");
  });
  it("detects delimiters outside quoted column names", () => {
    expect(parseEnteredTable('id;"App, name"\n1;A').fields[1]?.name).toBe(
      "App, name",
    );
  });
  it("keeps empty, false, zero and unsafe integers distinct", () => {
    expect(enteredValue("boolean", "false", false)).toBe(false);
    expect(enteredValue("integer", "0", false)).toBe(0);
    expect(enteredValue("decimal", "", true)).toBeNull();
    expect(() => enteredValue("integer", "9007199254740993", false)).toThrow();
    expect(() => enteredValue("number", "", false)).toThrow();
  });
});
it("previews a step without executing broken downstream or unrelated nodes", () => {
  const graph: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "source", type: "source", datasetId: "sales" },
      { id: "first", type: "select", input: "source", fields: ["amount"] },
      { id: "unrelated", type: "source", datasetId: "unavailable" },
      { id: "broken", type: "select", input: "first", fields: ["missing"] },
    ],
    outputs: ["broken"],
  };
  expect(preparationAt(graph, "first")).toEqual({
    version: 1,
    nodes: graph.nodes.slice(0, 2),
    outputs: ["first"],
  });
});

it("distinguishes a first import from unpublished definitions and unavailable retained history", () => {
  expect(dataErrorCodeKey("data_source_pending")).toBe("pending");
  expect(dataErrorCodeKey("data_source_not_published")).toBe("unpublished");
  expect(dataErrorCodeKey("data_source_history_unavailable")).toBe("expired");
  expect(dataErrorCodeKey("data_dependency_version_conflict")).toBe(
    "pinConflict",
  );
  expect(dataErrorCodeKey("data_source_not_found")).toBe("unavailable");
});

it("round-trips reference cells without losing null, empty text, quotes, false or exact decimals", async () => {
  const { referenceCellText, referenceCellValue, referenceRecordPages } =
    await import("./data-editing");
  for (const [type, value] of [
    ["string", null],
    ["string", ""],
    ["string", '"quoted"'],
    ["string", "001"],
    ["decimal", "12345678901234567890.1200"],
    ["boolean", false],
    ["integer", 0],
    ["json", { empty: "", enabled: false }],
  ] as const) {
    expect(
      referenceCellValue(type, referenceCellText(type, value), true),
    ).toEqual(value);
  }
  const records = Array.from({ length: 2501 }, (_, id) => ({
    values: { id: String(id) },
  }));
  const pages = [...referenceRecordPages(records)];
  expect(pages.map((page) => page.length)).toEqual([1000, 1000, 501]);
  expect(pages.flat()).toEqual(records);
  expect([...referenceRecordPages([])]).toEqual([[]]);
});

it("appends a step without changing public output identities or existing branch meaning", async () => {
  const { appendPreparation } = await import("./data-editing");
  const { executePreparation } = await import("@netrics/domain");
  const graph: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "source", type: "source", datasetId: "numbers" },
      {
        id: "output",
        type: "calculate",
        input: "source",
        fieldId: "twice",
        name: "Twice",
        expression: {
          kind: "call",
          fn: "multiply",
          args: [
            { kind: "field", fieldId: "value" },
            { kind: "literal", type: "decimal", value: "2" },
          ],
        },
      },
      { id: "side", type: "select", input: "output", fields: ["twice"] },
    ],
    outputs: ["output", "side"],
  };
  const next = appendPreparation(
    graph,
    [
      {
        id: "new",
        type: "calculate",
        input: "output",
        fieldId: "triple",
        name: "Triple",
        expression: {
          kind: "call",
          fn: "multiply",
          args: [
            { kind: "field", fieldId: "value" },
            { kind: "literal", type: "decimal", value: "3" },
          ],
        },
      },
    ],
    "output",
  );
  expect(next.outputs).toEqual(graph.outputs);
  expect(graph.nodes[1]!.id).toBe("output");
  const data = new Map([
    [
      "numbers",
      {
        fields: [
          {
            id: "value",
            name: "Value",
            type: "decimal" as const,
            nullable: false,
          },
        ],
        rows: [{ value: "1.10" }],
      },
    ],
  ]);
  const result = executePreparation(next, data);
  expect(result.outputs.output!.rows).toEqual([
    { value: "1.10", twice: "2.2", triple: "3.3" },
  ]);
  expect(result.outputs.side!.rows).toEqual([{ twice: "2.2" }]);
  expect(result.outputs.side!.fields.map((field) => field.id)).toEqual([
    "twice",
  ]);
  expect(() => appendPreparation(graph, [], "output")).toThrow(
    "preparation_output_invalid",
  );
});

it("keeps explicit append column mappings attached when preserving an existing public output", async () => {
  const { appendPreparation } = await import("./data-editing");
  const graph: PreparationGraph = {
    version: 1,
    nodes: [
      { id: "output", type: "source", datasetId: "one" },
      { id: "other", type: "source", datasetId: "two" },
      {
        id: "branch",
        type: "append",
        inputs: ["output", "other"],
        columnMappings: {
          output: { value: "aligned" },
          other: { alternate: "aligned" },
        },
      },
    ],
    outputs: ["output", "branch"],
  };
  const result = appendPreparation(
    graph,
    [{ id: "next", type: "select", input: "output", fields: ["value"] }],
    "output",
  );
  const branch = result.nodes.find((node) => node.id === "branch")!;
  if (branch.type !== "append") throw new Error("missing append");
  expect(branch.columnMappings?.[branch.inputs[0]!]).toEqual({
    value: "aligned",
  });
  expect(branch.columnMappings?.output).toBeUndefined();
  expect(result.outputs).toEqual(graph.outputs);
});
