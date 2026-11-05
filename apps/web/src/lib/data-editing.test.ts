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
});
