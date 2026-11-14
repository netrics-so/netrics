import { describe, expect, it } from "vitest";
import type { PreparationGraph } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import { preparationStepStates } from "@/lib/preparation-editing";
import { PreparationStepList } from "./preparation-step-list";

const graph: PreparationGraph = {
  version: 1,
  nodes: [
    { id: "a", type: "source", datasetId: "s1" },
    {
      id: "b",
      type: "calculate",
      input: "a",
      fieldId: "x",
      name: "X",
      expression: { kind: "literal", type: "integer", value: 1 },
    },
    {
      id: "c",
      type: "filter",
      input: "b",
      expression: { kind: "literal", type: "boolean", value: true },
    },
    { id: "d", type: "source", datasetId: "s2" },
    {
      id: "e",
      type: "join",
      left: "c",
      right: "d",
      keys: [{ left: "x", right: "x" }],
      mode: "left",
      cardinality: "many_to_one",
      rightPrefix: "r.",
    },
    { id: "f", type: "select", input: "d", fields: ["x"] },
  ],
  outputs: ["e", "f"],
};

describe("preparation step list", () => {
  it.each([
    [
      "en",
      "Failed",
      "This step failed. A referenced column is unavailable.",
      "Column: Net",
      "Affected",
    ],
    [
      "de",
      "Fehlgeschlagen",
      "Dieser Schritt ist fehlgeschlagen.",
      "Spalte: Net",
      "Betroffen",
    ],
  ] as const)(
    "shows the failure on its step and marks later steps (%s)",
    (locale, failed, message, column, affected) => {
      const html = renderI18n(
        <PreparationStepList
          nodes={graph.nodes}
          selected="a"
          states={preparationStepStates(graph, "b")}
          failure={{
            message:
              locale === "en" ? "A referenced column is unavailable." : "x",
            column: "Net",
          }}
          label={(node) => ({ title: node.id })}
          disabled={false}
          onSelect={() => {}}
        />,
        locale,
      );
      expect(html).toContain('data-state="failed"');
      expect(html).toContain(failed);
      expect(html).toContain(message);
      expect(html).toContain(column);
      expect(html.match(/data-state="affected"/g)).toHaveLength(2);
      expect(html).toContain(affected);
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*<span>a</); // earlier steps stay usable
      // Each marked step's button is described by its note.
      for (const id of ["b", "c", "e"]) {
        const note = html.match(
          new RegExp(
            `<button[^>]*aria-describedby="([^"]+)"[^>]*><span>${id}<`,
          ),
        )?.[1];
        expect(note).toBeTruthy();
        expect(html).toContain(`<p id="${note}"`);
      }
      expect(html).not.toMatch(/aria-describedby="[^"]*"[^>]*><span>a</);
    },
  );
});
