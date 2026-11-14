import { describe, expect, it } from "vitest";
import type { DataExpression, DataField } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import { ExpressionEditor } from "./expression-editor";

const fields: DataField[] = [
  { id: "country", name: "Country", type: "string", nullable: true },
  { id: "amount", name: "Amount", type: "decimal", nullable: true },
  { id: "day", name: "Day", type: "date", nullable: true },
  { id: "paid", name: "Paid", type: "boolean", nullable: true },
  { id: "n", name: "N", type: "number", nullable: true },
];
const field = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const call = (
  fn: Extract<DataExpression, { kind: "call" }>["fn"],
  ...args: DataExpression[]
): DataExpression => ({ kind: "call", fn, args });
const literal = (
  type: Extract<DataExpression, { kind: "literal" }>["type"],
  value: unknown,
): DataExpression => ({ kind: "literal", type, value });

function render(
  initial: DataExpression | undefined,
  locale: "en" | "de" = "en",
  target: "condition" | "calculation" = "condition",
) {
  return renderI18n(
    <ExpressionEditor
      label="Keep rows where"
      target={target}
      fields={fields}
      initial={initial}
      draft={undefined}
      onDraftChange={() => undefined}
    />,
    locale,
  );
}

/** The markup of each element with the given role and accessible label. */
function groups(html: string, label: RegExp) {
  return html.split('role="group"').filter((part) => label.test(part));
}

describe("expression editor", () => {
  it("renders a stored condition as rows", () => {
    const html = render(
      call(
        "and",
        call("eq", field("country"), literal("string", "DE")),
        call("gt", field("amount"), literal("integer", 0)),
      ),
    );
    expect(groups(html, /^ aria-label="Condition \d"/)).toHaveLength(2);
    expect(groups(html, /^ aria-label="Condition 2"/)[0]).toContain(
      'value="0"',
    );
    expect(html).toContain('<option value="eq" selected="">is</option>');
    expect(html).toContain(
      '<option value="gt" selected="">is greater than</option>',
    );
    expect(html).toContain('value="DE"');
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain("<textarea");
  });

  it("offers only checker-approved operators", () => {
    const html = render(
      call("gte", field("day"), literal("date", "2026-01-31")),
    );
    const row = groups(html, /^ aria-label="Condition 1"/)[0]!;
    expect(row).toContain("is at least");
    expect(row).not.toContain(">contains<");
    expect(row).not.toContain(">starts with<");
  });

  it("renders a missing column row", () => {
    const stored = call("eq", field("gone"), literal("string", "x"));
    expect(render(stored)).toContain("Missing column gone");
    expect(render(stored, "de")).toContain("Fehlende Spalte gone");
  });

  it("opens nesting in formula view with a note", () => {
    const html = render(
      call("eq", call("lower", field("country")), literal("string", "de")),
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("Edit it as a formula.");
    expect(html).toContain("LOWER([Country])");
  });

  it("renders German labels", () => {
    const html = render(
      call("eq", field("country"), literal("string", "DE")),
      "de",
    );
    expect(html).toContain('aria-label="Bedingung 1"');
    expect(html).toContain("Alle treffen zu");
    expect(html).toContain("Visuell");
    expect(html).toContain(">ist</option>");
  });

  it("renders date and boolean literal inputs", () => {
    const html = render(
      call(
        "or",
        call("gte", field("day"), literal("date", "2026-01-31")),
        call("eq", field("paid"), literal("boolean", true)),
      ),
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-01-31"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('<option value="or" selected="">');
  });

  it("shows a German decimal and a timestamp in UTC", () => {
    const html = render(
      call(
        "and",
        call("gt", field("amount"), literal("decimal", "1.50")),
        call("in", field("country"), literal("json", ["DE", "AT"])),
      ),
      "de",
    );
    expect(html).toContain('value="1,50"');
    expect(html).toContain('value="DE"');
    expect(html).toContain('value="AT"');
    expect(html).toContain("Wert hinzufügen");
  });

  it("renders a calculation with an if as rows", () => {
    const html = render(
      call(
        "if",
        call("eq", field("country"), literal("string", "DE")),
        field("amount"),
        literal("decimal", "0"),
      ),
      "en",
      "calculation",
    );
    expect(html).toContain(
      '<option value="if" selected="">If … then … otherwise</option>',
    );
    expect(html).toContain('aria-label="Condition 1"');
    expect(html).toContain('aria-label="Then"');
    expect(html).toContain('aria-label="Otherwise"');
  });

  it("marks the row of a step error's column", () => {
    const html = renderI18n(
      <ExpressionEditor
        label="Keep rows where"
        target="condition"
        fields={fields}
        initial={call("eq", field("country"), literal("string", "DE"))}
        draft={undefined}
        onDraftChange={() => undefined}
        problem={{ code: "expression_field_not_found", fieldId: "country" }}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
  });

  it("shows stored values whose literal type differs from the column", () => {
    const valueOf = (html: string) =>
      /aria-label="Condition 1"[\s\S]*?<label for="([^"]+)">Value to compare<\/label>[\s\S]*?<input id="\1"[^>]*value="([^"]*)"/.exec(
        html,
      )?.[2];
    const vergleichswert = (html: string) =>
      /<label for="([^"]+)">Vergleichswert<\/label>[\s\S]*?<input id="\1"[^>]*value="([^"]*)"/.exec(
        html,
      )?.[2];
    expect(
      valueOf(render(call("gt", field("amount"), literal("integer", 0)))),
    ).toBe("0");
    expect(valueOf(render(call("gt", field("n"), literal("integer", 2))))).toBe(
      "2",
    );
    expect(
      valueOf(render(call("gt", field("n"), literal("number", 0.5)))),
    ).toBe("0.5");
    expect(
      vergleichswert(
        render(call("gt", field("n"), literal("number", 0.5)), "de"),
      ),
    ).toBe("0,5");
  });

  it("names value inputs and list items distinctly", () => {
    const html = render(
      call("in", field("country"), literal("json", ["DE", "x"])),
    );
    expect(html).toContain('aria-label="Remove value 1"');
    expect(html).toContain('aria-label="Remove value 2"');
    expect(html).not.toMatch(/<fieldset[^>]*aria-invalid/);
    const calc = render(
      call("add", field("amount"), literal("decimal", "1")),
      "en",
      "calculation",
    );
    expect(calc).toContain(">Source</label>");
    expect(calc).toContain('aria-label="Second value"');
    expect(calc).not.toContain('aria-label="plus"');
    expect(calc).toContain(">Fixed value</label>");
  });
});
