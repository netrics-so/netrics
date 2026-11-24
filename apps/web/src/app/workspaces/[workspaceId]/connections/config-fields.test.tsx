import { describe, expect, it } from "vitest";

import { ConfigFields } from "./config-fields";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
} from "@/lib/config-schema";
import { renderI18n } from "@/lib/i18n/test-render";

// A list of entries in a connector's configuration (#874): the HTTP check
// connector's checks, one fieldset each, kept as JSON in the form state.

const schema = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      title: "Checks",
      description: "URLs to request.",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          method: { type: "string", enum: ["GET", "HEAD"], default: "GET" },
          timeoutSeconds: { type: "integer", title: "Time limit", default: 10 },
          headers: { type: "string", title: "Headers", format: "multiline" },
        },
        required: ["name"],
      },
    },
  },
  required: ["checks"],
};

const fields = parseConfigSchema(schema);

describe("config lists (#874)", () => {
  it("starts a required list with one entry of defaults", () => {
    const values = initialConfigValues(fields);
    expect(JSON.parse(values.checks!)).toEqual([
      { method: "GET", timeoutSeconds: "10" },
    ]);
  });

  it("prefills the entries of an existing config", () => {
    const values = initialConfigValues(fields, {
      checks: [{ name: "Site", timeoutSeconds: 3 }],
    });
    expect(JSON.parse(values.checks!)).toEqual([
      { name: "Site", method: "GET", timeoutSeconds: "3" },
    ]);
  });

  it("coerces every entry: numbers parsed, empty values left out", () => {
    const config = coerceConfigValues(fields, {
      checks: JSON.stringify([
        { name: "Site", method: "HEAD", timeoutSeconds: "5", headers: "" },
        { name: "Api", method: "", timeoutSeconds: "" },
      ]),
    });
    expect(config).toEqual({
      checks: [
        { name: "Site", method: "HEAD", timeoutSeconds: 5 },
        { name: "Api" },
      ],
    });
    expect(coerceConfigValues(fields, { checks: "not json" })).toEqual({
      checks: [],
    });
  });

  it.each(["en", "de"] as const)(
    "renders an entry's fields and the add button (%s)",
    (locale) => {
      const html = renderI18n(
        <ConfigFields
          fields={fields}
          values={initialConfigValues(fields)}
          onChange={() => {}}
        />,
        locale,
      );
      expect(html).toContain('id="config-checks-0-name"');
      expect(html).toContain('id="config-checks-0-method"');
      expect(html).toMatch(/<textarea[^>]*id="config-checks-0-headers"/);
      expect(html).toContain(
        locale === "de" ? "Eintrag hinzufügen" : "Add an entry",
      );
      expect(html).toContain(
        locale === "de" ? "Höchstens 2 Einträge." : "At most 2 entries.",
      );
      // One entry of a list that needs one: nothing to remove.
      expect(html).not.toContain(locale === "de" ? "entfernen" : "Remove");
    },
  );

  it("offers removing entries above the minimum and stops adding at the maximum", () => {
    const html = renderI18n(
      <ConfigFields
        fields={fields}
        values={{ checks: JSON.stringify([{ name: "a" }, { name: "b" }]) }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Remove entry 1");
    expect(html).toContain("Remove entry 2");
    expect(html).not.toContain("Add an entry");
  });
});
