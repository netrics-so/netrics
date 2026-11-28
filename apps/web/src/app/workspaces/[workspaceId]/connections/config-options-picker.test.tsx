import { describe, expect, it } from "vitest";

import {
  ConfigOptionsPicker,
  pickedValue,
  togglePicked,
} from "./config-options-picker";
import { parseConfigSchema } from "@/lib/config-schema";
import { renderI18n } from "@/lib/i18n/test-render";

// A config field chosen from lists per resource (#891), such as PostHog's
// saved insights: at most `maxSelected` in all, nothing chosen at first,
// and a stored value kept until a list is loaded. The lists themselves are
// driven in e2e/posthog-insight-picker-journey.spec.ts.

const [field] = parseConfigSchema({
  type: "object",
  properties: {
    insights: {
      type: "string",
      title: "Saved insights",
      description: "Saved trends insights.",
    },
  },
});

const noLoad = () => Promise.reject(new Error("not listed in this test"));

describe("config options picker (#891)", () => {
  it("toggles choices up to the limit, and writes them separated by spaces", () => {
    let picked = togglePicked(new Map(), "1000/a", "1000", 2);
    picked = togglePicked(picked, "1001/b", "1001", 2);
    expect(pickedValue(picked)).toBe("1000/a 1001/b");
    // A third is not added; the same map comes back.
    expect(togglePicked(picked, "1000/c", "1000", 2)).toBe(picked);
    // Clearing one makes room again.
    picked = togglePicked(picked, "1000/a", "1000", 2);
    expect(pickedValue(picked)).toBe("1001/b");
    expect(pickedValue(togglePicked(picked, "1000/c", "1000", 2))).toBe(
      "1001/b 1000/c",
    );
  });

  it.each(["en", "de"] as const)(
    "offers each resource's list, with nothing chosen (%s)",
    (locale) => {
      const html = renderI18n(
        <ConfigOptionsPicker
          field={field!}
          maxSelected={20}
          resources={[
            { id: "1000", name: "Site" },
            { id: "1001", name: "App" },
          ]}
          value=""
          onChange={() => {}}
          load={noLoad}
        />,
        locale,
      );
      expect(html).toContain("<legend>");
      expect(html).toContain(
        locale === "de" ? "In Site auswählen" : "Choose in Site",
      );
      expect(html).toContain(
        locale === "de" ? "In App auswählen" : "Choose in App",
      );
      expect(html).toContain(
        locale === "de" ? "Wähle höchstens 20." : "Choose at most 20.",
      );
      expect(html).toContain(
        locale === "de" ? "Nichts ist ausgewählt." : "Nothing is chosen.",
      );
      // No list is open, so no choice is offered yet.
      expect(html).not.toContain('type="checkbox"');
    },
  );

  it("keeps a stored value until a list is loaded, and lists resources on request", () => {
    const html = renderI18n(
      <ConfigOptionsPicker
        field={field!}
        maxSelected={20}
        resources={null}
        loadResources={() => Promise.resolve([])}
        value="https://us.posthog.com/project/1000/insights/AbCd1234"
        onChange={() => {}}
        load={noLoad}
      />,
    );
    expect(html).toContain(
      "The current choice stays as it is until you change it in a list below.",
    );
    expect(html).toContain("Show the lists");
  });
});
