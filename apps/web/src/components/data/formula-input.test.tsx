import { describe, expect, it } from "vitest";
import { formulaCompletions, type DataField } from "@netrics/domain";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  FormulaInput,
  formulaKeyAction,
  opensByItself,
  type FormulaKey,
} from "./formula-input";

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

describe("formula input keys", () => {
  const key = (name: string, extra: Partial<FormulaKey> = {}): FormulaKey => ({
    key: name,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...extra,
  });

  it("opens by itself for names, not for operators", () => {
    const opens = (text: string) =>
      opensByItself(formulaCompletions(text, text.length, fields), text.length);
    expect(opens("[Rev")).toBe(true);
    expect(opens("ROU")).toBe(true);
    // Tab and Enter after an operand keep their meaning.
    expect(opens("[Revenue] ")).toBe(false);
    expect(opens("[Revenue] + ")).toBe(false);
  });

  it("accepts only on plain Enter or Tab", () => {
    expect(formulaKeyAction(key("Enter"), true)).toBe("accept");
    expect(formulaKeyAction(key("Tab"), true)).toBe("accept");
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"])
      for (const name of ["Enter", "Tab"])
        expect(
          formulaKeyAction(key(name, { [modifier]: true }), true),
          `${modifier} ${name}`,
        ).toBeNull();
    expect(formulaKeyAction(key("Enter"), false)).toBeNull();
    expect(formulaKeyAction(key("ArrowDown"), true)).toBe("next");
    expect(formulaKeyAction(key("ArrowUp"), true)).toBe("previous");
    expect(formulaKeyAction(key("Escape"), true)).toBe("close");
    expect(formulaKeyAction(key(" ", { ctrlKey: true }), false)).toBe("open");
  });

  it("ignores keys while an input method composes", () => {
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(formulaKeyAction(key("Enter", extra), true)).toBeNull();
      expect(formulaKeyAction(key("ArrowDown", extra), true)).toBeNull();
      expect(
        formulaKeyAction(key(" ", { ctrlKey: true, ...extra }), false),
      ).toBeNull();
    }
  });
});
