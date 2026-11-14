import { describe, expect, it } from "vitest";
import type { DataField } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import { FormulaInput } from "./formula-input";

const fields: DataField[] = [
  { id: "revenue", name: "Revenue", type: "decimal", nullable: true },
];

function render(value: string, locale: "en" | "de" = "en") {
  return renderI18n(
    <FormulaInput
      id="f"
      value={value}
      fields={fields}
      onChange={() => undefined}
    />,
    locale,
  );
}

describe("formula input", () => {
  it("renders combobox semantics", () => {
    const html = render("[Rev");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="f-suggestions"');
  });

  it("renders the argument hint in German", () => {
    const html = render("ROUND([Revenue], ", "de");
    expect(html).toContain("ROUND(Zahl, <strong>Nachkommastellen</strong>)");
  });

  it("renders no hint outside a function call", () => {
    expect(render("[Revenue] * 2")).not.toContain("<strong>");
  });
});
