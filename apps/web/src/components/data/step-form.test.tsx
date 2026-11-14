import { describe, expect, it } from "vitest";
import type { DataField, PreparationNode } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import { StepForm } from "./step-form";

const fields: DataField[] = [
  { id: "country", name: "Country", type: "string", nullable: true },
  { id: "revenue", name: "Revenue", type: "decimal", nullable: true },
];

function render(initial?: PreparationNode, locale: "en" | "de" = "en") {
  return renderI18n(
    <StepForm
      workspaceId="w"
      input="src"
      fields={fields}
      sources={[]}
      busy={false}
      initial={initial}
      onApply={async () => undefined}
      onCancel={() => undefined}
    />,
    locale,
  );
}

describe("step form expressions", () => {
  it("opens a filter step visually", () => {
    const html = render({
      id: "f",
      type: "filter",
      input: "src",
      expression: {
        kind: "call",
        fn: "gt",
        args: [
          { kind: "field", fieldId: "revenue" },
          { kind: "literal", type: "integer", value: 0 },
        ],
      },
    });
    expect(html).toContain('aria-label="Condition 1"');
    expect(html).toMatch(
      /<input id="[^"]+" type="text" inputMode="numeric" value="0"/,
    );
    expect(html).not.toContain("<textarea");
  });

  it("opens a calculate step with an if as rows", () => {
    const html = render(
      {
        id: "c",
        type: "calculate",
        input: "src",
        fieldId: "x",
        name: "German",
        expression: {
          kind: "call",
          fn: "if",
          args: [
            {
              kind: "call",
              fn: "eq",
              args: [
                { kind: "field", fieldId: "country" },
                { kind: "literal", type: "string", value: "DE" },
              ],
            },
            { kind: "field", fieldId: "revenue" },
            { kind: "literal", type: "decimal", value: "0" },
          ],
        },
      },
      "de",
    );
    expect(html).toContain('aria-label="Bedingung 1"');
    expect(html).toContain('aria-label="Dann"');
    expect(html).not.toContain("<textarea");
  });

  it("new calculate step starts with an empty visual value", () => {
    const html = render();
    expect(html).toContain('<option value="value" selected="">Value</option>');
    expect(html).not.toContain("<textarea");
  });

  it("opens an out-of-subset formula in formula view with the note", () => {
    const html = render({
      id: "f",
      type: "filter",
      input: "src",
      expression: {
        kind: "call",
        fn: "eq",
        args: [
          {
            kind: "call",
            fn: "lower",
            args: [{ kind: "field", fieldId: "country" }],
          },
          { kind: "literal", type: "string", value: "de" },
        ],
      },
    });
    expect(html).toContain("<textarea");
    expect(html).toContain("Edit it as a formula.");
  });
});
