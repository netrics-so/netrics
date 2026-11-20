import { describe, expect, it } from "vitest";

import {
  PlaceholderSyntaxError,
  parsePlaceholders,
  renderTemplate,
} from "./placeholders.js";

describe("parsePlaceholders", () => {
  it("finds placeholders with trimmed names", () =>
    expect(
      parsePlaceholders("/a/{{ account_id }}/b?x={{window.start}}").map(
        (p) => p.name,
      ),
    ).toEqual(["account_id", "window.start"]));

  it("reports positions covering the braces", () => {
    const template = "x{{ a }}y";
    const [ref] = parsePlaceholders(template);
    expect(ref).toEqual({ name: "a", start: 1, end: 8 });
    expect(template.slice(ref!.start, ref!.end)).toBe("{{ a }}");
  });

  it("accepts every reserved name and no placeholder at all", () => {
    expect(
      parsePlaceholders(
        "{{window.start}}{{window.end}}{{page.number}}{{page.offset}}{{page.size}}{{page.cursor}}",
      ),
    ).toHaveLength(6);
    expect(parsePlaceholders("/plain/{path}/}}")).toEqual([]);
  });

  it.each([
    "{{",
    "{{}}",
    "{{ a b }}",
    "{{A}}",
    "{{window.middle}}",
    "{{a.b}}",
    "{{{a}}}",
    "{{1a}}",
    "x{{a}",
  ])("rejects %s", (t) =>
    expect(() => parsePlaceholders(t)).toThrow(PlaceholderSyntaxError),
  );
});

describe("renderTemplate", () => {
  it("encodes each value at its position", () =>
    expect(
      renderTemplate("/a/{{id}}", { id: "x/y z" }, encodeURIComponent),
    ).toBe("/a/x%2Fy%20z"));

  it("renders several placeholders and keeps the text between them", () =>
    expect(
      renderTemplate(
        "{{ a }}-{{page.number}}!",
        { a: "1", "page.number": "2" },
        (v) => v,
      ),
    ).toBe("1-2!"));

  it("does not re-expand placeholders inside values", () =>
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "no" }, (v) => v)).toBe(
      "{{b}}",
    ));

  it("names the missing placeholder, never a value", () => {
    try {
      renderTemplate(
        "/{{account_id}}/{{token}}",
        { account_id: "sk_live_abcdef" },
        (v) => v,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PlaceholderSyntaxError);
      expect((error as Error).message).toContain("token");
      expect((error as Error).message).not.toContain("sk_live_abcdef");
    }
  });

  it("ignores inherited properties of the value map", () =>
    expect(() => renderTemplate("{{constructor}}", {}, (v) => v)).toThrow(
      PlaceholderSyntaxError,
    ));
});
