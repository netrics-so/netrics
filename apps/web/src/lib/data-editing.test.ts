import { afterEach, describe, expect, it, vi } from "vitest";
import { dataErrorCodeKey } from "./data-errors";
import {
  dataErrorKey,
  dataErrorLocation,
  parseEnteredTable,
  enteredValue,
  graphSources,
  hasUnpublishedChanges,
  preparationAt,
} from "./data-editing";
import { previewPreparation } from "./data-api";
import { DataProcessingError, type PreparationGraph } from "@netrics/domain";
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
describe("data error location", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the failing step and column from API and engine errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "expression_field_not_found",
            fieldId: "missing",
            nodeId: "calc",
          },
          { status: 400 },
        ),
      ),
    );
    const failure = await previewPreparation("w", {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: "s" }],
      outputs: ["source"],
    }).catch((error: unknown) => error);
    expect(dataErrorLocation(failure)).toEqual({
      nodeId: "calc",
      fieldId: "missing",
    });
    expect(dataErrorKey(failure)).toBe("field");
    expect(dataErrorLocation(new DataProcessingError("x", "f", "n"))).toEqual({
      nodeId: "n",
      fieldId: "f",
    });
    expect(dataErrorLocation(new Error("x"))).toEqual({});
  });
});

describe("unpublished changes (#632)", () => {
  const published = { version: 3, publishedVersion: 3, published: "A" };
  it("compares the shown definition with the published one", () => {
    expect(
      hasUnpublishedChanges({ ...published, current: "B", dirty: true }),
    ).toBe(true);
    // Undone back to the published definition: no mark, though the editor
    // still differs from what it last saved.
    expect(
      hasUnpublishedChanges({
        ...published,
        version: 4,
        current: "A",
        dirty: true,
      }),
    ).toBe(false);
  });
  it("counts a saved draft ahead of an unknown release, and unsaved edits", () => {
    const unknown = { version: 4, publishedVersion: 3, published: undefined };
    expect(
      hasUnpublishedChanges({ ...unknown, current: "A", dirty: false }),
    ).toBe(true);
    expect(
      hasUnpublishedChanges({
        ...unknown,
        version: 3,
        current: "A",
        dirty: true,
      }),
    ).toBe(true);
  });
  it("takes the server's word on the saved draft without unsaved edits (#697)", () => {
    const known = {
      version: 4,
      publishedVersion: 3,
      published: "A",
      current: "A",
      dirty: false,
    };
    // Same definition, but an input it pins was published again.
    expect(
      hasUnpublishedChanges({
        ...known,
        savedDiffers: true,
        inputsDiffer: true,
      }),
    ).toBe(true);
    expect(
      hasUnpublishedChanges({
        ...known,
        savedDiffers: false,
        inputsDiffer: false,
      }),
    ).toBe(false);
  });
  it("keeps differing inputs through unsaved edits, also undone ones (#697)", () => {
    // Published as "A"; an input was published again since.
    const republished = {
      version: 3,
      publishedVersion: 3,
      savedDiffers: true,
      inputsDiffer: true,
      saved: "A",
      published: "A",
      dirty: true,
    };
    // A name-only edit: same definition.
    expect(hasUnpublishedChanges({ ...republished, current: "A" })).toBe(true);
    // A definition edit saved, then undone back to the published one.
    expect(
      hasUnpublishedChanges({
        ...republished,
        version: 4,
        saved: "B",
        current: "A",
      }),
    ).toBe(true);
    // Without an input difference, undoing back to it clears the mark.
    expect(
      hasUnpublishedChanges({
        ...republished,
        inputsDiffer: false,
        version: 4,
        saved: "B",
        current: "A",
      }),
    ).toBe(false);
  });
  it("trusts differing inputs only while the sources are the saved ones (#697)", () => {
    // Published reading source A; switched to prepared source B and saved
    // (the inputs differ), then undone back to A without saving.
    const switched = {
      version: 4,
      publishedVersion: 3,
      savedDiffers: true,
      inputsDiffer: true,
      saved: "reads B",
      savedSources: graphSources({
        nodes: [{ id: "s", type: "source", datasetId: "prepared:b:out" }],
      }),
      published: "reads A",
      dirty: true,
    };
    const readsA = graphSources({
      nodes: [{ id: "s", type: "source", datasetId: "a" }],
    });
    expect(
      hasUnpublishedChanges({
        ...switched,
        current: "reads A",
        currentSources: readsA,
      }),
    ).toBe(false);
    // Still reading B, with another edit: the inputs still differ.
    expect(
      hasUnpublishedChanges({
        ...switched,
        current: "reads A",
        currentSources: switched.savedSources,
      }),
    ).toBe(true);
  });
  it("takes a saved draft the server confirms equal as the published one (#697)", () => {
    // Opened on a changed draft (published unknown), saved back to the
    // released content: the server says equal.
    const confirmed = {
      version: 5,
      publishedVersion: 3,
      savedDiffers: false,
      inputsDiffer: false,
      saved: "A",
      published: undefined,
      dirty: true,
    };
    // A name-only edit keeps the definition: unmarked.
    expect(hasUnpublishedChanges({ ...confirmed, current: "A" })).toBe(false);
    // A definition edit is marked.
    expect(hasUnpublishedChanges({ ...confirmed, current: "B" })).toBe(true);
  });
  it("never marks an item that was never published", () => {
    expect(
      hasUnpublishedChanges({
        version: 2,
        publishedVersion: null,
        published: undefined,
        current: "A",
        dirty: true,
      }),
    ).toBe(false);
  });
  it("counts a switch to other inputs when the server reports it (#697)", () => {
    // Published from a restore of v1; "Use latest published inputs" keeps
    // the definition. Only the server knows whether the inputs now differ.
    const adopted = {
      version: 3,
      publishedVersion: 2,
      published: "A",
      current: "A",
      saved: "A",
      dirty: false,
    };
    expect(
      hasUnpublishedChanges({
        ...adopted,
        savedDiffers: true,
        inputsDiffer: true,
      }),
    ).toBe(true);
    expect(
      hasUnpublishedChanges({
        ...adopted,
        savedDiffers: false,
        inputsDiffer: false,
      }),
    ).toBe(false);
  });
});
